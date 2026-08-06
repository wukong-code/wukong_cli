import { randomUUID } from 'node:crypto';

import {
  canonicalDigest,
  canonicalJson,
  containsInlineSecret,
  createFreshReviewerInputDigest,
  BUILTIN_RISK_SCAN_POLICY_VERSION,
  FINISH_LINE_WARNING_POLICY_VERSION,
  FRESH_REVIEWER_POLICY_VERSION,
  GATE_GUARD_POLICY_VERSION,
  NO_EXECUTABLE_CHECKS_POLICY_VERSION,
  REVIEW_SUBJECT_POLICY_VERSION,
  validateVerificationCriteriaSelection,
  validateFrozenGatePlan,
  type BrokerReviewTrustBindingV1,
  type FinishLineReview,
  type GateApprovalBinding,
  type FreshCriteriaVerdictV1,
  type GatePlan,
  type NoExecutableChecksDecisionV1,
  type ReviewSubjectManifestV1,
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

export interface LoopResultChangedFile {
  readonly path: string;
  readonly status: string;
  readonly attribution?: 'introduced_by_loop' | 'pre_existing_or_modified';
}

export interface WorkspaceChangeBaseline {
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
  }[];
}

export interface LoopResultEvidence {
  readonly verification: 'fresh' | 'not_run';
  readonly reviewer: 'fresh' | 'not_run';
  readonly completeness?: 'complete' | 'partial' | 'inconclusive';
  readonly fresh?: boolean;
  readonly expectedProducers?: readonly string[];
  readonly observedProducers?: readonly string[];
  readonly missingProducers?: readonly string[];
  readonly generatedAt?: string;
  readonly snapshotId?: string;
}

export interface ProviderOutcomeUnknown {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly turnId: string;
  readonly step: number;
  readonly attempt: number;
  readonly state: 'started' | 'outcome_unknown';
  readonly outputObserved: boolean;
  readonly errorName?: string;
  readonly errorMessage?: string;
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
  readonly noExecutableChecksDecision?: NoExecutableChecksDecisionV1;
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
  readonly noExecutableChecksDecision?: NoExecutableChecksDecisionV1;
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
  readonly noExecutableChecksDecision?: NoExecutableChecksDecisionV1;
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
  readonly noExecutableChecksDecision?: NoExecutableChecksDecisionV1;
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

export interface LoopRunReviewSettingsAssignedV1 {
  readonly schemaVersion: 1;
  readonly assignmentId: string;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly contractId: string;
  readonly supersedesRunSettingsRef?: string;
  readonly runSettingsRef: string;
  readonly runSettings: LoopRunSettingsV2;
  readonly createdAt: number;
}

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

export interface GateAttemptCreatedV2
  extends Omit<GateAttemptCreatedV1, 'schemaVersion'> {
  readonly schemaVersion: 2;
  readonly runSettingsRef: string;
  readonly runSettingsDigest: string;
  readonly brokerReviewTrustGrantId: string;
  readonly reviewSubjectConsentDigest: string;
}

export type GateAttemptCreated = GateAttemptCreatedV1 | GateAttemptCreatedV2;

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

export interface ReviewSubjectManifestRecordedV1 {
  readonly schemaVersion: 1;
  readonly manifestRef: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly manifest: ReviewSubjectManifestV1;
  readonly manifestDigest: string;
  readonly createdAt: number;
}

export interface FreshCriteriaVerdictRecordedV1 {
  readonly schemaVersion: 1;
  readonly verdictRef: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly reviewerInputDigest: string;
  readonly verdict: FreshCriteriaVerdictV1;
  readonly verdictDigest: string;
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

export interface ProofAggregateRecordedV2
  extends Omit<ProofAggregateRecordedV1, 'schemaVersion' | 'reviewerResultDigest'> {
  readonly schemaVersion: 2;
  readonly reviewSubjectManifestDigest: string;
  readonly freshCriteriaVerdictDigest: string;
  readonly reviewSubjectConsentDigest: string;
}

export type ProofAggregateRecorded = ProofAggregateRecordedV1 | ProofAggregateRecordedV2;

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

export interface LoopEvidenceSnapshotCreatedV2
  extends Omit<
    LoopEvidenceSnapshotCreatedV1,
    'schemaVersion' | 'reviewerResultRef' | 'reviewerResultDigest'
  > {
  readonly schemaVersion: 2;
  readonly reviewSubjectManifestRef: string;
  readonly reviewSubjectManifestDigest: string;
  readonly freshCriteriaVerdictRef: string;
  readonly freshCriteriaVerdictDigest: string;
  readonly reviewSubjectConsentDigest: string;
}

export type LoopEvidenceSnapshotCreated =
  | LoopEvidenceSnapshotCreatedV1
  | LoopEvidenceSnapshotCreatedV2;

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

export interface LoopGateDeterministicEvidenceInput {
  readonly runtime: LoopGateReviewRuntimeV2;
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
}

export interface LoopGateDeterministicEvidenceV1 {
  readonly attemptId: string;
  readonly orderedCheckResultDigests: readonly string[];
  readonly builtinRiskScanResultDigest: string;
  readonly unstableCheckIds: readonly string[];
}

export interface LoopGateAttemptInput {
  readonly runtime: LoopGateReviewRuntimeV2;
  readonly deterministicEvidence: LoopGateDeterministicEvidenceV1;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly reviewSubjectManifest?: ReviewSubjectManifestV1;
  readonly freshCriteriaVerdict?: FreshCriteriaVerdictV1;
  readonly reviewerInputDigest?: string;
  readonly blockerKeys: readonly string[];
  readonly workspaceTrustGrantId?: string;
}

export interface LoopGateReviewRuntimeV2 {
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly selectionDigest: string;
  readonly runSettingsRef: string;
  readonly runSettings: LoopRunSettingsV2;
  readonly workspaceIdentityDigest: string;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly criterionProvenanceDigest: string;
    readonly text: string;
    readonly evidenceExpectation?: string;
  }[];
  readonly carriedBlockerKeys: readonly string[];
  readonly reviewPolicy: ReviewPolicyBinding;
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
  readonly changedFiles?: readonly LoopResultChangedFile[];
  readonly evidence?: LoopResultEvidence;
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
  providerCallLimits: {
    writer?: number;
    reviewer?: number;
  };
  providerCalls: {
    writer: number;
    reviewer: number;
  };
  workspaceChangeBaseline?: WorkspaceChangeBaseline;
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
  loopRunReviewSettingsAssignments: Map<string, LoopRunReviewSettingsAssignedV1>;
  loopRunTerminals: Map<string, LoopRunTerminalV1>;
  gateAttemptCompletions: Map<string, GateAttemptCompletedV1>;
  restoredGateAudits: Map<string, RestoredGateAudit>;
  gateCheckHistory: GateCheckResultRecordedV1[];
  loopChainIterations: number;
  reviewHistory: LoopReviewAttempt[];
  strategyHistory: LoopStrategyAttempt[];
}

interface RestoredGateAudit {
  attempt: GateAttemptCreated;
  checks: GateCheckResultRecordedV1[];
  scan?: BuiltinRiskScanResultRecordedV1;
  reviewer?: ReviewerResultRecordedV1;
  manifest?: ReviewSubjectManifestRecordedV1;
  freshVerdict?: FreshCriteriaVerdictRecordedV1;
  aggregate?: ProofAggregateRecorded;
  snapshot?: LoopEvidenceSnapshotCreated;
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
  readonly providerUsage?: LoopProviderUsageReport;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  readonly loopResult?: LoopResult;
  readonly loopContract?: LoopContract;
  readonly legacyContractId?: string;
  readonly loopRunId?: string;
  readonly loopChainIterations?: number;
  /** Durable Gate attempts for the current run; distinct from writer iterations. */
  readonly gateAttempts?: number;
  readonly loopTerminal?: LoopRunTerminalV1;
  readonly providerOutcomeUnknown?: ProviderOutcomeUnknown;
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
  readonly writerProviderCallLimit?: number;
  readonly reviewerProviderCallLimit?: number;
  readonly tokenBudget?: number;
  readonly workspaceChangeBaseline?: WorkspaceChangeBaseline;
  readonly replace?: boolean;
  readonly loopContract?: LoopContractV2Input | LoopContractV3Input;
}

export type LoopProviderCallRole = 'writer' | 'reviewer';

export interface LoopProviderUsageReport {
  readonly writerCalls: number;
  readonly reviewerCalls: number;
  readonly writerCallLimit: number | null;
  readonly reviewerCallLimit: number | null;
  readonly remainingWriterCalls: number | null;
  readonly remainingReviewerCalls: number | null;
}

export class LoopProviderCallLimitError extends WukongError {
  readonly role: LoopProviderCallRole;
  readonly limit: number;

  constructor(role: LoopProviderCallRole, limit: number) {
    super(
      ErrorCodes.LOOP_PROVIDER_CALL_LIMIT,
      `${role} provider-call limit (${String(limit)}) reached before request send`,
      { details: { role, limit } },
    );
    this.name = 'LoopProviderCallLimitError';
    this.role = role;
    this.limit = limit;
  }
}

interface GoalReasonInput {
  readonly reason?: string;
}

export interface ResumeGoalInput extends GoalReasonInput {
  readonly reviewSettings?: LoopRunReviewSettingsInput;
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
      providerCallLimits: {
        writer: record.writerProviderCallLimit,
        reviewer: record.reviewerProviderCallLimit,
      },
      providerCalls: { writer: 0, reviewer: 0 },
      workspaceChangeBaseline: record.workspaceChangeBaseline,
      wallClockMs: 0,
      budgetLimits: record.tokenBudget === undefined
        ? {}
        : { tokenBudget: record.tokenBudget },
      loopRunReviewSettingsAssignments: new Map(),
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
    if (record.providerCalls !== undefined) state.providerCalls = record.providerCalls;
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
    for (const [name, value] of [
      ['writerProviderCallLimit', input.writerProviderCallLimit],
      ['reviewerProviderCallLimit', input.reviewerProviderCallLimit],
      ['tokenBudget', input.tokenBudget],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
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
      providerCallLimits: {
        writer: input.writerProviderCallLimit,
        reviewer: input.reviewerProviderCallLimit,
      },
      providerCalls: { writer: 0, reviewer: 0 },
      workspaceChangeBaseline: input.workspaceChangeBaseline,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: input.tokenBudget === undefined
        ? {}
        : { tokenBudget: input.tokenBudget },
      loopRunReviewSettingsAssignments: new Map(),
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
      writerProviderCallLimit: state.providerCallLimits.writer,
      reviewerProviderCallLimit: state.providerCallLimits.reviewer,
      tokenBudget: state.budgetLimits.tokenBudget,
      workspaceChangeBaseline: state.workspaceChangeBaseline,
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
      noExecutableChecksDecision: input.noExecutableChecksDecision,
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
      noExecutableChecksDecision: input.noExecutableChecksDecision,
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

  beginLoopGateAttempt(
    runtime: LoopGateReviewRuntimeV2,
    workspaceBefore: string,
  ): GateAttemptCreatedV2 {
    const state = this.requireState();
    const contract = state.loopContract;
    const run = state.currentLoopRun;
    const settingsBinding = run === undefined
      ? undefined
      : loopRunReviewSettingsBinding(state, run);
    if (
      contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || settingsBinding === undefined
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'A 0.0.20 Gate attempt requires a V2/V3 contract and brokered run settings',
      );
    }
    if (state.loopRunTerminals.has(run.runId)) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'Cannot append a Gate attempt after the current Loop run is terminal',
      );
    }
    if (
      runtime.runId !== run.runId
      || runtime.contractId !== contract.contractId
      || runtime.planDigest !== contract.gatePlan.planDigest
      || runtime.runSettingsRef !== settingsBinding.runSettingsRef
      || runtime.runSettings.settingsDigest !== settingsBinding.runSettings.settingsDigest
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Gate runtime is stale');
    }
    const existing = state.restoredGateAudits.get(runtime.attemptId);
    if (existing !== undefined) {
      if (
        existing.attempt.schemaVersion !== 2
        || existing.attempt.workspaceBefore !== workspaceBefore
      ) {
        throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Gate attempt id is already bound');
      }
      return existing.attempt;
    }
    const carriedBlockerSetDigest = canonicalDigest(
      'wukong/carried-blocker-set/v1',
      run.carriedBlockerKeys.toSorted(),
    );
    const base = {
      schemaVersion: 2 as const,
      attemptId: runtime.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      sequence: state.restoredGateAudits.size + 1,
      planDigest: runtime.planDigest,
      gateApprovalDigest: contract.gateApproval.approvalSetDigest,
      workspaceBefore,
      carriedBlockerSetDigest,
      runSettingsRef: settingsBinding.runSettingsRef,
      runSettingsDigest: settingsBinding.runSettings.settingsDigest,
      brokerReviewTrustGrantId: settingsBinding.runSettings.brokerReviewTrust.trustGrantId,
      reviewSubjectConsentDigest:
        settingsBinding.runSettings.reviewSubjectConsent.consentDigest,
      createdAt: Date.now(),
    };
    const attempt: GateAttemptCreatedV2 = {
      ...base,
      attemptDigest: canonicalDigest('wukong/gate-attempt/v2', base),
    };
    state.restoredGateAudits.set(attempt.attemptId, { attempt, checks: [] });
    this.agent.records.logRecord({ type: 'loop.gate-attempt.create', attempt });
    this.persistState(state, { silent: true });
    return attempt;
  }

  recordGateDeterministicEvidence(
    input: LoopGateDeterministicEvidenceInput,
  ): LoopGateDeterministicEvidenceV1 {
    const state = this.requireState();
    const contract = state.loopContract;
    const run = state.currentLoopRun;
    const settingsBinding = run === undefined
      ? undefined
      : loopRunReviewSettingsBinding(state, run);
    if (
      contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || settingsBinding === undefined
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Brokered Gate run is unavailable');
    }
    const audit = state.restoredGateAudits.get(input.runtime.attemptId);
    if (
      audit?.attempt.schemaVersion !== 2
      || audit.attempt.runId !== run.runId
      || audit.attempt.contractId !== contract.contractId
      || audit.attempt.planDigest !== input.runtime.planDigest
      || audit.attempt.runSettingsRef !== settingsBinding.runSettingsRef
      || audit.attempt.runSettingsDigest !== settingsBinding.runSettings.settingsDigest
      || audit.attempt.workspaceBefore !== input.workspaceFingerprint
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Gate attempt runtime binding mismatch');
    }
    if (audit.checks.length > 0 || audit.scan !== undefined) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Gate attempt evidence was already recorded');
    }
    const now = Date.now();
    const gatePlan = contract.schemaVersion === 2
      ? contract.gatePlan
      : contract.gatePlan.legacySnapshot;
    const checkResults: GateCheckResultRecordedV1[] = [];
    for (let index = 0; index < gatePlan.requiredChecks.length; index += 1) {
      const frozen = gatePlan.requiredChecks[index]!;
      const observed = input.checks[index];
      const base = {
        schemaVersion: 1 as const,
        checkResultRef: randomUUID(),
        attemptId: audit.attempt.attemptId,
        runId: run.runId,
        contractId: contract.contractId,
        planDigest: input.runtime.planDigest,
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
      const result: GateCheckResultRecordedV1 = {
        ...base,
        checkResultDigest: canonicalDigest('wukong/gate-check-result/v1', base),
      };
      checkResults.push(result);
      audit.checks.push(result);
      this.agent.records.logRecord({ type: 'loop.gate-check-result.create', result });
    }
    const unstableCheckIds = checkResults
      .filter((current) => state.gateCheckHistory.some((prior) => (
        prior.workspaceFingerprint === current.workspaceFingerprint
        && prior.checkId === current.checkId
        && prior.commandDigest === current.commandDigest
        && (prior.status === 'passed') !== (current.status === 'passed')
      )))
      .map((current) => current.checkId);
    state.gateCheckHistory.push(...checkResults);

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
      attemptId: audit.attempt.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: input.runtime.planDigest,
      scanPolicyVersion: gatePlan.builtinRiskScanPolicyVersion,
      workspaceFingerprint: audit.attempt.workspaceBefore,
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
    audit.scan = scan;
    this.agent.records.logRecord({ type: 'loop.builtin-risk-scan-result.create', result: scan });
    const deterministicEvidence: LoopGateDeterministicEvidenceV1 = {
      attemptId: audit.attempt.attemptId,
      orderedCheckResultDigests: checkResults.map((result) => result.checkResultDigest),
      builtinRiskScanResultDigest: scan.scanResultDigest,
      unstableCheckIds,
    };
    this.persistState(state, { silent: true });
    return deterministicEvidence;
  }

  recordGateAttempt(input: LoopGateAttemptInput): GateAttemptCompletedV1 | null {
    const state = this.requireState();
    const contract = state.loopContract;
    const run = state.currentLoopRun;
    const settingsBinding = run === undefined
      ? undefined
      : loopRunReviewSettingsBinding(state, run);
    if (
      contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || settingsBinding === undefined
    ) {
      return null;
    }
    const existingCompletion = state.gateAttemptCompletions.get(input.runtime.attemptId);
    if (existingCompletion !== undefined) return existingCompletion;
    const audit = state.restoredGateAudits.get(input.runtime.attemptId);
    if (
      audit?.attempt.schemaVersion !== 2
      || audit.attempt.runId !== run.runId
      || audit.attempt.contractId !== contract.contractId
      || audit.attempt.planDigest !== input.runtime.planDigest
      || audit.attempt.runSettingsRef !== settingsBinding.runSettingsRef
      || audit.attempt.runSettingsDigest !== settingsBinding.runSettings.settingsDigest
      || audit.scan === undefined
      || input.deterministicEvidence.attemptId !== audit.attempt.attemptId
      || canonicalJson(input.deterministicEvidence.orderedCheckResultDigests)
        !== canonicalJson(audit.checks.map((result) => result.checkResultDigest))
      || input.deterministicEvidence.builtinRiskScanResultDigest !== audit.scan.scanResultDigest
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Gate deterministic evidence binding mismatch');
    }
    const now = Date.now();
    const checkResults = audit.checks;
    const scan = audit.scan;
    const unstableCheckIds = [...input.deterministicEvidence.unstableCheckIds];
    const gatePlan = contract.schemaVersion === 2
      ? contract.gatePlan
      : contract.gatePlan.legacySnapshot;
    const manifest = input.reviewSubjectManifest;
    const reviewerInputDigest = input.reviewerInputDigest;
    if (manifest === undefined || reviewerInputDigest === undefined) {
      this.persistState(state, { silent: true });
      return null;
    }
    if (
      manifest.attemptId !== audit.attempt.attemptId
      || manifest.runId !== run.runId
      || manifest.contractId !== contract.contractId
      || manifest.planDigest !== input.runtime.planDigest
      || manifest.workspaceFingerprint !== audit.attempt.workspaceBefore
      || manifest.consentDigest
        !== settingsBinding.runSettings.reviewSubjectConsent.consentDigest
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Review subject manifest binding mismatch');
    }
    const manifestRecord: ReviewSubjectManifestRecordedV1 = {
      schemaVersion: 1,
      manifestRef: randomUUID(),
      attemptId: audit.attempt.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: input.runtime.planDigest,
      manifest,
      manifestDigest: manifest.manifestDigest,
      createdAt: now,
    };
    audit.manifest = manifestRecord;
    this.agent.records.logRecord({
      type: 'loop.review-subject-manifest.create',
      result: manifestRecord,
    });

    const verdict = input.freshCriteriaVerdict;
    if (verdict === undefined) {
      this.persistState(state, { silent: true });
      return null;
    }
    if (
      verdict.attemptId !== audit.attempt.attemptId
      || verdict.reviewerInputDigest !== reviewerInputDigest
      || reviewerInputDigest !== freshReviewerInputDigestForAudit(state, audit)
    ) {
      throw new WukongError(ErrorCodes.REQUEST_INVALID, 'Fresh verdict binding mismatch');
    }
    const verdictRecord: FreshCriteriaVerdictRecordedV1 = {
      schemaVersion: 1,
      verdictRef: randomUUID(),
      attemptId: audit.attempt.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: input.runtime.planDigest,
      reviewerInputDigest,
      verdict,
      verdictDigest: canonicalDigest('wukong/fresh-criteria-verdict/v1', verdict),
      createdAt: now,
    };
    audit.freshVerdict = verdictRecord;
    this.agent.records.logRecord({
      type: 'loop.fresh-criteria-verdict.create',
      result: verdictRecord,
    });

    const allChecksPassed = checkResults.length === gatePlan.requiredChecks.length
      && checkResults.every((result) => result.status === 'passed');
    const criteriaSatisfied = input.runtime.criteria.every((criterion) => (
      verdict.criterionDispositions.some((disposition) => (
        disposition.criterionId === criterion.criterionId
        && disposition.criterionProvenanceDigest === criterion.criterionProvenanceDigest
        && disposition.status === 'satisfied'
      ))
    ));
    const carriedBlockersResolved = input.runtime.carriedBlockerKeys.every((key) => (
      verdict.priorBlockerDispositions.some((disposition) => (
        disposition.blockerKey === key && disposition.status === 'resolved'
      ))
    ));
    const noBlockingFindings = verdict.findings.every(
      (finding) => finding.severity !== 'blocking',
    );
    const canPass = input.status === 'PASS'
      && allChecksPassed
      && scan.status === 'clean'
      && verdict.status === 'PASS'
      && criteriaSatisfied
      && carriedBlockersResolved
      && noBlockingFindings
      && unstableCheckIds.length === 0
      && input.blockerKeys.length === 0;
    const aggregateStatus: ProofAggregateRecordedV2['status'] = canPass
      ? 'PASS'
      : input.status === 'ERROR' || unstableCheckIds.length > 0
        ? 'ERROR'
        : 'NEEDS_WORK';
    const aggregateBase = {
      schemaVersion: 2 as const,
      proofAggregateResultRef: randomUUID(),
      attemptId: audit.attempt.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: input.runtime.planDigest,
      orderedCheckResultDigests: checkResults.map((result) => result.checkResultDigest),
      builtinRiskScanResultRef: scan.scanResultRef,
      builtinRiskScanResultDigest: scan.scanResultDigest,
      builtinRiskScanPolicyVersion: scan.scanPolicyVersion,
      reviewSubjectManifestDigest: manifestRecord.manifestDigest,
      freshCriteriaVerdictDigest: verdictRecord.verdictDigest,
      reviewSubjectConsentDigest:
        settingsBinding.runSettings.reviewSubjectConsent.consentDigest,
      carriedBlockerSetDigest: audit.attempt.carriedBlockerSetDigest,
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
    const aggregate: ProofAggregateRecordedV2 = {
      ...aggregateBase,
      proofAggregateDigest: canonicalDigest('wukong/proof-aggregate/v2', aggregateBase),
    };
    audit.aggregate = aggregate;
    this.agent.records.logRecord({ type: 'loop.proof-aggregate.create', result: aggregate });

    const snapshotBase = {
      schemaVersion: 2 as const,
      evidenceSnapshotId: randomUUID(),
      attemptId: audit.attempt.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: input.runtime.planDigest,
      gateApprovalDigest: contract.gateApproval.approvalSetDigest,
      workspaceTrustGrantId: input.workspaceTrustGrantId
        ?? (contract.schemaVersion === 2 ? contract.workspaceTrust?.trustGrantId : undefined),
      workspaceFingerprint: audit.attempt.workspaceBefore,
      orderedCheckResults: checkResults.map((result) => ({
        checkId: result.checkId,
        resultRef: result.checkResultRef,
        resultDigest: result.checkResultDigest,
        status: result.status,
      })),
      reviewSubjectManifestRef: manifestRecord.manifestRef,
      reviewSubjectManifestDigest: manifestRecord.manifestDigest,
      freshCriteriaVerdictRef: verdictRecord.verdictRef,
      freshCriteriaVerdictDigest: verdictRecord.verdictDigest,
      builtinRiskScanResultRef: scan.scanResultRef,
      builtinRiskScanResultDigest: scan.scanResultDigest,
      builtinRiskScanPolicyVersion: scan.scanPolicyVersion,
      proofAggregateResultRef: aggregate.proofAggregateResultRef,
      proofAggregateDigest: aggregate.proofAggregateDigest,
      reviewSubjectConsentDigest:
        settingsBinding.runSettings.reviewSubjectConsent.consentDigest,
      createdAt: now,
    };
    const snapshot: LoopEvidenceSnapshotCreatedV2 = {
      ...snapshotBase,
      evidenceDigest: canonicalDigest('wukong/loop-evidence-snapshot/v2', snapshotBase),
    };
    audit.snapshot = snapshot;
    this.agent.records.logRecord({ type: 'loop.evidence-snapshot.create', snapshot });

    const completedBase = {
      schemaVersion: 1 as const,
      attemptId: audit.attempt.attemptId,
      runId: run.runId,
      contractId: contract.contractId,
      planDigest: input.runtime.planDigest,
      gateApprovalDigest: contract.gateApproval.approvalSetDigest,
      sequence: audit.attempt.sequence,
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
    state.gateAttemptCompletions.set(completed.attemptId, completed);
    this.agent.records.logRecord({ type: 'loop.gate-attempt.complete', attempt: completed });
    this.persistState(state, { silent: true });
    return completed;
  }

  createLoopGateReviewRuntime(): LoopGateReviewRuntimeV2 | null {
    const state = this.state;
    const contract = state?.loopContract;
    const run = state?.currentLoopRun;
    const settingsBinding = state === undefined || run === undefined
      ? undefined
      : loopRunReviewSettingsBinding(state, run);
    if (
      state === undefined
      || contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || settingsBinding === undefined
      || state.loopRunTerminals.has(run.runId)
    ) {
      return null;
    }
    const planDigest = contract.gatePlan.planDigest;
    const criteria = contract.schemaVersion === 3
      ? contract.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          criterionProvenanceDigest: criterion.criterionProvenanceDigest,
          text: criterion.text,
          ...(criterion.evidenceExpectation === undefined
            ? {}
            : { evidenceExpectation: criterion.evidenceExpectation }),
        }))
      : contract.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        criterionProvenanceDigest: canonicalDigest(
          'wukong/legacy-criterion-provenance/v1',
          {
            contractId: contract.contractId,
            id: criterion.id,
            text: criterion.text,
            source: criterion.source,
          },
        ),
        text: criterion.text,
      }));
    return {
      attemptId: randomUUID(),
      runId: run.runId,
      contractId: contract.contractId,
      planDigest,
      selectionDigest: contract.schemaVersion === 3
        ? contract.verificationCriteria.selectionDigest
        : canonicalDigest('wukong/verification-selection/none/v1', {
            contractId: contract.contractId,
          }),
      runSettingsRef: settingsBinding.runSettingsRef,
      runSettings: settingsBinding.runSettings,
      workspaceIdentityDigest: contract.workspaceIdentity.workspaceIdentityDigest,
      criteria,
      carriedBlockerKeys: run.carriedBlockerKeys,
      reviewPolicy: contract.reviewPolicy,
    };
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
    if (
      state === undefined
      || (contract?.schemaVersion !== 2 && contract?.schemaVersion !== 3)
      || run === undefined
    ) return null;
    const existing = state.loopRunTerminals.get(run.runId);
    if (existing !== undefined) return existing;
    if (
      input.attempt !== undefined
      && input.attempt !== null
      && (
        input.attempt.runId !== run.runId
        || input.attempt.contractId !== contract.contractId
        || input.attempt.status !== input.status
        || state.gateAttemptCompletions.get(input.attempt.attemptId)?.resultDigest
          !== input.attempt.resultDigest
      )
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'Loop terminal attempt is not bound to the current run and contract.',
      );
    }
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
    const digestNamespace = record.run.schemaVersion === 2
      ? 'wukong/loop-run/v2'
      : 'wukong/loop-run/v1';
    if (canonicalDigest(digestNamespace, base) !== runDigest) {
      throw new Error('Loop record replay failed: run digest mismatch');
    }
    if (record.run.schemaVersion === 2) {
      const { settingsDigest, ...settingsBase } = record.run.runSettings;
      if (
        canonicalDigest('wukong/loop-run-settings/v2', settingsBase) !== settingsDigest
        || record.run.runSettingsRef.length === 0
      ) {
        throw new Error('Loop record replay failed: run settings digest mismatch');
      }
    }
    if (state.currentLoopRun?.runId !== record.run.runId) state.loopResult = undefined;
    state.currentLoopRun = record.run;
  }

  restoreLoopRunReviewSettingsAssignment(
    record: AgentRecordOf<'loop.run-review-settings.assign'>,
  ): void {
    const state = this.state;
    const contract = state?.loopContract;
    const run = state?.currentLoopRun;
    if (
      state === undefined
      || contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || run.runId !== record.assignment.runId
      || contract.contractId !== record.assignment.contractId
    ) {
      throw new Error('Loop record replay failed: review settings assignment binding mismatch');
    }
    const previous = loopRunReviewSettingsBinding(state, run);
    if (record.assignment.supersedesRunSettingsRef !== previous?.runSettingsRef) {
      throw new Error('Loop record replay failed: review settings assignment is stale');
    }
    const { settingsDigest, ...settingsBase } = record.assignment.runSettings;
    const expectedIdempotencyKey = reviewSettingsAssignmentIdempotencyKey({
      run,
      previousRunSettingsRef: previous?.runSettingsRef,
      reviewSettings: {
        brokerReviewTrust: record.assignment.runSettings.brokerReviewTrust,
        reviewSubjectConsent: record.assignment.runSettings.reviewSubjectConsent,
      },
    });
    if (
      canonicalDigest('wukong/loop-run-settings/v2', settingsBase) !== settingsDigest
      || expectedIdempotencyKey !== record.assignment.idempotencyKey
    ) {
      throw new Error('Loop record replay failed: review settings assignment digest mismatch');
    }
    validateLoopRunReviewSettings(contract, {
      brokerReviewTrust: record.assignment.runSettings.brokerReviewTrust,
      reviewSubjectConsent: record.assignment.runSettings.reviewSubjectConsent,
    });
    state.loopRunReviewSettingsAssignments.set(run.runId, record.assignment);
  }

  restoreLoopRunTerminal(record: AgentRecordOf<'loop.run.terminal'>): void {
    const state = this.state;
    if (state === undefined) return;
    const contract = state.loopContract;
    const run = state.currentLoopRun;
    const { terminalDigest, ...base } = record.terminal;
    if (canonicalDigest('wukong/loop-terminal/v1', base) !== terminalDigest) {
      throw new Error('Loop record replay failed: terminal digest mismatch');
    }
    if (
      contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || record.terminal.runId !== run.runId
      || record.terminal.contractId !== contract.contractId
    ) {
      throw new Error('Loop record replay failed: terminal binding mismatch');
    }
    const attempt = record.terminal.terminalAttemptId === undefined
      ? undefined
      : state.gateAttemptCompletions.get(record.terminal.terminalAttemptId);
    if (
      record.terminal.terminalAttemptId !== undefined
      && attempt === undefined
    ) {
      throw new Error('Loop record replay failed: terminal attempt is missing');
    }
    if (
      record.terminal.status === 'PASS'
      && attempt === undefined
    ) {
      throw new Error('Loop record replay failed: PASS terminal lacks a complete PASS attempt');
    }
    if (
      attempt !== undefined
      && (
        attempt.runId !== record.terminal.runId
        || attempt.contractId !== record.terminal.contractId
        || attempt.status !== record.terminal.status
        || attempt.resultDigest !== record.terminal.attemptResultDigest
      )
    ) {
      throw new Error('Loop record replay failed: terminal attempt binding mismatch');
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
    | 'loop.review-subject-manifest.create'
    | 'loop.fresh-criteria-verdict.create'
    | 'loop.proof-aggregate.create'
    | 'loop.evidence-snapshot.create'
    | 'loop.continuation.create'
  >): void {
    const state = this.state;
    if (state === undefined) return;
    restoreGateAuditRecord(state, record);
  }

  private assignLoopRunReviewSettings(
    state: GoalState,
    contract: LoopContractV2 | LoopContractV3,
    run: LoopRunCreated,
    reviewSettings: LoopRunReviewSettingsInput,
  ): LoopRunReviewSettingsAssignedV1 {
    validateLoopRunReviewSettings(contract, reviewSettings);
    const existing = state.loopRunReviewSettingsAssignments.get(run.runId);
    if (
      existing !== undefined
      && existing.runSettings.brokerReviewTrust.trustProposalDigest
        === reviewSettings.brokerReviewTrust.trustProposalDigest
      && existing.runSettings.reviewSubjectConsent.consentProposalDigest
        === reviewSettings.reviewSubjectConsent.consentProposalDigest
    ) {
      return existing;
    }
    const previous = loopRunReviewSettingsBinding(state, run);
    const idempotencyKey = reviewSettingsAssignmentIdempotencyKey({
      run,
      previousRunSettingsRef: previous?.runSettingsRef,
      reviewSettings,
    });
    const legacy = run.schemaVersion === 2 ? run.runSettings.legacy : run.runSettings;
    const legacySettingsDigest = canonicalDigest(
      'wukong/loop-run-settings/legacy/v1',
      legacy,
    );
    const settingsBase = {
      schemaVersion: 2 as const,
      legacy,
      legacySettingsDigest,
      brokerReviewTrust: reviewSettings.brokerReviewTrust,
      reviewSubjectConsent: reviewSettings.reviewSubjectConsent,
    };
    const assignment: LoopRunReviewSettingsAssignedV1 = {
      schemaVersion: 1,
      assignmentId: randomUUID(),
      idempotencyKey,
      runId: run.runId,
      contractId: contract.contractId,
      supersedesRunSettingsRef: previous?.runSettingsRef,
      runSettingsRef: randomUUID(),
      runSettings: {
        ...settingsBase,
        settingsDigest: canonicalDigest('wukong/loop-run-settings/v2', settingsBase),
      },
      createdAt: Date.now(),
    };
    state.loopRunReviewSettingsAssignments.set(run.runId, assignment);
    this.agent.records.logRecord({
      type: 'loop.run-review-settings.assign',
      assignment,
    });
    return assignment;
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

  async resumeGoal(input: ResumeGoalInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
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
    input: ResumeGoalInput,
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
    const providerOutcomeUnknown = this.providerOutcomeUnknown(state);
    if (state.stopCondition !== undefined && providerOutcomeUnknown !== undefined) {
      throw new WukongError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Provider request outcome is unknown (request ${providerOutcomeUnknown.requestId}, idempotency key ${providerOutcomeUnknown.idempotencyKey}). Blind resume is disabled; reconcile the provider result first or cancel and explicitly start a new Loop.`,
      );
    }
    const terminal = currentRun === undefined
      ? undefined
      : state.loopRunTerminals.get(currentRun.runId);
    if (
      (contract?.schemaVersion === 2 || contract?.schemaVersion === 3)
      && currentRun !== undefined
      && terminal === undefined
    ) {
      if (input.reviewSettings !== undefined) {
        this.assignLoopRunReviewSettings(
          state,
          contract,
          currentRun,
          input.reviewSettings,
        );
      } else if (loopRunReviewSettingsBinding(state, currentRun) === undefined) {
        throw new WukongError(
          ErrorCodes.GOAL_NOT_RESUMABLE,
          'This legacy Loop run requires fresh broker trust and provider consent before resume.',
        );
      }
    }
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
      if (input.reviewSettings === undefined) {
        throw new WukongError(
          ErrorCodes.GOAL_NOT_RESUMABLE,
          'Loop continuation requires fresh broker trust and provider consent.',
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
        input.reviewSettings,
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
      state.loopResult = undefined;
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
      (state.loopContract?.schemaVersion === 2 || state.loopContract?.schemaVersion === 3)
      && state.currentLoopRun !== undefined
      && !state.loopRunTerminals.has(state.currentLoopRun.runId)
    ) {
      this.recordLoopTerminal({
        status: 'NEEDS_WORK',
        reasonCode: blockedReasonCode(input.reason, actor),
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
      (state.loopContract?.schemaVersion === 2 || state.loopContract?.schemaVersion === 3)
      && (
        state.currentLoopRun === undefined
        || state.loopRunTerminals.get(state.currentLoopRun.runId)?.status !== 'PASS'
      )
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'A durable Loop cannot complete without a PASS terminal.',
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

  async reserveProviderCall(role: LoopProviderCallRole): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    if (state.stopCondition === undefined && state.providerCallLimits[role] === undefined) {
      return this.toSnapshot(state);
    }
    const limit = state.providerCallLimits[role];
    const used = state.providerCalls[role];
    if (limit !== undefined && used >= limit) {
      throw new LoopProviderCallLimitError(role, limit);
    }
    state.providerCalls = {
      ...state.providerCalls,
      [role]: used + 1,
    };
    this.persistState(state, { silent: true });
    this.appendGoalUpdate({ providerCalls: state.providerCalls });
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
      ...(result.changedFiles === undefined
        ? {}
        : {
            changedFiles: attributeChangedFiles(
              result.changedFiles,
              state.workspaceChangeBaseline,
            ),
          }),
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

  private providerOutcomeUnknown(state: GoalState): ProviderOutcomeUnknown | undefined {
    const context = (this.agent as unknown as {
      context?: {
        unresolvedProviderRequestsFor?: (
          goalId: string,
          loopRunId: string | undefined,
        ) => ReadonlyArray<{
          readonly requestId: string;
          readonly idempotencyKey: string;
          readonly turnId: string;
          readonly step: number;
          readonly attempt: number;
          readonly state: 'started' | 'outcome_unknown';
          readonly outputObserved?: boolean;
          readonly errorName?: string;
          readonly errorMessage?: string;
        }>;
      };
    }).context;
    const lookup = context?.unresolvedProviderRequestsFor;
    const request = lookup?.call(
      context,
      state.goalId,
      state.currentLoopRun?.runId,
    ).at(-1);
    if (request === undefined) return undefined;
    return {
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      turnId: request.turnId,
      step: request.step,
      attempt: request.attempt,
      state: request.state,
      outputObserved: request.outputObserved === true,
      ...(request.errorName === undefined ? {} : { errorName: request.errorName }),
      ...(request.errorMessage === undefined ? {} : { errorMessage: request.errorMessage }),
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
      providerUsage: providerUsageReport(state),
      wallClockMs: liveWallClockMs(state, Date.now()),
      budget: computeBudgetReport(state, Date.now()),
      terminalReason: state.terminalReason,
      loopResult: state.loopResult,
      loopContract: state.loopContract,
      legacyContractId: state.legacyContractId,
      loopRunId: state.currentLoopRun?.runId,
      loopChainIterations: state.loopChainIterations,
      gateAttempts: state.currentLoopRun === undefined
        ? 0
        : [...state.gateAttemptCompletions.values()].filter(
            (attempt) => attempt.runId === state.currentLoopRun?.runId,
          ).length,
      loopTerminal: state.currentLoopRun === undefined
        ? undefined
        : state.loopRunTerminals.get(state.currentLoopRun.runId),
      providerOutcomeUnknown: this.providerOutcomeUnknown(state),
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
    | 'loop.review-subject-manifest.create'
    | 'loop.fresh-criteria-verdict.create'
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
    const digestNamespace = record.attempt.schemaVersion === 2
      ? 'wukong/gate-attempt/v2'
      : 'wukong/gate-attempt/v1';
    if (canonicalDigest(digestNamespace, base) !== attemptDigest) {
      throw new Error('Loop record replay failed: Gate attempt digest mismatch');
    }
    const contract = state.loopContract;
    const run = state.currentLoopRun;
    const existingAudit = state.restoredGateAudits.get(record.attempt.attemptId);
    if (existingAudit !== undefined) {
      if (canonicalJson(existingAudit.attempt) === canonicalJson(record.attempt)) return;
      throw new Error('Loop record replay failed: conflicting duplicate Gate attempt');
    }
    if (
      contract === undefined
      || contract.schemaVersion === 1
      || run === undefined
      || run.runId !== record.attempt.runId
      || contract.contractId !== record.attempt.contractId
      || contract.gatePlan.planDigest !== record.attempt.planDigest
      || contract.gateApproval.approvalSetDigest !== record.attempt.gateApprovalDigest
    ) {
      throw new Error('Loop record replay failed: Gate attempt binding mismatch');
    }
    const settingsBinding = loopRunReviewSettingsBinding(state, run);
    if (
      record.attempt.schemaVersion === 2
      && (
        settingsBinding === undefined
        || record.attempt.runSettingsRef !== settingsBinding.runSettingsRef
        || record.attempt.runSettingsDigest !== settingsBinding.runSettings.settingsDigest
        || record.attempt.brokerReviewTrustGrantId
          !== settingsBinding.runSettings.brokerReviewTrust.trustGrantId
        || record.attempt.reviewSubjectConsentDigest
          !== settingsBinding.runSettings.reviewSubjectConsent.consentDigest
      )
    ) {
      throw new Error('Loop record replay failed: Gate run settings binding mismatch');
    }
    if (record.attempt.schemaVersion === 1 && contract.schemaVersion !== 2) {
      throw new Error('Loop record replay failed: legacy Gate attempt cannot bind a V3 contract');
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
  if (isExactGateAuditDuplicate(audit, record)) return;
  if (state.gateAttemptCompletions.has(payload.attemptId)) {
    throw new Error('Loop record replay failed: late producer after Gate completion');
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
      if (audit.attempt.schemaVersion !== 1) {
        throw new Error('Loop record replay failed: legacy reviewer record on V2 attempt');
      }
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
    case 'loop.review-subject-manifest.create': {
      if (
        audit.attempt.schemaVersion !== 2
        || audit.manifest !== undefined
        || audit.scan === undefined
      ) {
        throw new Error('Loop record replay failed: review manifest ordering mismatch');
      }
      const { manifestDigest, ...manifestBase } = record.result.manifest;
      if (
        record.result.manifestDigest !== manifestDigest
        || canonicalDigest('wukong/review-subject-manifest/v1', manifestBase) !== manifestDigest
        || record.result.manifest.attemptId !== record.result.attemptId
        || record.result.manifest.runId !== record.result.runId
        || record.result.manifest.contractId !== record.result.contractId
        || record.result.manifest.planDigest !== record.result.planDigest
        || record.result.manifest.consentDigest !== audit.attempt.reviewSubjectConsentDigest
      ) {
        throw new Error('Loop record replay failed: review manifest digest mismatch');
      }
      audit.manifest = record.result;
      return;
    }
    case 'loop.fresh-criteria-verdict.create': {
      if (
        audit.attempt.schemaVersion !== 2
        || audit.manifest === undefined
        || audit.freshVerdict !== undefined
        || record.result.verdict.attemptId !== record.result.attemptId
        || record.result.verdict.reviewerInputDigest !== record.result.reviewerInputDigest
        || record.result.reviewerInputDigest !== freshReviewerInputDigestForAudit(state, audit)
        || canonicalDigest('wukong/fresh-criteria-verdict/v1', record.result.verdict)
          !== record.result.verdictDigest
      ) {
        throw new Error('Loop record replay failed: fresh verdict mismatch');
      }
      audit.freshVerdict = record.result;
      return;
    }
    case 'loop.proof-aggregate.create': {
      const { proofAggregateDigest, ...base } = record.result;
      const digestNamespace = record.result.schemaVersion === 2
        ? 'wukong/proof-aggregate/v2'
        : 'wukong/proof-aggregate/v1';
      if (
        audit.aggregate !== undefined
        || canonicalDigest(digestNamespace, base) !== proofAggregateDigest
      ) {
        throw new Error('Loop record replay failed: proof aggregate mismatch');
      }
      if (
        record.result.schemaVersion === 2
        && (
          audit.attempt.schemaVersion !== 2
          || audit.manifest === undefined
          || audit.freshVerdict === undefined
          || record.result.reviewSubjectManifestDigest !== audit.manifest.manifestDigest
          || record.result.freshCriteriaVerdictDigest !== audit.freshVerdict.verdictDigest
          || record.result.reviewSubjectConsentDigest
            !== audit.attempt.reviewSubjectConsentDigest
        )
      ) {
        throw new Error('Loop record replay failed: proof aggregate broker join mismatch');
      }
      if (record.result.schemaVersion === 1 && audit.attempt.schemaVersion !== 1) {
        throw new Error('Loop record replay failed: legacy proof aggregate on V2 attempt');
      }
      audit.aggregate = record.result;
      return;
    }
    case 'loop.evidence-snapshot.create': {
      const { evidenceDigest, ...base } = record.snapshot;
      const digestNamespace = record.snapshot.schemaVersion === 2
        ? 'wukong/loop-evidence-snapshot/v2'
        : 'wukong/loop-evidence-snapshot/v1';
      if (
        audit.snapshot !== undefined
        || audit.aggregate === undefined
        || canonicalDigest(digestNamespace, base) !== evidenceDigest
      ) {
        throw new Error('Loop record replay failed: evidence snapshot mismatch');
      }
      if (
        record.snapshot.schemaVersion === 2
        && (
          audit.attempt.schemaVersion !== 2
          || audit.manifest === undefined
          || audit.freshVerdict === undefined
          || record.snapshot.reviewSubjectManifestRef !== audit.manifest.manifestRef
          || record.snapshot.reviewSubjectManifestDigest !== audit.manifest.manifestDigest
          || record.snapshot.freshCriteriaVerdictRef !== audit.freshVerdict.verdictRef
          || record.snapshot.freshCriteriaVerdictDigest !== audit.freshVerdict.verdictDigest
          || record.snapshot.reviewSubjectConsentDigest
            !== audit.attempt.reviewSubjectConsentDigest
        )
      ) {
        throw new Error('Loop record replay failed: evidence snapshot broker join mismatch');
      }
      if (record.snapshot.schemaVersion === 1 && audit.attempt.schemaVersion !== 1) {
        throw new Error('Loop record replay failed: legacy evidence snapshot on V2 attempt');
      }
      audit.snapshot = record.snapshot;
      return;
    }
  }
}

function isExactGateAuditDuplicate(
  audit: RestoredGateAudit,
  record: AgentRecordOf<
    | 'loop.gate-check-result.create'
    | 'loop.builtin-risk-scan-result.create'
    | 'loop.reviewer-result.create'
    | 'loop.review-subject-manifest.create'
    | 'loop.fresh-criteria-verdict.create'
    | 'loop.proof-aggregate.create'
    | 'loop.evidence-snapshot.create'
  >,
): boolean {
  switch (record.type) {
    case 'loop.gate-check-result.create':
      return audit.checks.some(
        (existing) => existing.checkResultDigest === record.result.checkResultDigest,
      );
    case 'loop.builtin-risk-scan-result.create':
      return audit.scan?.scanResultDigest === record.result.scanResultDigest;
    case 'loop.reviewer-result.create':
      return audit.reviewer?.reviewerResultDigest === record.result.reviewerResultDigest;
    case 'loop.review-subject-manifest.create':
      return audit.manifest?.manifestDigest === record.result.manifestDigest;
    case 'loop.fresh-criteria-verdict.create':
      return audit.freshVerdict?.verdictDigest === record.result.verdictDigest;
    case 'loop.proof-aggregate.create':
      return audit.aggregate?.proofAggregateDigest === record.result.proofAggregateDigest;
    case 'loop.evidence-snapshot.create':
      return audit.snapshot?.evidenceDigest === record.snapshot.evidenceDigest;
  }
}

function freshReviewerInputDigestForAudit(
  state: GoalState,
  audit: RestoredGateAudit,
): string | undefined {
  const contract = state.loopContract;
  const run = state.currentLoopRun;
  const settingsBinding = run === undefined
    ? undefined
    : loopRunReviewSettingsBinding(state, run);
  if (
    audit.attempt.schemaVersion !== 2
    || audit.manifest === undefined
    || contract === undefined
    || contract.schemaVersion === 1
    || run === undefined
    || settingsBinding === undefined
    || run.runId !== audit.attempt.runId
  ) {
    return undefined;
  }
  const selectionDigest = contract.schemaVersion === 3
    ? contract.verificationCriteria.selectionDigest
    : canonicalDigest('wukong/verification-selection/none/v1', {
        contractId: contract.contractId,
      });
  return createFreshReviewerInputDigest({
    attemptId: audit.attempt.attemptId,
    contractId: audit.attempt.contractId,
    planDigest: audit.attempt.planDigest,
    selectionDigest,
    subjectManifestDigest: audit.manifest.manifestDigest,
    orderedCheckResultDigests: audit.checks.map((result) => result.checkResultDigest),
    priorBlockerSetDigest: audit.attempt.carriedBlockerSetDigest,
    reviewPolicyDigest: canonicalDigest(
      'wukong/fresh-review-policy-binding/v1',
      contract.reviewPolicy,
    ),
    consentDigest: audit.attempt.reviewSubjectConsentDigest,
  });
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
    || contract === undefined
    || contract.schemaVersion === 1
    || audit.scan === undefined
    || audit.aggregate === undefined
    || audit.snapshot === undefined
    || audit.checks.length !== (
      contract.schemaVersion === 2
        ? contract.gatePlan.requiredChecks.length
        : contract.gatePlan.legacySnapshot.requiredChecks.length
    )
  ) {
    throw new Error('Loop record replay failed: Gate completion has missing evidence');
  }
  const checkDigests = audit.checks.map((check) => check.checkResultDigest);
  const commonJoinInvalid = (
    completed.runId !== audit.attempt.runId
    || completed.contractId !== audit.attempt.contractId
    || completed.planDigest !== audit.attempt.planDigest
    || completed.gateApprovalDigest !== audit.attempt.gateApprovalDigest
    || completed.evidenceSnapshotId !== audit.snapshot.evidenceSnapshotId
    || completed.evidenceDigest !== audit.snapshot.evidenceDigest
    || audit.aggregate.status !== completed.status
    || audit.aggregate.proofAggregateDigest !== audit.snapshot.proofAggregateDigest
    || audit.scan.scanResultDigest !== audit.snapshot.builtinRiskScanResultDigest
    || canonicalJson(checkDigests) !== canonicalJson(audit.aggregate.orderedCheckResultDigests)
    || canonicalJson(checkDigests)
      !== canonicalJson(audit.snapshot.orderedCheckResults.map((check) => check.resultDigest))
  );
  if (commonJoinInvalid) {
    throw new Error('Loop record replay failed: Gate evidence join mismatch');
  }
  if (audit.attempt.schemaVersion === 1) {
    if (
      audit.reviewer === undefined
      || audit.aggregate.schemaVersion !== 1
      || audit.snapshot.schemaVersion !== 1
      || audit.reviewer.reviewerResultDigest !== audit.snapshot.reviewerResultDigest
    ) {
      throw new Error('Loop record replay failed: legacy Gate evidence join mismatch');
    }
    return;
  }
  const run = state.currentLoopRun;
  const settingsBinding = run === undefined
    ? undefined
    : loopRunReviewSettingsBinding(state, run);
  if (
    settingsBinding === undefined
    || audit.manifest === undefined
    || audit.freshVerdict === undefined
    || audit.aggregate.schemaVersion !== 2
    || audit.snapshot.schemaVersion !== 2
    || audit.attempt.runSettingsRef !== settingsBinding.runSettingsRef
    || audit.attempt.runSettingsDigest !== settingsBinding.runSettings.settingsDigest
    || audit.manifest.manifestDigest !== audit.snapshot.reviewSubjectManifestDigest
    || audit.manifest.manifestRef !== audit.snapshot.reviewSubjectManifestRef
    || audit.freshVerdict.verdictDigest !== audit.snapshot.freshCriteriaVerdictDigest
    || audit.freshVerdict.verdictRef !== audit.snapshot.freshCriteriaVerdictRef
    || audit.aggregate.reviewSubjectManifestDigest !== audit.manifest.manifestDigest
    || audit.aggregate.freshCriteriaVerdictDigest !== audit.freshVerdict.verdictDigest
    || audit.aggregate.reviewSubjectConsentDigest
      !== audit.attempt.reviewSubjectConsentDigest
    || audit.snapshot.reviewSubjectConsentDigest
      !== audit.attempt.reviewSubjectConsentDigest
    || (completed.status === 'PASS' && audit.freshVerdict.verdict.status !== 'PASS')
  ) {
    throw new Error('Loop record replay failed: brokered Gate evidence join mismatch');
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

function providerUsageReport(state: GoalState): LoopProviderUsageReport {
  const writerCallLimit = state.providerCallLimits.writer ?? null;
  const reviewerCallLimit = state.providerCallLimits.reviewer ?? null;
  return {
    writerCalls: state.providerCalls.writer,
    reviewerCalls: state.providerCalls.reviewer,
    writerCallLimit,
    reviewerCallLimit,
    remainingWriterCalls: writerCallLimit === null
      ? null
      : Math.max(0, writerCallLimit - state.providerCalls.writer),
    remainingReviewerCalls: reviewerCallLimit === null
      ? null
      : Math.max(0, reviewerCallLimit - state.providerCalls.reviewer),
  };
}

function attributeChangedFiles(
  files: readonly LoopResultChangedFile[],
  baseline: WorkspaceChangeBaseline | undefined,
): readonly LoopResultChangedFile[] {
  if (baseline === undefined) return files;
  const preExisting = new Set(baseline.files.map((file) => file.path));
  return files.map((file) => ({
    ...file,
    attribution: preExisting.has(file.path)
      ? 'pre_existing_or_modified'
      : 'introduced_by_loop',
  }));
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
  const requiresNoExecutableChecksDecision = gatePlan.requiredChecks.length === 0;
  if (requiresNoExecutableChecksDecision) {
    const decision = input.noExecutableChecksDecision;
    if (
      gatePlan.excludedChecks.length > 0
      || decision === undefined
      || decision.status !== 'acknowledged'
      || decision.policyVersion !== NO_EXECUTABLE_CHECKS_POLICY_VERSION
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'No executable checks decision must be acknowledged before starting the Loop',
      );
    }
    const decisionCore = {
      schemaVersion: decision.schemaVersion,
      policyVersion: decision.policyVersion,
      objective,
      completionCriterion: completionCriterion ?? null,
      constraints: input.constraints,
      gatePlanDigest: gatePlan.planDigest,
    };
    if (
      canonicalDigest('wukong/no-executable-checks-decision/v1', decisionCore)
        !== decision.decisionDigest
    ) {
      throw new WukongError(
        ErrorCodes.REQUEST_INVALID,
        'No executable checks decision does not match the frozen Finish Line',
      );
    }
  } else if (input.noExecutableChecksDecision !== undefined) {
    throw new WukongError(
      ErrorCodes.REQUEST_INVALID,
      'No executable checks decision is not applicable to a Loop with required checks',
    );
  }
  if (
    hasExecutableChecks !== input.gateApproval.hasExecutableChecks
    || input.gateApproval.gatePlanDigest !== gatePlan.planDigest
      || input.gateApproval.warningSetDigest !== input.finishLineReview.warningSetDigest
      || input.gateApproval.guardPolicyVersion !== GATE_GUARD_POLICY_VERSION
      || gatePlan.builtinRiskScanPolicyVersion !== BUILTIN_RISK_SCAN_POLICY_VERSION
      || input.finishLineReview.warningPolicyVersion !== FINISH_LINE_WARNING_POLICY_VERSION
      || input.gateApproval.noExecutableChecksDecisionDigest
        !== input.noExecutableChecksDecision?.decisionDigest
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
    noExecutableChecksDecisionDigest: input.noExecutableChecksDecision?.decisionDigest,
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
    noExecutableChecksDecisionDigest:
      input.gateApproval.noExecutableChecksDecisionDigest,
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

function loopRunReviewSettingsBinding(
  state: GoalState,
  run: LoopRunCreated,
): {
  readonly runSettingsRef: string;
  readonly runSettings: LoopRunSettingsV2;
} | undefined {
  const assignment = state.loopRunReviewSettingsAssignments.get(run.runId);
  if (assignment !== undefined) {
    return {
      runSettingsRef: assignment.runSettingsRef,
      runSettings: assignment.runSettings,
    };
  }
  return run.schemaVersion === 2
    ? {
        runSettingsRef: run.runSettingsRef,
        runSettings: run.runSettings,
      }
    : undefined;
}

function reviewSettingsAssignmentIdempotencyKey(input: {
  readonly run: LoopRunCreated;
  readonly previousRunSettingsRef?: string;
  readonly reviewSettings: LoopRunReviewSettingsInput;
}): string {
  const legacy = input.run.schemaVersion === 2
    ? input.run.runSettings.legacy
    : input.run.runSettings;
  return canonicalDigest('wukong/review-settings-assignment-idempotency/v1', {
    runId: input.run.runId,
    previousRunSettingsRef: input.previousRunSettingsRef,
    consentProposalDigest:
      input.reviewSettings.reviewSubjectConsent.consentProposalDigest,
    brokerReviewTrustProposalDigest:
      input.reviewSettings.brokerReviewTrust.trustProposalDigest,
    legacySettingsDigest: canonicalDigest(
      'wukong/loop-run-settings/legacy/v1',
      legacy,
    ),
  });
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
  status: LoopGateDeterministicEvidenceInput['checks'][number]['status'] | undefined,
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
    || reasonCode === 'permission_required'
    || reasonCode === 'permission_denied'
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

function blockedReasonCode(reason: string | undefined, actor: GoalActor): string {
  const normalized = reason?.toLowerCase() ?? '';
  const encodedReasonCode = reason?.match(/^loop:(?:PASS|NEEDS_WORK|ERROR):([^:]+):/u)?.[1];
  if (encodedReasonCode !== undefined) return encodedReasonCode;
  if (actor === 'model') return 'model_blocked';
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
