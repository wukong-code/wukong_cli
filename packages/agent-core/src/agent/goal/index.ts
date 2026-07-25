import { randomUUID } from 'node:crypto';

import {
  canonicalDigest,
  canonicalJson,
  containsInlineSecret,
  BUILTIN_RISK_SCAN_POLICY_VERSION,
  FINISH_LINE_WARNING_POLICY_VERSION,
  FRESH_REVIEWER_POLICY_VERSION,
  GATE_GUARD_POLICY_VERSION,
  REVIEW_SUBJECT_POLICY_VERSION,
  validateVerificationCriteriaSelection,
  validateFrozenGatePlan,
  type BrokerReviewTrustBindingV1,
  type FinishLineReview,
  type GateApprovalBinding,
  type GatePlan,
  type ReviewSubjectConsentBindingV1,
  type ReviewPolicyBinding,
  type VerificationCriteriaRecipeV1,
  type VerificationCriteriaSelectionV1,
  type WorkspaceIdentity,
  type WorkspaceTrustBinding,
} from '@wukong/verification';
import { ErrorCodes, WukongError } from '#/errors';
import type { Agent } from '..';
import type { AgentRecordOf } from '../records/types';
import {
  type TelemetryProperties,
} from '../../telemetry';

/**
 * Durable goal-mode state owned by {@link GoalMode}.
 *
 * Each agent keeps exactly one current goal, rebuilt from that agent's ordered
 * record log.
 * It owns the lifecycle rules, budget math, and actor boundaries that the
 * slash command, model tools, and goal continuation driver depend on.
 */

/** Maximum objective length in characters. */
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

const GOAL_FORK_CLEARED_REMINDER = [
  'This fork does not have a current goal.',
  'Ignore earlier active-goal reminders from the source session.',
  'Handle requests normally unless the user starts a new goal.',
].join(' ');

/**
 * Lifecycle status of a goal — deliberately minimal. The durable record only
 * ever holds `active`, `paused`, or `blocked`; `complete` is transient
 * (announce-then-clear) and never rests on disk. There is exactly one running
 * state, two resumable "stopped" states, and one success outcome:
 *
 * | Status     | Persisted | Resumable | Set by                          | Meaning                                          |
 * |------------|-----------|-----------|---------------------------------|--------------------------------------------------|
 * | `active`   | yes       | (running) | createGoal / resumeGoal         | The goal driver may run continuation turns.      |
 * | `paused`   | yes       | yes       | pauseGoal / pauseActiveGoal /   | User, interrupt, resume, or retryable runtime    |
 * |            |           |           | pauseOnInterrupt /              | stop parked it; intact.                          |
 * |            |           |           | normalizeAfterReplay            |                                                  |
 * | `blocked`  | yes       | yes       | markBlocked                     | The system stopped it for some `reason`.         |
 * | `complete` | no        | —         | markComplete                    | Success — announced in a message, then cleared.  |
 *
 * Only an `active` goal advances: accounting and continuation turns all gate on
 * `status === 'active'`. `paused` and `blocked` are the same kind of
 * thing — "the driver is not running continuation turns, but the goal is intact
 * and resumable via `/goal resume`" — differing only in *who* stopped it (the
 * user vs the system) and the human-readable `reason`. There is no separate
 * `impossible`, `budget_limited`, `error`, or `cancelled` status: an
 * unachievable goal or an exhausted budget becomes `blocked(+reason)`,
 * runtime/model/provider failures become `paused(+reason)`, and `cancelGoal`
 * discards the record entirely. See {@link GoalMode}
 * for the setters and the per-status notes below.
 */
export type GoalStatus =
  /**
   * The goal is live and the goal driver may run continuation turns toward it.
   * Set on creation (`createGoal`) and when a paused/blocked goal is resumed
   * (`resumeGoal`). The only status under which turns/tokens/wall-clock are
   * accounted and continuation turns run.
   */
  | 'active'
  /**
   * The user stopped the goal but it is fully intact and resumable via
   * `/goal resume`. Reached three ways: the user pauses (`pauseGoal`); a live
   * turn is aborted mid-flight, e.g. Esc/shutdown (`pauseOnInterrupt`); or a
   * agent is resumed from disk, where an `active` goal cannot still be running
   * and is demoted (`normalizeAfterReplay`); or a runtime/model/provider failure
   * parked it via `pauseActiveGoal`.
   */
  | 'paused'
  /**
   * The *system* stopped pursuing the goal, for a reason carried in
   * `terminalReason`: the model reported it cannot proceed via
   * `UpdateGoal('blocked')` (an external blocker, or an objective it deems
   * unachievable); or a configured hard budget (token/turn/time) was reached.
   * Set by `markBlocked` from the model's `UpdateGoal`, the budget check in the
   * goal driver, and prompt-hook blocks.
   * Resumable like `paused` — `/goal resume` re-activates it; a plain message
   * just runs one normal turn without reactivating the loop. Editing the goal
   * while blocked takes effect on the next turn.
   */
  | 'blocked'
  /**
   * Success: the model reported the objective met via `UpdateGoal('complete')`.
   * Set by `markComplete`. This status is **transient**
   * — `markComplete` emits the completion event and then clears the durable
   * record, so the goal box disappears and `complete` never rests on disk.
   */
  | 'complete';

export type GoalStopCondition = 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';

/** Who performed a goal action. `cleared` is a record action, not a status. */
export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

export interface LoopResultCheck {
  readonly command: string;
  readonly status: 'passed' | 'failed' | 'timed_out';
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface LoopResultBlocker {
  readonly id: string;
  readonly kind: 'check' | 'risk' | 'workspace' | 'review';
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
  readonly command?: string;
  readonly evidence?: string;
  readonly nextAction: string;
}

export interface LoopResultFinding {
  readonly id: string;
  readonly severity: 'blocking' | 'important' | 'note';
  readonly category: 'correctness' | 'security' | 'test' | 'performance' | 'maintainability';
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
  readonly evidence: string;
  readonly nextAction: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly validationStatus: 'verified' | 'unverified' | 'failed';
  /** Acceptance criterion this finding blocks, when the reviewer can identify one. */
  readonly criterionId?: string;
}

export interface LoopAcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly source: 'objective' | 'completion_criterion' | 'constraint' | 'derived';
}

export interface LoopAcceptanceCriterionV3 {
  readonly id: string;
  readonly text: string;
  readonly evidenceExpectation?: string;
  readonly criterionProvenanceDigest: string;
  readonly source:
    | 'objective'
    | 'completion_criterion'
    | 'constraint'
    | 'derived'
    | 'verification_recipe';
  readonly provenance:
    | {
        readonly kind: 'v2-criterion';
        readonly v2CriterionId: string;
        readonly v2Source: LoopAcceptanceCriterion['source'];
      }
    | {
        readonly kind: 'verification-recipe';
        readonly recipeProvenanceDigest: string;
        readonly recipeCriterionId: string;
      };
}

export interface LoopVerificationStep {
  readonly id: string;
  readonly kind: 'project_check' | 'review';
  readonly description: string;
  readonly blocking: boolean;
}

/** Legacy immutable acceptance contract used by 0.0.18 and earlier sessions. */
export interface LoopContractV1 {
  readonly schemaVersion: 1;
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly acceptanceCriteria: readonly LoopAcceptanceCriterion[];
  readonly verificationPlan: readonly LoopVerificationStep[];
  readonly source: 'user' | 'planner' | 'fallback';
  readonly createdAt: number;
}

/** Frozen 0.0.19 Finish Line used by every run and reviewer cycle. */
export interface LoopContractV2 {
  readonly schemaVersion: 2;
  readonly contractId: string;
  readonly supersedesContractId?: string;
  readonly supersedesGoalId?: string;
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly finishLineReview: FinishLineReview;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly workspaceTrust?: WorkspaceTrustBinding;
  readonly gateApproval: GateApprovalBinding;
  readonly acceptanceCriteria: readonly LoopAcceptanceCriterion[];
  readonly verificationPlan: readonly LoopVerificationStep[];
  readonly gatePlan: GatePlan;
  readonly reviewPolicy: ReviewPolicyBinding;
  readonly source: 'user' | 'planner' | 'fallback';
  readonly createdAt: number;
}

export type WorkspaceTrustBindingV2 =
  | {
      readonly schemaVersion: 2;
      readonly workspaceIdentityDigest: string;
      readonly reviewSubjectPolicyVersion: string;
      readonly hasExecutableChecks: false;
      readonly scopes: readonly ['brokered-review-subject'];
    }
  | {
      readonly schemaVersion: 2;
      readonly workspaceIdentityDigest: string;
      readonly reviewSubjectPolicyVersion: string;
      readonly hasExecutableChecks: true;
      readonly scopes: readonly ['loop-project-checks', 'brokered-review-subject'];
    };

export interface GatePlanV2 {
  readonly schemaVersion: 2;
  readonly stopCondition: 'proof-pass';
  readonly legacySnapshot: GatePlan;
  readonly criteriaSelectionDigest: string;
  readonly criterionIds: readonly string[];
  readonly builtinScanPolicyVersion: string;
  readonly freshReviewerPolicyVersion: string;
  readonly reviewSubjectPolicyVersion: string;
  readonly planDigest: string;
}

export interface LoopContractV3 {
  readonly schemaVersion: 3;
  readonly contractId: string;
  readonly supersedesContractId?: string;
  readonly supersedesGoalId?: string;
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly finishLineReview: FinishLineReview;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly workspaceTrust: WorkspaceTrustBindingV2;
  readonly gateApproval: GateApprovalBinding;
  readonly acceptanceCriteria: readonly LoopAcceptanceCriterionV3[];
  readonly verificationPlan: readonly LoopVerificationStep[];
  readonly verificationCriteria: VerificationCriteriaSelectionV1;
  readonly gatePlan: GatePlanV2;
  readonly reviewPolicy: ReviewPolicyBinding;
  readonly source: 'user' | 'planner' | 'fallback';
  readonly createdAt: number;
}

export type LoopContract = LoopContractV1 | LoopContractV2 | LoopContractV3;

export interface LoopContractV2Input {
  readonly schemaVersion: 2;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly finishLineReview: FinishLineReview;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly workspaceTrust?: WorkspaceTrustBinding;
  readonly gateApproval: GateApprovalBinding;
  readonly gatePlan: GatePlan;
  readonly reviewPolicy: ReviewPolicyBinding;
  readonly source: 'user';
  readonly supersedesContractId?: string;
  readonly supersedesGoalId?: string;
  readonly reviewSettings?: LoopRunReviewSettingsInput;
}

export interface LoopContractV3Input {
  readonly schemaVersion: 3;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly finishLineReview: FinishLineReview;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly workspaceTrust: WorkspaceTrustBindingV2;
  readonly gateApproval: GateApprovalBinding;
  readonly legacyGatePlan: GatePlan;
  readonly reviewPolicy: ReviewPolicyBinding;
  readonly verificationCriteria: VerificationCriteriaSelectionV1;
  readonly selectedRecipes: readonly {
    readonly recipe: VerificationCriteriaRecipeV1;
    readonly provenanceDigest: string;
  }[];
  readonly reviewSettings: LoopRunReviewSettingsInput;
  readonly source: 'user';
  readonly supersedesContractId?: string;
  readonly supersedesGoalId?: string;
}

export interface LoopRunSettings {
  readonly writerModel?: string;
  readonly reviewerModel?: string;
  readonly permissionMode: 'manual' | 'auto' | 'yolo';
  readonly maxIterations: number;
  readonly minIntervalMs?: number;
}

export interface LoopRunReviewSettingsInput {
  readonly brokerReviewTrust: BrokerReviewTrustBindingV1;
  readonly reviewSubjectConsent: ReviewSubjectConsentBindingV1;
}

export interface LoopRunSettingsV2 {
  readonly schemaVersion: 2;
  readonly legacy: LoopRunSettings;
  readonly legacySettingsDigest: string;
  readonly brokerReviewTrust: BrokerReviewTrustBindingV1;
  readonly reviewSubjectConsent: ReviewSubjectConsentBindingV1;
  readonly settingsDigest: string;
}

export interface LoopRunCreatedV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly goalId: string;
  readonly contractId: string;
  readonly continuedFromRunId?: string;
  readonly carriedBlockerKeys: readonly string[];
  readonly runSettings: LoopRunSettings;
  readonly runDigest: string;
  readonly createdAt: number;
}

export interface LoopRunCreatedV2 {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly goalId: string;
  readonly contractId: string;
  readonly continuedFromRunId?: string;
  readonly carriedBlockerKeys: readonly string[];
  readonly runSettingsRef: string;
  readonly runSettings: LoopRunSettingsV2;
  readonly runDigest: string;
  readonly createdAt: number;
}

export type LoopRunCreated = LoopRunCreatedV1 | LoopRunCreatedV2;

export interface ContinuationPolicyV1 {
  readonly mode: 'same-contract' | 'restore-or-revise' | 'revised-loop' | 'blocked';
  readonly automaticRetry: false;
  readonly requiresPreflightRevalidation: true;
}

export interface LoopRunTerminalV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly contractId: string;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly continuationPolicy: ContinuationPolicyV1;
  readonly blockerKeys: readonly string[];
  readonly terminalAttemptId?: string;
  readonly attemptResultDigest?: string;
  readonly terminalDigest: string;
  readonly createdAt: number;
}

export interface LoopContinuationCreatedV1 {
  readonly schemaVersion: 1;
  readonly continuationId: string;
  readonly priorRunId: string;
  readonly nextRunId: string;
  readonly contractId: string;
  readonly carriedBlockerKeys: readonly string[];
  readonly continuationDigest: string;
  readonly createdAt: number;
}

export interface GateAttemptCreatedV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly sequence: number;
  readonly planDigest: string;
  readonly gateApprovalDigest: string;
  readonly workspaceBefore: string;
  readonly carriedBlockerSetDigest: string;
  readonly attemptDigest: string;
  readonly createdAt: number;
}

export interface GateCheckResultRecordedV1 {
  readonly schemaVersion: 1;
  readonly checkResultRef: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly checkId: string;
  readonly commandDigest: string;
  readonly definitionDigest?: string;
  readonly workspaceFingerprint: string;
  readonly status: 'passed' | 'failed' | 'unresolved' | 'unavailable' | 'blocked' | 'error';
  readonly exitCode?: number;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
  readonly redactionVersion: string;
  readonly checkResultDigest: string;
  readonly createdAt: number;
}

export interface BuiltinRiskScanResultRecordedV1 {
  readonly schemaVersion: 1;
  readonly scanResultRef: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly scanPolicyVersion: string;
  readonly workspaceFingerprint: string;
  readonly status: 'clean' | 'blocking' | 'error';
  readonly findings: readonly {
    readonly findingRef: string;
    readonly findingDigest: string;
    readonly severity: 'blocking' | 'important' | 'note';
  }[];
  readonly scanResultDigest: string;
  readonly createdAt: number;
}

export interface ReviewerResultRecordedV1 {
  readonly schemaVersion: 1;
  readonly reviewerResultRef: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly reviewerInputDigest: string;
  readonly reviewerPayloadDigest: string;
  readonly reviewerResultDigest: string;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'INCONCLUSIVE';
  readonly createdAt: number;
}

export interface ProofAggregateRecordedV1 {
  readonly schemaVersion: 1;
  readonly proofAggregateResultRef: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly orderedCheckResultDigests: readonly string[];
  readonly builtinRiskScanResultRef: string;
  readonly builtinRiskScanResultDigest: string;
  readonly builtinRiskScanPolicyVersion: string;
  readonly reviewerResultDigest: string;
  readonly carriedBlockerSetDigest: string;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly blockerKeys: readonly string[];
  readonly proofAggregateDigest: string;
  readonly createdAt: number;
}

export interface LoopEvidenceSnapshotCreatedV1 {
  readonly schemaVersion: 1;
  readonly evidenceSnapshotId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly gateApprovalDigest: string;
  readonly workspaceTrustGrantId?: string;
  readonly workspaceFingerprint: string;
  readonly orderedCheckResults: readonly {
    readonly checkId: string;
    readonly resultRef: string;
    readonly resultDigest: string;
    readonly status: GateCheckResultRecordedV1['status'];
  }[];
  readonly reviewerResultRef: string;
  readonly reviewerResultDigest: string;
  readonly builtinRiskScanResultRef: string;
  readonly builtinRiskScanResultDigest: string;
  readonly builtinRiskScanPolicyVersion: string;
  readonly proofAggregateResultRef: string;
  readonly proofAggregateDigest: string;
  readonly evidenceDigest: string;
  readonly createdAt: number;
}

export interface GateAttemptCompletedV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly gateApprovalDigest: string;
  readonly sequence: number;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly evidenceSnapshotId: string;
  readonly evidenceDigest: string;
  readonly resultDigest: string;
  readonly createdAt: number;
}

export interface LoopGateAttemptInput {
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly workspaceFingerprint: string;
  readonly checks: readonly {
    readonly command: string;
    readonly status: 'passed' | 'failed' | 'timed_out' | 'unavailable';
    readonly exitCode: number | null;
    readonly stdout?: string;
    readonly stderr?: string;
  }[];
  readonly scanFindings: readonly {
    readonly id: string;
    readonly severity: 'low' | 'medium' | 'high';
    readonly message: string;
    readonly file?: string;
    readonly line?: number;
  }[];
  readonly reviewerStatus: 'PASS' | 'NEEDS_WORK' | 'INCONCLUSIVE';
  readonly reviewerPayload: unknown;
  readonly blockerKeys: readonly string[];
  readonly workspaceTrustGrantId?: string;
}

export type PriorBlockerDispositionStatus = 'resolved' | 'still_open' | 'replaced_by';

export interface PriorBlockerDisposition {
  readonly key: string;
  readonly status: PriorBlockerDispositionStatus;
  readonly replacedBy?: string;
}

export interface LoopReviewBlocker {
  readonly key: string;
  readonly findingId: string;
  readonly criterionId?: string;
  readonly category: LoopResultFinding['category'] | 'check' | 'workspace';
  readonly file?: string;
  readonly summary: string;
  readonly evidence?: string;
  readonly nextAction: string;
}

export interface LoopReviewAttempt {
  readonly schemaVersion: 1;
  readonly iteration: number;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly blockers: readonly LoopReviewBlocker[];
  readonly blockerKeys: readonly string[];
  readonly blockerFingerprint?: string;
  readonly workspaceFingerprint?: string;
  readonly model?: string;
  readonly usedModelFallback: boolean;
  readonly priorBlockerDispositions: readonly PriorBlockerDisposition[];
}

export interface LoopStrategyAttempt {
  readonly schemaVersion: 1;
  readonly triggeredAtIteration: number;
  readonly blockerFingerprint: string;
  readonly status: 'advised' | 'failed';
  readonly diagnosis?: string;
  readonly recommendedApproach?: string;
  readonly risks?: readonly string[];
  readonly model?: string;
  readonly usedModelFallback: boolean;
}

export interface LoopConvergenceSummary {
  readonly reviewAttempts: number;
  readonly lastBlockerFingerprint?: string;
  readonly strategyAttempts: number;
}

export interface LoopResult {
  readonly schemaVersion: 2;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly summary: string;
  readonly iterations: number;
  readonly checks: readonly LoopResultCheck[];
  readonly blockers: readonly LoopResultBlocker[];
  readonly findings?: readonly LoopResultFinding[];
  readonly role?: string;
}

/** In-memory goal state rebuilt from agent records. */
interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  stopCondition?: GoalStopCondition;
  reviewModel?: string;
  maxIterations?: number;
  minIntervalMs?: number;
  iteration: number;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  /** Accumulated active-pursuit time from completed `active` intervals. */
  wallClockMs: number;
  /**
   * Epoch ms anchoring the current `active` interval (undefined when not active).
   * The live elapsed since this is added to `wallClockMs` when reporting, so the
   * timer is correct even when read mid-turn; the interval is folded into
   * `wallClockMs` when the goal leaves `active`. Reset on agent resume.
   */
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  /** Human-readable reason for a stopped or completed goal. */
  terminalReason?: string;
  loopResult?: LoopResult;
  loopContract?: LoopContract;
  legacyContractId?: string;
  currentLoopRun?: LoopRunCreated;
  loopRunTerminals: Map<string, LoopRunTerminalV1>;
  gateAttemptCompletions: Map<string, GateAttemptCompletedV1>;
  restoredGateAudits: Map<string, RestoredGateAudit>;
  gateCheckHistory: GateCheckResultRecordedV1[];
  loopChainIterations: number;
  reviewHistory: LoopReviewAttempt[];
  strategyHistory: LoopStrategyAttempt[];
}

interface RestoredGateAudit {
  attempt: GateAttemptCreatedV1;
  checks: GateCheckResultRecordedV1[];
  scan?: BuiltinRiskScanResultRecordedV1;
  reviewer?: ReviewerResultRecordedV1;
  aggregate?: ProofAggregateRecordedV1;
  snapshot?: LoopEvidenceSnapshotCreatedV1;
}

/** Computed budget view exposed through snapshots and tools. */
export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

/** Public, computed view of the current goal. */
export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly stopCondition?: GoalStopCondition;
  readonly reviewModel?: string;
  readonly maxIterations?: number;
  readonly minIntervalMs?: number;
  readonly iteration: number;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  readonly loopResult?: LoopResult;
  readonly loopContract?: LoopContract;
  readonly legacyContractId?: string;
  readonly loopRunId?: string;
  readonly loopChainIterations?: number;
  readonly loopTerminal?: LoopRunTerminalV1;
  readonly convergence?: LoopConvergenceSummary;
}

/** Wrapper returned by goal read operations and tools. */
export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

/** Snapshot of the goal's usage counters at the moment of a change. */
export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * Describes what changed on a `goal.updated` event, so the UI can render the
 * right thing. Absent for snapshot-only refreshes (e.g. a turn increment that
 * only moves the badge).
 *
 * - `lifecycle`: a status transition — `paused` / `active` (resumed) / `blocked`
 *   — rendered as a low-profile transcript marker.
 * - `completion`: the goal completed successfully (the only outcome that posts
 *   the completion message and clears the record). This replaced the older
 *   `terminal` name, which since the state consolidation only ever meant
 *   `complete` — `blocked` is a resumable `lifecycle` change, not a completion.
 */
export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly stopCondition?: GoalStopCondition;
  readonly reviewModel?: string;
  readonly maxIterations?: number;
  readonly minIntervalMs?: number;
  readonly replace?: boolean;
  readonly loopContract?: LoopContractV2Input | LoopContractV3Input;
}

interface GoalReasonInput {
  readonly reason?: string;
}

/**
 * Single durable owner of the current goal.
 *
 * Lifecycle rules (see the {@link GoalStatus} union for the full per-status map):
 * - Success: `markComplete` records success then clears the record (transient).
 *   The model marks completion via the `UpdateGoal('complete')` tool; the turn
 *   driver reads the status at the turn boundary. `markComplete` announces, then
 *   clears the record.
 * - Task stop: `markBlocked(reason)` sets `blocked` when the model cannot
 *   proceed, a prompt hook blocks, or a hard budget is reached. `blocked` is
 *   resumable.
 * - Pause: `pauseGoal`, `pauseActiveGoal`, and the interrupt path
 *   `pauseOnInterrupt` set `paused` (resumable); `cancelGoal` discards the
 *   record entirely (no status — this is what `/goal cancel` does, the single
 *   remove action).
 * - An aborted or failed turn is not terminal: it pauses the goal, so it stays
 *   resumable — mirroring how `normalizeAfterReplay` demotes an `active` goal to
 *   `paused` on agent resume.
 */
export class GoalMode {
  private state: GoalState | undefined;
  private resumeInFlight?: Promise<GoalSnapshot>;

  constructor(private readonly agent: Agent) {
  }

  /**
   * Reconciles replayed goal state with runtime reality on agent resume.
   *
   * An `active` goal cannot still be running after a process restart (goal
   * continuation only advances inside a live turn), so it is demoted to
   * `paused`, requiring `/goal resume` to restart work. `paused` and `blocked`
   * goals are preserved (both resumable). Any stray `complete` (which should
   * have been followed by `goal.clear`) is removed.
   */
  normalizeAfterReplay(): void {
    const state = this.state;
    if (state === undefined) return;

    state.wallClockResumedAt = undefined;
    if (state.loopContract?.schemaVersion === 1 && state.legacyContractId === undefined) {
      state.legacyContractId = randomUUID();
      this.agent.records.logRecord({
        type: 'goal.contract.identity.assign',
        goalId: state.goalId,
        contractRecordIdentity: legacyContractRecordIdentity(state),
        contractId: state.legacyContractId,
      });
    }

    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }

    if (state.status === 'active') {
      const reason = 'Paused after agent resume';
      this.applyStatus(state, 'paused');
      state.terminalReason = reason;
      this.persistState(state, { silent: true });
      this.appendStatusUpdate(state, 'runtime', reason);
      return;
    }

    // `paused` and `blocked` goals are left intact (both resumable).
  }

  restoreCreate(record: AgentRecordOf<'goal.create'>): void {
    const state: GoalState = {
      goalId: record.goalId,
      objective: record.objective,
      completionCriterion: record.completionCriterion,
      // 0.0.12 has one delivery gate. Keep old records readable, but migrate
      // their v1 stop condition as they enter the in-memory state.
      stopCondition: normalizeStopCondition(record.stopCondition),
      reviewModel: record.reviewModel,
      maxIterations: record.maxIterations,
      minIntervalMs: record.minIntervalMs,
      iteration: 0,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
      loopRunTerminals: new Map(),
      gateAttemptCompletions: new Map(),
      restoredGateAudits: new Map(),
      gateCheckHistory: [],
      loopChainIterations: 0,
      reviewHistory: [],
      strategyHistory: [],
    };
    this.state = state;
    this.agent.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: { kind: 'created' },
    });
  }

  restoreUpdate(record: AgentRecordOf<'goal.update'>): void {
    const state = this.state;
    if (state === undefined) return;

    const status = record.status;
    if (status !== undefined) {
      state.status = status;
      state.wallClockResumedAt = undefined;
      state.terminalReason = status === 'active' ? undefined : record.reason;
    }
    if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
    if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
    if (record.iteration !== undefined) state.iteration = record.iteration;
    if (record.wallClockMs !== undefined) {
      state.wallClockMs = record.wallClockMs;
      state.wallClockResumedAt = undefined;
    }
    if (record.budgetLimits !== undefined) state.budgetLimits = record.budgetLimits;
    if (record.loopResult !== undefined) state.loopResult = record.loopResult;
    if (status === undefined) return;

    this.agent.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: status === 'complete'
        ? {
            kind: 'completion',
            status,
            reason: record.reason,
            stats: this.statsOf(state),
            actor: record.actor,
          }
        : {
            kind: 'lifecycle',
            status,
            reason: record.reason,
            actor: record.actor,
          },
    });
  }

  restoreContractCreate(record: AgentRecordOf<'goal.contract.create'>): void {
    const state = this.state;
    if (state === undefined || state.goalId !== record.goalId || state.loopContract !== undefined) {
      return;
    }
    state.loopContract = record.contract;
  }

  restoreContractIdentityAssign(
    record: AgentRecordOf<'goal.contract.identity.assign'>,
  ): void {
    const state = this.state;
    if (
      state === undefined
      || state.goalId !== record.goalId
      || state.loopContract?.schemaVersion !== 1
      || record.contractRecordIdentity !== legacyContractRecordIdentity(state)
    ) {
      return;
    }
    state.legacyContractId ??= record.contractId;
  }

  restoreGoalLineage(_record: AgentRecordOf<'goal.lineage.create'>): void {
    // Lineage is immutable historical metadata. The active V2 contract already
    // carries the forward supersedes references needed by the current run.
  }

  restoreReviewRecord(record: AgentRecordOf<'goal.review.record'>): void {
    const state = this.state;
    if (state === undefined || state.goalId !== record.goalId) return;
    state.reviewHistory.push(record.attempt);
  }

  restoreStrategyRecord(record: AgentRecordOf<'goal.strategy.record'>): void {
    const state = this.state;
    if (state === undefined || state.goalId !== record.goalId) return;
    state.strategyHistory.push(normalizeStrategyAttempt(record.attempt));
  }

  restoreClear(_record: AgentRecordOf<'goal.clear'>): void {
    this.state = undefined;
  }

  restoreForked(_record: AgentRecordOf<'forked'>): void {
    const hadGoal = this.state !== undefined;
    this.state = undefined;
    if (!hadGoal) return;
    this.agent.context.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, {
      kind: 'system_trigger',
      name: 'goal_fork_cleared',
    });
  }

  // --- Reads -------------------------------------------------------------

  getGoal(): GoalToolResult {
    const state = this.state;
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  getReviewHistory(): readonly LoopReviewAttempt[] {
    return this.state?.reviewHistory ?? [];
  }

  getStrategyHistory(): readonly LoopStrategyAttempt[] {
    return this.state?.strategyHistory ?? [];
  }

  // --- Creation ----------------------------------------------------------

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new WukongError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    const maxObjectiveLength = input.loopContract === undefined ? MAX_GOAL_OBJECTIVE_LENGTH : 8_000;
    if (objective.length > maxObjectiveLength) {
      throw new WukongError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${String(maxObjectiveLength)} characters`,
      );
    }
    if (input.loopContract !== undefined) {
      validateLoopContractInput(
        input.loopContract,
        objective,
        normalizeCompletionCriterion(input.completionCriterion),
      );
    }
    if (
      input.maxIterations !== undefined
      && (!Number.isSafeInteger(input.maxIterations) || input.maxIterations <= 0)
    ) {
      throw new RangeError('maxIterations must be a positive safe integer');
    }

    const existing = this.state;
    if (existing !== undefined) {
      // Any persisted goal (active / paused / blocked) is intact and blocks a
      // new one unless `replace` is set; `complete` never persists, so it is not
      // observed here. This protects a resumable paused/blocked goal from being
      // silently overwritten.
      if (input.replace !== true) {
        throw new WukongError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      if (
        input.loopContract?.supersedesGoalId !== undefined
        && (
          existing.goalId !== input.loopContract.supersedesGoalId
          || (
            existing.loopContract?.schemaVersion !== 2
            && existing.loopContract?.schemaVersion !== 3
          )
          || existing.loopContract.contractId !== input.loopContract.supersedesContractId
        )
      ) {
        throw new WukongError(
          ErrorCodes.REQUEST_INVALID,
          'Revised Loop lineage does not match the Goal being replaced',
        );
      }
      // Clear the previous goal through the same internal clear path so records
      // stay consistent before storing the replacement.
      this.clearInternal('system');
    }

    const completionCriterion = normalizeCompletionCriterion(input.completionCriterion);
    const stopCondition = normalizeStopCondition(input.stopCondition);
    const reviewModel = normalizeReviewModel(input.reviewModel);
    const maxIterations = normalizeMaxIterations(input.maxIterations);
    const minIntervalMs = normalizeMinIntervalMs(input.minIntervalMs);
    const state: GoalState = {
      goalId: randomUUID(),
      objective,
      completionCriterion,
      stopCondition,
      reviewModel,
      maxIterations,
      minIntervalMs,
      iteration: 0,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: {},
      loopRunTerminals: new Map(),
      gateAttemptCompletions: new Map(),
      restoredGateAudits: new Map(),
      gateCheckHistory: [],
      loopChainIterations: 0,
      reviewHistory: [],
      strategyHistory: [],
    };

    this.persistState(state);
    this.agent.records.logRecord({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      stopCondition: state.stopCondition,
      reviewModel: state.reviewModel,
      maxIterations: state.maxIterations,
      minIntervalMs: state.minIntervalMs,
    });
    this.trackGoalCreated(actor, input.replace === true);
    if (input.loopContract !== undefined) {
      if (input.loopContract.schemaVersion === 3) {
        this.createLoopContractV3(state, input.loopContract);
      } else {
        this.createLoopContractV2(state, input.loopContract);
      }
    } else if (state.stopCondition !== undefined) {
      this.ensureLoopContract('user');
    }
    return this.toSnapshot(state);
  }

  private createLoopContractV2(
    state: GoalState,
    input: LoopContractV2Input,
  ): LoopContractV2 {
    const criteria: LoopAcceptanceCriterion[] = [
      { id: 'objective', text: state.objective, source: 'objective' },
    ];
    if (state.completionCriterion !== undefined) {
      criteria.push({
        id: 'completion-criterion',
        text: state.completionCriterion,
        source: 'completion_criterion',
      });
    }
    for (const constraint of input.constraints) {
      criteria.push({
        id: constraint.id,
        text: constraint.text,
        source: 'constraint',
      });
    }
    const contract: LoopContractV2 = {
      schemaVersion: 2,
      contractId: randomUUID(),
      supersedesContractId: input.supersedesContractId,
      supersedesGoalId: input.supersedesGoalId,
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      constraints: input.constraints,
      finishLineReview: input.finishLineReview,
      workspaceIdentity: input.workspaceIdentity,
      workspaceTrust: input.workspaceTrust,
      gateApproval: input.gateApproval,
      acceptanceCriteria: criteria,
      verificationPlan: [
        {
          id: 'project-checks',
          kind: 'project_check',
          description: 'Run the frozen deterministic Gate Plan in order.',
          blocking: true,
        },
        {
          id: 'fresh-review',
          kind: 'review',
          description: 'Use a fresh read-only reviewer against every acceptance criterion.',
          blocking: true,
        },
      ],
      gatePlan: input.gatePlan,
      reviewPolicy: input.reviewPolicy,
      source: input.source,
      createdAt: Date.now(),
    };
    state.loopContract = contract;
    this.agent.records.logRecord({
      type: 'goal.contract.create',
      goalId: state.goalId,
      contract,
    });
    const run = this.createLoopRun(state, contract, input.reviewSettings);
    state.currentLoopRun = run;
    this.agent.records.logRecord({ type: 'loop.run.create', run });
    if (contract.supersedesContractId !== undefined && contract.supersedesGoalId !== undefined) {
      this.agent.records.logRecord({
        type: 'goal.lineage.create',
        goalId: state.goalId,
        supersedesGoalId: contract.supersedesGoalId,
        contractId: contract.contractId,
        supersedesContractId: contract.supersedesContractId,
      });
    }
    this.track('loop_contract_created', {
      contract_source: contract.source,
      criteria_count: contract.acceptanceCriteria.length,
      contract_schema_version: 2,
    });
    this.persistState(state);
    return contract;
  }

  private createLoopContractV3(
    state: GoalState,
    input: LoopContractV3Input,
  ): LoopContractV3 {
    validateVerificationCriteriaSelection(input.verificationCriteria);
    if (
      input.selectedRecipes.length !== input.verificationCriteria.selected.length
      || input.selectedRecipes.some((selected, index) => (
        selected.provenanceDigest
          !== input.verificationCriteria.selected[index]?.ref.provenanceDigest
        || selected.recipe.id
          !== input.verificationCriteria.selected[index]?.ref.criteriaId
      ))
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'Selected Verification Criteria recipes do not match the frozen ordered selection',
      );
    }
    if (input.gateApproval.gatePlanDigest !== input.legacyGatePlan.planDigest) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'Gate approval must bind the exact legacy Gate Plan',
      );
    }
    if (
      input.workspaceTrust.workspaceIdentityDigest
        !== input.workspaceIdentity.workspaceIdentityDigest
      || input.workspaceTrust.reviewSubjectPolicyVersion !== REVIEW_SUBJECT_POLICY_VERSION
      || input.workspaceTrust.hasExecutableChecks
        !== input.gateApproval.hasExecutableChecks
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'V3 workspace trust does not match the frozen Gate and review-subject policy',
      );
    }
    const contractId = randomUUID();
    const v2Criteria: LoopAcceptanceCriterion[] = [
      { id: 'objective', text: state.objective, source: 'objective' },
    ];
    if (state.completionCriterion !== undefined) {
      v2Criteria.push({
        id: 'completion-criterion',
        text: state.completionCriterion,
        source: 'completion_criterion',
      });
    }
    for (const constraint of input.constraints) {
      v2Criteria.push({ id: constraint.id, text: constraint.text, source: 'constraint' });
    }
    const acceptanceCriteria: LoopAcceptanceCriterionV3[] = v2Criteria.map((criterion) => {
      const provenance = {
        kind: 'v2-criterion' as const,
        v2CriterionId: criterion.id,
        v2Source: criterion.source,
      };
      const core = {
        contractId,
        id: criterion.id,
        text: criterion.text,
        evidenceExpectation: null,
        source: criterion.source,
        provenance,
      };
      return {
        id: criterion.id,
        text: criterion.text,
        source: criterion.source,
        provenance,
        criterionProvenanceDigest: canonicalDigest(
          'wukong/acceptance-criterion/v3',
          core,
        ),
      };
    });
    for (const [selectionOrder, selected] of input.selectedRecipes.entries()) {
      for (const criterion of selected.recipe.criteria) {
        const id = `recipe-${String(selectionOrder)}-${criterion.id}`;
        const provenance = {
          kind: 'verification-recipe' as const,
          recipeProvenanceDigest: selected.provenanceDigest,
          recipeCriterionId: criterion.id,
        };
        const core = {
          contractId,
          id,
          text: criterion.text,
          evidenceExpectation: criterion.evidence,
          source: 'verification_recipe' as const,
          provenance,
        };
        acceptanceCriteria.push({
          id,
          text: criterion.text,
          evidenceExpectation: criterion.evidence,
          source: 'verification_recipe',
          provenance,
          criterionProvenanceDigest: canonicalDigest(
            'wukong/acceptance-criterion/v3',
            core,
          ),
        });
      }
    }
    const gatePlanCore = {
      schemaVersion: 2 as const,
      stopCondition: 'proof-pass' as const,
      legacySnapshot: input.legacyGatePlan,
      criteriaSelectionDigest: input.verificationCriteria.selectionDigest,
      criterionIds: acceptanceCriteria.map((criterion) => criterion.id),
      builtinScanPolicyVersion: input.legacyGatePlan.builtinRiskScanPolicyVersion,
      freshReviewerPolicyVersion: FRESH_REVIEWER_POLICY_VERSION,
      reviewSubjectPolicyVersion: REVIEW_SUBJECT_POLICY_VERSION,
    };
    const gatePlan: GatePlanV2 = {
      ...gatePlanCore,
      planDigest: canonicalDigest('wukong/gate-plan/v2', gatePlanCore),
    };
    const contract: LoopContractV3 = {
      schemaVersion: 3,
      contractId,
      supersedesContractId: input.supersedesContractId,
      supersedesGoalId: input.supersedesGoalId,
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      constraints: input.constraints,
      finishLineReview: input.finishLineReview,
      workspaceIdentity: input.workspaceIdentity,
      workspaceTrust: input.workspaceTrust,
      gateApproval: input.gateApproval,
      acceptanceCriteria,
      verificationPlan: [
        {
          id: 'project-checks',
          kind: 'project_check',
          description: 'Run the frozen deterministic Gate Plan in order.',
          blocking: true,
        },
        {
          id: 'fresh-review',
          kind: 'review',
          description: 'Use one bounded brokered reviewer against every criterion.',
          blocking: true,
        },
      ],
      verificationCriteria: input.verificationCriteria,
      gatePlan,
      reviewPolicy: input.reviewPolicy,
      source: input.source,
      createdAt: Date.now(),
    };
    state.loopContract = contract;
    this.agent.records.logRecord({
      type: 'goal.contract.create',
      goalId: state.goalId,
      contract,
    });
    const run = this.createLoopRun(state, contract, input.reviewSettings);
    state.currentLoopRun = run;
    this.agent.records.logRecord({ type: 'loop.run.create', run });
    if (contract.supersedesContractId !== undefined && contract.supersedesGoalId !== undefined) {
      this.agent.records.logRecord({
        type: 'goal.lineage.create',
        goalId: state.goalId,
        supersedesGoalId: contract.supersedesGoalId,
        contractId: contract.contractId,
        supersedesContractId: contract.supersedesContractId,
      });
    }
    this.track('loop_contract_created', {
      contract_source: contract.source,
      criteria_count: contract.acceptanceCriteria.length,
      contract_schema_version: 3,
    });
    this.persistState(state);
    return contract;
  }

  recordGateAttempt(input: LoopGateAttemptInput): GateAttemptCompletedV1 | null {
    const state = this.state;
    const contract = state?.loopContract;
    const run = state?.currentLoopRun;
    if (state === undefined || contract?.schemaVersion !== 2 || run === undefined) return null;
    if (state.loopRunTerminals.has(run.runId)) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'Cannot append a Gate attempt after the current Loop run is terminal',
      );
    }
    const attemptId = randomUUID();
    const sequence = state.gateAttemptCompletions.size + 1;
    const now = Date.now();
    const carriedBlockerSetDigest = canonicalDigest(
      'wukong/carried-blocker-set/v1',
      run.carriedBlockerKeys.toSorted(),
    );
    const attemptBase = {
      schemaVersion: 1 as const,
      attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      sequence,
      planDigest: contract.gatePlan.planDigest,
      gateApprovalDigest: contract.gateApproval.approvalSetDigest,
      workspaceBefore: input.workspaceFingerprint,
      carriedBlockerSetDigest,
      createdAt: now,
    };
    const attempt: GateAttemptCreatedV1 = {
      ...attemptBase,
      attemptDigest: canonicalDigest('wukong/gate-attempt/v1', attemptBase),
    };
    this.agent.records.logRecord({ type: 'loop.gate-attempt.create', attempt });

    const checkResults: GateCheckResultRecordedV1[] = [];
    for (let index = 0; index < contract.gatePlan.requiredChecks.length; index += 1) {
      const frozen = contract.gatePlan.requiredChecks[index]!;
      const observed = input.checks[index];
      const base = {
        schemaVersion: 1 as const,
        checkResultRef: randomUUID(),
        attemptId,
        runId: run.runId,
        contractId: contract.contractId,
        planDigest: contract.gatePlan.planDigest,
        checkId: frozen.id,
        commandDigest: frozen.commandDigest,
        definitionDigest: frozen.resolution === 'resolved' ? frozen.definitionDigest : undefined,
        workspaceFingerprint: input.workspaceFingerprint,
        status: frozen.resolution === 'expected-unresolved'
          ? 'unresolved' as const
          : normalizeGateCheckStatus(observed?.status),
        exitCode: observed?.exitCode ?? undefined,
        stdoutDigest: observed?.stdout === undefined
          ? undefined
          : canonicalDigest('wukong/redacted-stdout/v1', observed.stdout),
        stderrDigest: observed?.stderr === undefined
          ? undefined
          : canonicalDigest('wukong/redacted-stderr/v1', observed.stderr),
        redactionVersion: 'loop-output-redaction/1',
        createdAt: now,
      };
      const record: GateCheckResultRecordedV1 = {
        ...base,
        checkResultDigest: canonicalDigest('wukong/gate-check-result/v1', base),
      };
      checkResults.push(record);
      this.agent.records.logRecord({ type: 'loop.gate-check-result.create', result: record });
    }

    const scanFindings = input.scanFindings.map((finding) => {
      const payload = {
        id: finding.id,
        severity: finding.severity,
        message: finding.message,
        file: finding.file,
        line: finding.line,
      };
      return {
        findingRef: randomUUID(),
        findingDigest: canonicalDigest('wukong/builtin-risk-finding/v1', payload),
        severity: finding.severity === 'high'
          ? 'blocking' as const
          : finding.severity === 'medium'
            ? 'important' as const
            : 'note' as const,
      };
    });
    const scanBase = {
      schemaVersion: 1 as const,
      scanResultRef: randomUUID(),
      attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: contract.gatePlan.planDigest,
      scanPolicyVersion: contract.gatePlan.builtinRiskScanPolicyVersion,
      workspaceFingerprint: input.workspaceFingerprint,
      status: scanFindings.some((finding) => finding.severity === 'blocking')
        ? 'blocking' as const
        : 'clean' as const,
      findings: scanFindings,
      createdAt: now,
    };
    const scan: BuiltinRiskScanResultRecordedV1 = {
      ...scanBase,
      scanResultDigest: canonicalDigest('wukong/builtin-risk-scan-result/v1', scanBase),
    };
    this.agent.records.logRecord({ type: 'loop.builtin-risk-scan-result.create', result: scan });
    const unstableCheckIds = checkResults
      .filter((current) => state.gateCheckHistory.some((prior) => (
        prior.workspaceFingerprint === current.workspaceFingerprint
        && prior.checkId === current.checkId
        && prior.commandDigest === current.commandDigest
        && (prior.status === 'passed') !== (current.status === 'passed')
      )))
      .map((current) => current.checkId);
    state.gateCheckHistory.push(...checkResults);

    const reviewerInputDigest = canonicalDigest('wukong/reviewer-input/v1', {
      attemptId,
      contractId: contract.contractId,
      planDigest: contract.gatePlan.planDigest,
      workspaceFingerprint: input.workspaceFingerprint,
      orderedCheckResultDigests: checkResults.map((result) => result.checkResultDigest),
      scanResultDigest: scan.scanResultDigest,
      carriedBlockerSetDigest,
      reviewPolicyBinding: contract.reviewPolicy,
    });
    const reviewerPayloadDigest = canonicalDigest(
      'wukong/reviewer-payload/v1',
      input.reviewerPayload,
    );
    const reviewerBase = {
      schemaVersion: 1 as const,
      reviewerResultRef: randomUUID(),
      attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: contract.gatePlan.planDigest,
      reviewerInputDigest,
      reviewerPayloadDigest,
      status: input.reviewerStatus,
      createdAt: now,
    };
    const reviewer: ReviewerResultRecordedV1 = {
      ...reviewerBase,
      reviewerResultDigest: canonicalDigest('wukong/reviewer-result-record/v1', reviewerBase),
    };
    this.agent.records.logRecord({ type: 'loop.reviewer-result.create', result: reviewer });

    const allChecksPassed = checkResults.length === contract.gatePlan.requiredChecks.length
      && checkResults.every((result) => result.status === 'passed');
    const canPass = input.status === 'PASS'
      && allChecksPassed
      && scan.status === 'clean'
      && reviewer.status === 'PASS'
      && unstableCheckIds.length === 0
      && input.blockerKeys.length === 0;
    const aggregateStatus: ProofAggregateRecordedV1['status'] = canPass
      ? 'PASS'
      : input.status === 'ERROR' || unstableCheckIds.length > 0
        ? 'ERROR'
        : 'NEEDS_WORK';
    const aggregateBase = {
      schemaVersion: 1 as const,
      proofAggregateResultRef: randomUUID(),
      attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: contract.gatePlan.planDigest,
      orderedCheckResultDigests: checkResults.map((result) => result.checkResultDigest),
      builtinRiskScanResultRef: scan.scanResultRef,
      builtinRiskScanResultDigest: scan.scanResultDigest,
      builtinRiskScanPolicyVersion: scan.scanPolicyVersion,
      reviewerResultDigest: reviewer.reviewerResultDigest,
      carriedBlockerSetDigest,
      status: aggregateStatus,
      reasonCode: canPass
        ? 'passed'
        : unstableCheckIds.length > 0
          ? 'check_unstable'
          : input.reasonCode,
      blockerKeys: [
        ...input.blockerKeys,
        ...unstableCheckIds.map((checkId) => `check:${checkId}:unstable`),
      ].toSorted(),
      createdAt: now,
    };
    const aggregate: ProofAggregateRecordedV1 = {
      ...aggregateBase,
      proofAggregateDigest: canonicalDigest('wukong/proof-aggregate/v1', aggregateBase),
    };
    this.agent.records.logRecord({ type: 'loop.proof-aggregate.create', result: aggregate });

    const snapshotBase = {
      schemaVersion: 1 as const,
      evidenceSnapshotId: randomUUID(),
      attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: contract.gatePlan.planDigest,
      gateApprovalDigest: contract.gateApproval.approvalSetDigest,
      workspaceTrustGrantId: input.workspaceTrustGrantId
        ?? contract.workspaceTrust?.trustGrantId,
      workspaceFingerprint: input.workspaceFingerprint,
      orderedCheckResults: checkResults.map((result) => ({
        checkId: result.checkId,
        resultRef: result.checkResultRef,
        resultDigest: result.checkResultDigest,
        status: result.status,
      })),
      reviewerResultRef: reviewer.reviewerResultRef,
      reviewerResultDigest: reviewer.reviewerResultDigest,
      builtinRiskScanResultRef: scan.scanResultRef,
      builtinRiskScanResultDigest: scan.scanResultDigest,
      builtinRiskScanPolicyVersion: scan.scanPolicyVersion,
      proofAggregateResultRef: aggregate.proofAggregateResultRef,
      proofAggregateDigest: aggregate.proofAggregateDigest,
      createdAt: now,
    };
    const snapshot: LoopEvidenceSnapshotCreatedV1 = {
      ...snapshotBase,
      evidenceDigest: canonicalDigest('wukong/loop-evidence-snapshot/v1', snapshotBase),
    };
    this.agent.records.logRecord({ type: 'loop.evidence-snapshot.create', snapshot });

    const completedBase = {
      schemaVersion: 1 as const,
      attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: contract.gatePlan.planDigest,
      gateApprovalDigest: contract.gateApproval.approvalSetDigest,
      sequence,
      status: aggregate.status,
      reasonCode: aggregate.reasonCode,
      evidenceSnapshotId: snapshot.evidenceSnapshotId,
      evidenceDigest: snapshot.evidenceDigest,
      createdAt: now,
    };
    const completed: GateAttemptCompletedV1 = {
      ...completedBase,
      resultDigest: canonicalDigest('wukong/gate-attempt-result/v1', completedBase),
    };
    state.gateAttemptCompletions.set(attemptId, completed);
    this.agent.records.logRecord({ type: 'loop.gate-attempt.complete', attempt: completed });
    this.persistState(state, { silent: true });
    return completed;
  }

  recordLoopTerminal(input: {
    readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
    readonly reasonCode: string;
    readonly blockerKeys?: readonly string[];
    readonly attempt?: GateAttemptCompletedV1 | null;
  }): LoopRunTerminalV1 | null {
    const state = this.state;
    const contract = state?.loopContract;
    const run = state?.currentLoopRun;
    if (state === undefined || contract?.schemaVersion !== 2 || run === undefined) return null;
    const existing = state.loopRunTerminals.get(run.runId);
    if (existing !== undefined) return existing;
    const policy = continuationPolicyFor(input.status, input.reasonCode);
    const base = {
      schemaVersion: 1 as const,
      runId: run.runId,
      contractId: contract.contractId,
      status: input.status,
      reasonCode: input.reasonCode,
      continuationPolicy: policy,
      blockerKeys: [...new Set(input.blockerKeys ?? [])].toSorted(),
      terminalAttemptId: input.attempt?.attemptId,
      attemptResultDigest: input.attempt?.resultDigest,
      createdAt: Date.now(),
    };
    if (input.status === 'PASS' && input.attempt?.status !== 'PASS') {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'PASS terminal requires a complete PASS Gate attempt');
    }
    const terminal: LoopRunTerminalV1 = {
      ...base,
      terminalDigest: canonicalDigest('wukong/loop-terminal/v1', base),
    };
    state.loopRunTerminals.set(run.runId, terminal);
    this.agent.records.logRecord({ type: 'loop.run.terminal', terminal });
    this.persistState(state, { silent: true });
    return terminal;
  }

  restoreLoopRunCreate(record: AgentRecordOf<'loop.run.create'>): void {
    const state = this.state;
    if (state === undefined || state.goalId !== record.run.goalId) return;
    const { runDigest, ...base } = record.run;
    if (canonicalDigest('wukong/loop-run/v1', base) !== runDigest) {
      throw new Error('Loop record replay failed: run digest mismatch');
    }
    state.currentLoopRun = record.run;
  }

  restoreLoopRunTerminal(record: AgentRecordOf<'loop.run.terminal'>): void {
    const state = this.state;
    if (state === undefined) return;
    const { terminalDigest, ...base } = record.terminal;
    if (canonicalDigest('wukong/loop-terminal/v1', base) !== terminalDigest) {
      throw new Error('Loop record replay failed: terminal digest mismatch');
    }
    if (
      record.terminal.status === 'PASS'
      && (
        record.terminal.terminalAttemptId === undefined
        || state.gateAttemptCompletions.get(record.terminal.terminalAttemptId)?.status !== 'PASS'
      )
    ) {
      throw new Error('Loop record replay failed: PASS terminal lacks a complete PASS attempt');
    }
    state.loopRunTerminals.set(record.terminal.runId, record.terminal);
  }

  restoreGateAttemptComplete(record: AgentRecordOf<'loop.gate-attempt.complete'>): void {
    const state = this.state;
    if (state === undefined) return;
    validateRestoredGateAttempt(state, record.attempt);
    state.gateAttemptCompletions.set(record.attempt.attemptId, record.attempt);
  }

  restoreLoopAuditRecord(record: AgentRecordOf<
    | 'loop.gate-attempt.create'
    | 'loop.gate-check-result.create'
    | 'loop.builtin-risk-scan-result.create'
    | 'loop.reviewer-result.create'
    | 'loop.proof-aggregate.create'
    | 'loop.evidence-snapshot.create'
    | 'loop.continuation.create'
  >): void {
    const state = this.state;
    if (state === undefined) return;
    restoreGateAuditRecord(state, record);
  }

  private createLoopRun(
    state: GoalState,
    contract: LoopContractV2 | LoopContractV3,
    reviewSettings?: LoopRunReviewSettingsInput,
    continuedFromRunId?: string,
    carriedBlockerKeys: readonly string[] = [],
  ): LoopRunCreated {
    const legacy: LoopRunSettings = {
      writerModel: this.agent.config.modelAlias,
      reviewerModel: state.reviewModel,
      permissionMode: this.agent.permission.mode,
      maxIterations: state.maxIterations ?? 10,
      minIntervalMs: state.minIntervalMs,
    };
    const shared = {
      runId: randomUUID(),
      goalId: state.goalId,
      contractId: contract.contractId,
      continuedFromRunId,
      carriedBlockerKeys: [...new Set(carriedBlockerKeys)].toSorted(),
      createdAt: Date.now(),
    };
    if (reviewSettings !== undefined) {
      validateLoopRunReviewSettings(contract, reviewSettings);
      const legacySettingsDigest = canonicalDigest(
        'wukong/loop-run-settings/legacy/v1',
        legacy,
      );
      const settingsCore = {
        schemaVersion: 2 as const,
        legacy,
        legacySettingsDigest,
        brokerReviewTrust: reviewSettings.brokerReviewTrust,
        reviewSubjectConsent: reviewSettings.reviewSubjectConsent,
      };
      const runSettings: LoopRunSettingsV2 = {
        ...settingsCore,
        settingsDigest: canonicalDigest('wukong/loop-run-settings/v2', settingsCore),
      };
      const base = {
        schemaVersion: 2 as const,
        ...shared,
        runSettingsRef: randomUUID(),
        runSettings,
      };
      return {
        ...base,
        runDigest: canonicalDigest('wukong/loop-run/v2', base),
      };
    }
    const base = {
      schemaVersion: 1 as const,
      ...shared,
      runSettings: legacy,
    };
    return {
      ...base,
      runDigest: canonicalDigest('wukong/loop-run/v1', base),
    };
  }

  /**
   * Creates the immutable acceptance contract once. Old Goal records receive a
   * deterministic fallback contract only when their 0.0.16 gate first runs.
   */
  ensureLoopContract(source: LoopContract['source'] = 'fallback'): LoopContract | null {
    const state = this.state;
    if (state === undefined) return null;
    if (state.loopContract !== undefined) return state.loopContract;

    const criteria: LoopAcceptanceCriterion[] = [
      { id: 'objective', text: state.objective, source: 'objective' },
    ];
    if (state.completionCriterion !== undefined) {
      criteria.push({
        id: 'completion-criterion',
        text: state.completionCriterion,
        source: 'completion_criterion',
      });
    }
    const contract: LoopContract = {
      schemaVersion: 1,
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      acceptanceCriteria: criteria,
      verificationPlan: [
        {
          id: 'project-checks',
          kind: 'project_check',
          description: 'Run the repository-selected deterministic checks.',
          blocking: true,
        },
        {
          id: 'fresh-review',
          kind: 'review',
          description: 'Use a fresh read-only reviewer against every acceptance criterion.',
          blocking: true,
        },
      ],
      source,
      createdAt: Date.now(),
    };
    state.loopContract = contract;
    this.agent.records.logRecord({
      type: 'goal.contract.create',
      goalId: state.goalId,
      contract,
    });
    this.track('loop_contract_created', {
      contract_source: contract.source,
      criteria_count: contract.acceptanceCriteria.length,
    });
    this.persistState(state);
    return contract;
  }

  recordReviewAttempt(attempt: LoopReviewAttempt): void {
    const state = this.requireState();
    const previous = state.reviewHistory.at(-1);
    state.reviewHistory.push(attempt);
    this.agent.records.logRecord({
      type: 'goal.review.record',
      goalId: state.goalId,
      attempt,
    });
    if (
      attempt.blockerFingerprint !== undefined
      && attempt.blockerFingerprint === previous?.blockerFingerprint
    ) {
      this.track('loop_blocker_repeated', {
        iteration: attempt.iteration,
        blocker_count: attempt.blockerKeys.length,
        repeated: true,
      });
    }
    this.persistState(state);
  }

  recordStrategyAttempt(attempt: LoopStrategyAttempt): void {
    const state = this.requireState();
    state.strategyHistory.push(attempt);
    this.agent.records.logRecord({
      type: 'goal.strategy.record',
      goalId: state.goalId,
      attempt,
    });
    this.track('loop_strategist_terminal', {
      iteration: attempt.triggeredAtIteration,
      strategist_outcome: attempt.status,
    });
    this.persistState(state);
  }

  // --- User-owned lifecycle ---------------------------------------------

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new WukongError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  /**
   * Parks the current active goal without throwing if it already stopped. Runtime
   * paths use this after a turn has ended, where the user may already have
   * paused, cleared, or otherwise changed the goal.
   */
  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async resumeGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    if (this.resumeInFlight !== undefined) return this.resumeInFlight;
    const pending = this.resumeGoalInternal(input, actor);
    this.resumeInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.resumeInFlight === pending) this.resumeInFlight = undefined;
    }
  }

  private async resumeGoalInternal(
    input: GoalReasonInput,
    actor: GoalActor,
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new WukongError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    const contract = state.loopContract;
    const currentRun = state.currentLoopRun;
    const terminal = currentRun === undefined
      ? undefined
      : state.loopRunTerminals.get(currentRun.runId);
    if (
      state.status === 'blocked'
      && (contract?.schemaVersion === 2 || contract?.schemaVersion === 3)
      && currentRun !== undefined
      && terminal !== undefined
    ) {
      if (terminal.continuationPolicy.mode !== 'same-contract') {
        throw new WukongError(
          ErrorCodes.GOAL_NOT_RESUMABLE,
          'This Loop requires restoring the approved workspace or starting a Revised Loop.',
        );
      }
      const revalidation = await validateFrozenGatePlan(
        this.agent.config.cwd,
        contract.schemaVersion === 2 ? contract : legacyFinishLineProjection(contract),
      );
      if (!revalidation.ok) {
        throw new WukongError(
          ErrorCodes.GOAL_NOT_RESUMABLE,
          revalidation.message ?? 'The frozen Loop contract no longer matches this workspace.',
        );
      }
      const nextRun = this.createLoopRun(
        state,
        contract,
        currentRun.schemaVersion === 2
          ? {
              brokerReviewTrust: currentRun.runSettings.brokerReviewTrust,
              reviewSubjectConsent: currentRun.runSettings.reviewSubjectConsent,
            }
          : undefined,
        currentRun.runId,
        terminal.blockerKeys,
      );
      const continuationBase = {
        schemaVersion: 1 as const,
        continuationId: randomUUID(),
        priorRunId: currentRun.runId,
        nextRunId: nextRun.runId,
        contractId: contract.contractId,
        carriedBlockerKeys: terminal.blockerKeys,
        createdAt: Date.now(),
      };
      const continuation: LoopContinuationCreatedV1 = {
        ...continuationBase,
        continuationDigest: canonicalDigest('wukong/loop-continuation/v1', continuationBase),
      };
      state.currentLoopRun = nextRun;
      state.iteration = 0;
      this.agent.records.logRecord({ type: 'loop.continuation.create', continuation });
      this.agent.records.logRecord({ type: 'loop.run.create', run: nextRun });
    }
    // Resuming is a fresh attempt: clear the stop reason so a re-activated goal
    // starts clean.
    state.terminalReason = undefined;
    this.applyStatus(state, 'active');
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async setBudgetLimits(
    input: { budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    state.budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.persistState(state);
    this.appendGoalUpdate({ budgetLimits: state.budgetLimits });
    this.track('goal_budget_set', {
      actor,
      ...budgetTelemetryProperties(input.budgetLimits),
    });
    return this.toSnapshot(state);
  }

  /**
   * Discards the current goal — the single user-facing "remove" action
   * (`/goal cancel`). There is no `cancelled` status: cancel clears the durable
   * record and returns the snapshot it removed, so callers can report what was
   * cancelled. Throws if no goal exists. (Internal callers that need to clear
   * without a return — e.g. `createGoal` replacing an existing goal — use the
   * private `clearInternal`.)
   */
  async cancelGoal(actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.clearInternal(actor);
    if (actor === 'user') {
      this.agent.context.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      });
    }
    return snapshot;
  }

  // --- Terminal outcomes (system-decided) -------------------------------

  /**
   * Marks the goal `blocked`: the system stopped pursuing it for `reason` — the
   * model's `UpdateGoal('blocked')` (incl. objectives it deems unachievable), a
   * hard budget reached by the goal driver, or a prompt-hook block.
   * `blocked` is persisted and **resumable** via
   * `/goal resume` (it is a sibling of `paused`, not a dead end), so it emits a
   * `lifecycle` change. No-ops for a goal that is missing or not active, so a
   * user pause / clear is never overwritten.
   */
  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    if (
      state.loopContract?.schemaVersion === 2
      && state.currentLoopRun !== undefined
      && !state.loopRunTerminals.has(state.currentLoopRun.runId)
    ) {
      this.recordLoopTerminal({
        status: 'NEEDS_WORK',
        reasonCode: blockedReasonCode(input.reason),
      });
    }
    this.applyStatus(state, 'blocked');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  /**
   * Records goal success, then clears the durable record. `complete` is
   * transient: this records and emits a terminal `complete` change carrying the
   * final stats (so the UI/caller can render the outcome), then clears the goal
   * so the box disappears. Returns the final snapshot (status `complete`). No-ops
   * for a goal that is missing or not active.
   */
  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    if (
      state.loopContract?.schemaVersion === 2
      && (
        state.currentLoopRun === undefined
        || state.loopRunTerminals.get(state.currentLoopRun.runId)?.status !== 'PASS'
      )
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'A V2 Loop cannot complete without a durable PASS terminal.',
      );
    }
    this.applyStatus(state, 'complete');
    state.terminalReason = input.reason;
    const snapshot = this.toSnapshot(state);
    // Record + notify the UI of completion (with final stats) before clearing.
    this.appendStatusUpdate(state, actor, input.reason);
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(state),
      actor,
    });
    // ...then clear the durable record (emits onGoalUpdated(null) → box clears).
    this.clearInternal(actor);
    return snapshot;
  }

  // --- User-interrupt transition ----------------------------------------

  /**
   * Parks an active goal when its live turn is aborted (Esc, shutdown, or any
   * other turn-level cancellation). This is **not** terminal: the goal becomes
   * `paused` and stays resumable via `/goal resume`, mirroring how
   * `normalizeAfterReplay` demotes an `active` goal on agent resume. No-ops for
   * a goal that is missing or already non-active, so a user pause / clear or an
   * already-stopped goal is never overwritten.
   */
  async pauseOnInterrupt(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  // --- Accounting & reporting -------------------------------------------

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const delta = Math.max(0, tokenDelta);
    state.tokensUsed += delta;
    this.persistState(state, { silent: true }); // per-step: no UI update
    this.appendGoalUpdate({ tokensUsed: state.tokensUsed });
    return this.toSnapshot(state);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    this.persistState(state);
    this.appendGoalUpdate({ turnsUsed: state.turnsUsed });
    this.track('goal_continued', {
      turns_used: state.turnsUsed,
    });
    return this.toSnapshot(state);
  }

  async incrementIteration(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.iteration += 1;
    state.loopChainIterations += 1;
    this.persistState(state);
    this.appendGoalUpdate({ iteration: state.iteration });
    return this.toSnapshot(state);
  }

  recordLoopResult(result: Omit<LoopResult, 'iterations'>): LoopResult | null {
    const state = this.state;
    if (state === undefined) return null;
    const loopResult: LoopResult = {
      ...result,
      iterations: state.iteration,
    };
    state.loopResult = loopResult;
    this.persistState(state);
    this.appendGoalUpdate({ loopResult });
    return loopResult;
  }

  // --- Internals ---------------------------------------------------------

  private clearInternal(
    actor: GoalActor,
    opts: { emit?: boolean; track?: boolean } = {},
  ): void {
    const state = this.state;
    if (state === undefined) return; // idempotent
    this.persistState(undefined, { silent: opts.emit === false });
    this.agent.records.logRecord({ type: 'goal.clear' });
    if (opts.track !== false) {
      this.track('goal_cleared', { actor });
    }
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, reason?: string): void {
    this.appendGoalUpdate({
      status: state.status,
      reason,
      wallClockMs: liveWallClockMs(state, Date.now()),
      actor,
    });
    this.track('goal_status_changed', {
      actor,
      status: state.status,
      turns_used: state.turnsUsed,
      tokens_used: state.tokensUsed,
      wall_clock_ms: liveWallClockMs(state, Date.now()),
      ...budgetTelemetryProperties(state.budgetLimits),
    });
  }

  private appendGoalUpdate(
    update: Omit<AgentRecordOf<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.agent.records.logRecord({
      type: 'goal.update',
      ...update,
    });
  }

  private trackGoalCreated(
    actor: GoalActor,
    replace: boolean,
  ): void {
    this.track('goal_created', {
      actor,
      replace,
    });
  }

  private track(event: string, properties: TelemetryProperties): void {
    this.agent.telemetry.track(event, properties);
  }

  private applyStatus(
    state: GoalState,
    status: GoalStatus,
  ): void {
    // Fold the live wall-clock interval into the running total when leaving
    // `active`, and anchor a fresh interval when entering it, so `wallClockMs`
    // stays a correct, persistable total across pause/resume/complete.
    const now = Date.now();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, now - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new WukongError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }


  /**
   * Updates in-memory goal state and (unless `silent`) emits a `goal.updated`
   * event with the resulting snapshot. `silent` is used for per-step token /
   * wall-clock accounting so the UI is not updated on every step.
   */
  private persistState(
    state: GoalState | undefined,
    opts: { silent?: boolean; change?: GoalChange } = {},
  ): void {
    this.state = state;
    if (opts.silent !== true) {
      this.emitGoalUpdated(state === undefined ? null : this.toSnapshot(state), opts.change);
    }
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.agent.emitEvent({ type: 'goal.updated', snapshot, change });
  }

  /** Counter snapshot for a {@link GoalChange}. */
  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      stopCondition: state.stopCondition,
      reviewModel: state.reviewModel,
      maxIterations: state.maxIterations,
      minIntervalMs: state.minIntervalMs,
      iteration: state.iteration,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
      budget: computeBudgetReport(state, Date.now()),
      terminalReason: state.terminalReason,
      loopResult: state.loopResult,
      loopContract: state.loopContract,
      legacyContractId: state.legacyContractId,
      loopRunId: state.currentLoopRun?.runId,
      loopChainIterations: state.loopChainIterations,
      loopTerminal: state.currentLoopRun === undefined
        ? undefined
        : state.loopRunTerminals.get(state.currentLoopRun.runId),
      convergence: state.reviewHistory.length === 0 && state.strategyHistory.length === 0
        ? undefined
        : {
            reviewAttempts: state.reviewHistory.length,
            lastBlockerFingerprint: state.reviewHistory.at(-1)?.blockerFingerprint,
            strategyAttempts: state.strategyHistory.length,
          },
    };
  }
}

function restoreGateAuditRecord(
  state: GoalState,
  record: AgentRecordOf<
    | 'loop.gate-attempt.create'
    | 'loop.gate-check-result.create'
    | 'loop.builtin-risk-scan-result.create'
    | 'loop.reviewer-result.create'
    | 'loop.proof-aggregate.create'
    | 'loop.evidence-snapshot.create'
    | 'loop.continuation.create'
  >,
): void {
  if (record.type === 'loop.continuation.create') {
    const { continuationDigest, ...base } = record.continuation;
    if (canonicalDigest('wukong/loop-continuation/v1', base) !== continuationDigest) {
      throw new Error('Loop record replay failed: continuation digest mismatch');
    }
    return;
  }
  if (record.type === 'loop.gate-attempt.create') {
    const { attemptDigest, ...base } = record.attempt;
    if (canonicalDigest('wukong/gate-attempt/v1', base) !== attemptDigest) {
      throw new Error('Loop record replay failed: Gate attempt digest mismatch');
    }
    const contract = state.loopContract;
    if (
      contract?.schemaVersion !== 2
      || contract.contractId !== record.attempt.contractId
      || contract.gatePlan.planDigest !== record.attempt.planDigest
      || contract.gateApproval.approvalSetDigest !== record.attempt.gateApprovalDigest
      || state.restoredGateAudits.has(record.attempt.attemptId)
    ) {
      throw new Error('Loop record replay failed: Gate attempt binding mismatch');
    }
    state.restoredGateAudits.set(record.attempt.attemptId, {
      attempt: record.attempt,
      checks: [],
    });
    return;
  }

  const payload = record.type === 'loop.evidence-snapshot.create'
    ? record.snapshot
    : record.result;
  const audit = state.restoredGateAudits.get(payload.attemptId);
  if (audit === undefined) {
    throw new Error('Loop record replay failed: audit record precedes its Gate attempt');
  }
  if (
    payload.runId !== audit.attempt.runId
    || payload.contractId !== audit.attempt.contractId
    || payload.planDigest !== audit.attempt.planDigest
  ) {
    throw new Error('Loop record replay failed: Gate audit binding mismatch');
  }

  switch (record.type) {
    case 'loop.gate-check-result.create': {
      const { checkResultDigest, ...base } = record.result;
      if (canonicalDigest('wukong/gate-check-result/v1', base) !== checkResultDigest) {
        throw new Error('Loop record replay failed: check result digest mismatch');
      }
      audit.checks.push(record.result);
      state.gateCheckHistory.push(record.result);
      return;
    }
    case 'loop.builtin-risk-scan-result.create': {
      const { scanResultDigest, ...base } = record.result;
      if (
        audit.scan !== undefined
        || canonicalDigest('wukong/builtin-risk-scan-result/v1', base) !== scanResultDigest
      ) {
        throw new Error('Loop record replay failed: risk scan result mismatch');
      }
      audit.scan = record.result;
      return;
    }
    case 'loop.reviewer-result.create': {
      const { reviewerResultDigest, ...base } = record.result;
      if (
        audit.reviewer !== undefined
        || canonicalDigest('wukong/reviewer-result-record/v1', base) !== reviewerResultDigest
      ) {
        throw new Error('Loop record replay failed: reviewer result mismatch');
      }
      audit.reviewer = record.result;
      return;
    }
    case 'loop.proof-aggregate.create': {
      const { proofAggregateDigest, ...base } = record.result;
      if (
        audit.aggregate !== undefined
        || canonicalDigest('wukong/proof-aggregate/v1', base) !== proofAggregateDigest
      ) {
        throw new Error('Loop record replay failed: proof aggregate mismatch');
      }
      audit.aggregate = record.result;
      return;
    }
    case 'loop.evidence-snapshot.create': {
      const { evidenceDigest, ...base } = record.snapshot;
      if (
        audit.snapshot !== undefined
        || canonicalDigest('wukong/loop-evidence-snapshot/v1', base) !== evidenceDigest
      ) {
        throw new Error('Loop record replay failed: evidence snapshot mismatch');
      }
      audit.snapshot = record.snapshot;
      return;
    }
  }
}

function validateRestoredGateAttempt(
  state: GoalState,
  completed: GateAttemptCompletedV1,
): void {
  const { resultDigest, ...base } = completed;
  if (canonicalDigest('wukong/gate-attempt-result/v1', base) !== resultDigest) {
    throw new Error('Loop record replay failed: Gate completion digest mismatch');
  }
  const audit = state.restoredGateAudits.get(completed.attemptId);
  const contract = state.loopContract;
  if (
    audit === undefined
    || contract?.schemaVersion !== 2
    || audit.scan === undefined
    || audit.reviewer === undefined
    || audit.aggregate === undefined
    || audit.snapshot === undefined
    || audit.checks.length !== contract.gatePlan.requiredChecks.length
  ) {
    throw new Error('Loop record replay failed: Gate completion has missing evidence');
  }
  const checkDigests = audit.checks.map((check) => check.checkResultDigest);
  if (
    completed.runId !== audit.attempt.runId
    || completed.contractId !== audit.attempt.contractId
    || completed.planDigest !== audit.attempt.planDigest
    || completed.gateApprovalDigest !== audit.attempt.gateApprovalDigest
    || completed.evidenceSnapshotId !== audit.snapshot.evidenceSnapshotId
    || completed.evidenceDigest !== audit.snapshot.evidenceDigest
    || audit.aggregate.status !== completed.status
    || audit.aggregate.proofAggregateDigest !== audit.snapshot.proofAggregateDigest
    || audit.scan.scanResultDigest !== audit.snapshot.builtinRiskScanResultDigest
    || audit.reviewer.reviewerResultDigest !== audit.snapshot.reviewerResultDigest
    || canonicalJson(checkDigests) !== canonicalJson(audit.aggregate.orderedCheckResultDigests)
    || canonicalJson(checkDigests)
      !== canonicalJson(audit.snapshot.orderedCheckResults.map((check) => check.resultDigest))
  ) {
    throw new Error('Loop record replay failed: Gate evidence join mismatch');
  }
}

/**
 * Live active-pursuit time: the accumulated total plus the in-flight `active`
 * interval. Correct even when read mid-turn (the interval isn't folded into
 * `wallClockMs` until the goal leaves `active`).
 */
function liveWallClockMs(state: GoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function computeBudgetReport(
  state: GoalState,
  now: number = Date.now(),
): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function budgetTelemetryProperties(limits: GoalBudgetLimits): TelemetryProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}

function normalizeMaxIterations(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizeMinIntervalMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  // Match the command parser's one-minute safety floor so malformed or older
  // SDK clients cannot create a hot retry loop.
  return Math.max(60_000, Math.floor(value));
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function normalizeStopCondition(value: string | undefined): GoalStopCondition | undefined {
  if (value === 'proof-pass') return value;
  if (value === 'verify-pass' || value === 'scan-clean' || value === 'judge-pass') return 'proof-pass';
  return undefined;
}

function normalizeReviewModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function validateLoopContractInput(
  input: LoopContractV2Input | LoopContractV3Input,
  objective: string,
  completionCriterion: string | undefined,
): void {
  if (
    (input.schemaVersion !== 2 && input.schemaVersion !== 3)
    || input.objective.trim() !== objective
  ) {
    throw new WukongError(
      ErrorCodes.REQUEST_INVALID,
      'Loop Finish Line does not match the requested objective',
    );
  }
  if (
    (input.supersedesContractId === undefined)
      !== (input.supersedesGoalId === undefined)
  ) {
    throw new WukongError(
      ErrorCodes.REQUEST_INVALID,
      'A Revised Loop must bind both the superseded Goal and contract',
    );
  }
  if (normalizeCompletionCriterion(input.completionCriterion) !== completionCriterion) {
    throw new WukongError(
      ErrorCodes.REQUEST_INVALID,
      'Loop Finish Line completion criterion does not match the Goal request',
    );
  }
  if (
    input.completionCriterion !== undefined
    && (
      normalizeCompletionCriterion(input.completionCriterion) === undefined
      || input.completionCriterion.length > 8_000
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input.completionCriterion)
    )
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Invalid Loop completion criterion');
  }
  if (
    input.finishLineReview.warnings.length > 0
    && (
      input.finishLineReview.acknowledgedWarningIds.length
        !== input.finishLineReview.warnings.length
      || input.finishLineReview.warnings.some(
        (warning) => !input.finishLineReview.acknowledgedWarningIds.includes(warning.id),
      )
    )
  ) {
    throw new WukongError(
      ErrorCodes.REQUEST_INVALID,
      'Finish Line warnings must be acknowledged before starting the Loop',
    );
  }
  const gatePlan = input.schemaVersion === 2 ? input.gatePlan : input.legacyGatePlan;
  const hasExecutableChecks = gatePlan.requiredChecks.some(
    (check) => check.resolution === 'resolved',
  );
  if (
    hasExecutableChecks !== input.gateApproval.hasExecutableChecks
    || input.gateApproval.gatePlanDigest !== gatePlan.planDigest
      || input.gateApproval.warningSetDigest !== input.finishLineReview.warningSetDigest
      || input.gateApproval.guardPolicyVersion !== GATE_GUARD_POLICY_VERSION
      || gatePlan.builtinRiskScanPolicyVersion !== BUILTIN_RISK_SCAN_POLICY_VERSION
      || input.finishLineReview.warningPolicyVersion !== FINISH_LINE_WARNING_POLICY_VERSION
    || input.gateApproval.orderedChecks.length !== gatePlan.requiredChecks.length
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop Gate approval does not match the frozen plan');
  }
  if (input.schemaVersion === 3) {
    if (
      input.workspaceTrust.hasExecutableChecks !== hasExecutableChecks
      || input.workspaceTrust.workspaceIdentityDigest
        !== input.workspaceIdentity.workspaceIdentityDigest
      || input.workspaceTrust.reviewSubjectPolicyVersion !== REVIEW_SUBJECT_POLICY_VERSION
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'V3 Loop trust must bind exact project-check and broker scopes',
      );
    }
  } else if (hasExecutableChecks) {
    if (
      input.workspaceTrust === undefined
      || input.gateApproval.workspaceIdentityDigest
        !== input.workspaceTrust.workspaceIdentityDigest
      || input.workspaceTrust.workspaceIdentityDigest
        !== input.workspaceIdentity.workspaceIdentityDigest
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Executable Loop checks require exact workspace trust');
    }
  } else if (input.workspaceTrust !== undefined) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Non-executable Loop plans cannot carry workspace trust');
  }
  for (let index = 0; index < gatePlan.requiredChecks.length; index += 1) {
    const check = gatePlan.requiredChecks[index]!;
    const approval = input.gateApproval.orderedChecks[index]!;
    if (
      check.id !== approval.checkId
      || check.resolution !== approval.resolution
      || check.commandDigest !== approval.commandDigest
      || containsInlineSecret(check.executionCommand)
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop Gate approval check snapshot is invalid');
    }
  }
  const gatePlanWithoutDigest = {
    schemaVersion: gatePlan.schemaVersion,
    stopCondition: gatePlan.stopCondition,
    requiredChecks: gatePlan.requiredChecks,
    excludedChecks: gatePlan.excludedChecks,
    builtinRiskScanPolicyVersion: gatePlan.builtinRiskScanPolicyVersion,
  };
  if (
    canonicalDigest('wukong/gate-plan/v1', gatePlanWithoutDigest)
      !== gatePlan.planDigest
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop Gate Plan digest is invalid');
  }
  const finishLineCore = {
    objective,
    completionCriterion: completionCriterion ?? null,
    constraints: input.constraints,
    gatePlanDigest: gatePlan.planDigest,
  };
  if (
    canonicalDigest('wukong/finish-line/v1', finishLineCore)
      !== input.finishLineReview.finishLineDigest
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop Finish Line digest is invalid');
  }
  const warningCore = {
    warningPolicyVersion: input.finishLineReview.warningPolicyVersion,
    finishLineDigest: input.finishLineReview.finishLineDigest,
    warnings: input.finishLineReview.warnings,
  };
  if (
    canonicalDigest('wukong/finish-line-warnings/v1', warningCore)
      !== input.finishLineReview.warningSetDigest
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop warning-set digest is invalid');
  }
  const approvalCore = {
    schemaVersion: input.gateApproval.schemaVersion,
    gatePlanDigest: input.gateApproval.gatePlanDigest,
    warningSetDigest: input.gateApproval.warningSetDigest,
    guardPolicyVersion: input.gateApproval.guardPolicyVersion,
    orderedChecks: input.gateApproval.orderedChecks,
    hasExecutableChecks: input.gateApproval.hasExecutableChecks,
    ...(input.gateApproval.hasExecutableChecks
      ? { workspaceIdentityDigest: input.gateApproval.workspaceIdentityDigest }
      : {}),
  };
  if (
    canonicalDigest('wukong/gate-approval/v1', approvalCore)
      !== input.gateApproval.approvalSetDigest
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop Gate approval digest is invalid');
  }
  const identityCore = {
    canonicalRealpath: input.workspaceIdentity.canonicalRealpath,
    filesystemIdentity: input.workspaceIdentity.filesystemIdentity,
    gitCommonDirIdentity: input.workspaceIdentity.gitCommonDirIdentity ?? null,
  };
  if (
    canonicalDigest('wukong/workspace-identity/v1', identityCore)
      !== input.workspaceIdentity.workspaceIdentityDigest
  ) {
    throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Loop workspace identity digest is invalid');
  }
}

function validateLoopRunReviewSettings(
  contract: LoopContractV2 | LoopContractV3,
  reviewSettings: LoopRunReviewSettingsInput,
): void {
  if (
    reviewSettings.brokerReviewTrust.workspaceIdentityDigest
      !== contract.workspaceIdentity.workspaceIdentityDigest
    || reviewSettings.brokerReviewTrust.scope !== 'brokered-review-subject'
    || reviewSettings.reviewSubjectConsent.workspaceIdentityDigest
      !== contract.workspaceIdentity.workspaceIdentityDigest
    || reviewSettings.reviewSubjectConsent.reviewSubjectPolicyVersion
      !== REVIEW_SUBJECT_POLICY_VERSION
  ) {
    throw new WukongError(
      ErrorCodes.REQUEST_INVALID,
      'Loop review settings do not match the exact workspace and broker policy',
    );
  }
}

function legacyFinishLineProjection(contract: LoopContractV3): {
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly workspaceTrust?: WorkspaceTrustBinding;
  readonly gateApproval: GateApprovalBinding;
  readonly gatePlan: GatePlan;
  readonly reviewPolicy: ReviewPolicyBinding;
} {
  return {
    workspaceIdentity: contract.workspaceIdentity,
    workspaceTrust: contract.workspaceTrust.hasExecutableChecks
      ? {
          workspaceIdentityDigest: contract.workspaceTrust.workspaceIdentityDigest,
          scope: 'loop-project-checks',
        }
      : undefined,
    gateApproval: contract.gateApproval,
    gatePlan: contract.gatePlan.legacySnapshot,
    reviewPolicy: contract.reviewPolicy,
  };
}

function normalizeGateCheckStatus(
  status: LoopGateAttemptInput['checks'][number]['status'] | undefined,
): GateCheckResultRecordedV1['status'] {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'error';
    case 'unavailable':
    case undefined:
      return 'unavailable';
  }
}

function continuationPolicyFor(
  status: LoopRunTerminalV1['status'],
  reasonCode: string,
): ContinuationPolicyV1 {
  if (status === 'PASS') {
    return {
      mode: 'blocked',
      automaticRetry: false,
      requiresPreflightRevalidation: true,
    };
  }
  if (
    reasonCode === 'max_iterations'
    || reasonCode === 'budget_exhausted'
    || reasonCode === 'model_blocked'
    || reasonCode === 'no_progress'
  ) {
    return {
      mode: 'same-contract',
      automaticRetry: false,
      requiresPreflightRevalidation: true,
    };
  }
  if (
    reasonCode === 'workspace_mismatch'
    || reasonCode === 'workspace_trust_mismatch'
    || reasonCode === 'gate_plan_drift'
    || reasonCode === 'gate_plan_changed'
    || reasonCode === 'frozen_check_missing'
    || reasonCode === 'review_policy_changed'
    || reasonCode === 'trust_revoked'
  ) {
    return {
      mode: 'restore-or-revise',
      automaticRetry: false,
      requiresPreflightRevalidation: true,
    };
  }
  if (reasonCode === 'contract_update_required') {
    return {
      mode: 'revised-loop',
      automaticRetry: false,
      requiresPreflightRevalidation: true,
    };
  }
  return {
    mode: 'blocked',
    automaticRetry: false,
    requiresPreflightRevalidation: true,
  };
}

function blockedReasonCode(reason: string | undefined): string {
  const normalized = reason?.toLowerCase() ?? '';
  if (normalized.includes('budget')) return 'budget_exhausted';
  if (normalized.includes('permission') || normalized.includes('denied')) {
    return 'permission_denied';
  }
  if (normalized.includes('hook')) return 'hook_blocked';
  return 'runtime_blocked';
}

function legacyContractRecordIdentity(state: GoalState): string {
  const contract = state.loopContract;
  if (contract === undefined || contract.schemaVersion !== 1) return `goal:${state.goalId}:none`;
  return canonicalDigest('wukong/legacy-contract-record/v1', {
    goalId: state.goalId,
    objective: contract.objective,
    createdAt: contract.createdAt,
  });
}

function normalizeStrategyAttempt(attempt: LoopStrategyAttempt): LoopStrategyAttempt {
  const stored = attempt as unknown as {
    readonly triggeredAtIteration?: number;
    readonly afterIteration?: number;
    readonly blockerFingerprint?: string;
    readonly status?: 'advised' | 'failed';
    readonly outcome?: 'advice' | 'invalid_output' | 'error';
    readonly diagnosis?: string;
    readonly recommendedApproach?: string;
    readonly advice?: string;
    readonly risks?: readonly string[];
    readonly model?: string;
    readonly usedModelFallback?: boolean;
  };
  if (stored.triggeredAtIteration !== undefined && stored.status !== undefined) {
    return attempt;
  }

  const advised = stored.outcome === 'advice' && stored.advice !== undefined;
  return {
    schemaVersion: 1,
    triggeredAtIteration: stored.afterIteration ?? 0,
    blockerFingerprint: stored.blockerFingerprint ?? 'legacy-strategy',
    status: advised ? 'advised' : 'failed',
    diagnosis: advised ? 'Restored strategy advice from an earlier Wukong session.' : undefined,
    recommendedApproach: advised ? stored.advice : undefined,
    risks: advised ? [] : undefined,
    model: stored.model,
    usedModelFallback: stored.usedModelFallback ?? false,
  };
}
