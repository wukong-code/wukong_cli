import type { ContentPart, TokenUsage } from '@wukong/kosong';
import type {
  IsolatedLoopCandidateBindingV1,
  TargetGateCompletionSealV1,
} from '@wukong/verification';

import type { LoopRecordedEvent } from '../../loop';
import type {
  GoalActor,
  GoalBudgetLimits,
  GoalStatus,
  BuiltinRiskScanResultRecordedV1,
  FreshCriteriaVerdictRecordedV1,
  GateAttemptCompletedV1,
  GateAttemptCreated,
  GateCheckResultRecordedV1,
  LoopContract,
  LoopContinuationCreatedV1,
  LoopEvidenceSnapshotCreated,
  LoopResult,
  LoopReviewAttempt,
  LoopRunCreated,
  LoopRunReviewSettingsAssignedV1,
  LoopRunTerminalV1,
  LoopStrategyAttempt,
  IsolatedLoopCandidateIterationRecordedV1,
  ProofAggregateRecorded,
  ReviewSubjectManifestRecordedV1,
  ReviewerResultRecordedV1,
} from '../goal';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMessage, PromptOrigin } from '../context';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';
import type { SwarmModeTrigger } from '../swarm';

// Agent records are the ordered event log used to rebuild agent state on resume.
// Use records, not state.json, when correctness depends on the order in which
// state transitions happened. Each persisted record type must have explicit
// resume semantics in restoreAgentRecord; a write-only record is not persistence.
export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  forked: {};

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  'swarm_mode.enter': {
    trigger: SwarmModeTrigger;
  };
  'swarm_mode.exit': {};

  'tools.register_user_tool': UserToolRegistration;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  'micro_compaction.apply': { cutoff: number };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };

  'tools.update_store': ToolStoreUpdate;

  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
    stopCondition?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
    reviewModel?: string;
    maxIterations?: number;
    minIntervalMs?: number;
  };
  'goal.update': {
    status?: GoalStatus;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    iteration?: number;
    reason?: string;
    actor?: GoalActor;
    loopResult?: LoopResult;
  };
  'goal.contract.create': {
    goalId: string;
    contract: LoopContract;
  };
  'goal.contract.identity.assign': {
    goalId: string;
    contractRecordIdentity: string;
    contractId: string;
  };
  'goal.lineage.create': {
    goalId: string;
    supersedesGoalId: string;
    contractId: string;
    supersedesContractId: string;
  };
  'loop.run.create': {
    run: LoopRunCreated;
  };
  'loop.run-review-settings.assign': {
    assignment: LoopRunReviewSettingsAssignedV1;
  };
  'loop.isolated-candidate.bind': {
    binding: IsolatedLoopCandidateBindingV1;
  };
  'loop.isolated-candidate.iteration': {
    iteration: IsolatedLoopCandidateIterationRecordedV1;
  };
  'loop.gate-attempt.create': {
    attempt: GateAttemptCreated;
  };
  'loop.gate-check-result.create': {
    result: GateCheckResultRecordedV1;
  };
  'loop.builtin-risk-scan-result.create': {
    result: BuiltinRiskScanResultRecordedV1;
  };
  'loop.reviewer-result.create': {
    result: ReviewerResultRecordedV1;
  };
  'loop.review-subject-manifest.create': {
    result: ReviewSubjectManifestRecordedV1;
  };
  'loop.fresh-criteria-verdict.create': {
    result: FreshCriteriaVerdictRecordedV1;
  };
  'loop.proof-aggregate.create': {
    result: ProofAggregateRecorded;
  };
  'loop.evidence-snapshot.create': {
    snapshot: LoopEvidenceSnapshotCreated;
  };
  'loop.gate-attempt.complete': {
    attempt: GateAttemptCompletedV1;
  };
  'loop.target-completion-seal.create': {
    seal: TargetGateCompletionSealV1;
  };
  'loop.run.terminal': {
    terminal: LoopRunTerminalV1;
  };
  'loop.continuation.create': {
    continuation: LoopContinuationCreatedV1;
  };
  'goal.review.record': {
    goalId: string;
    attempt: LoopReviewAttempt;
  };
  'goal.strategy.record': {
    goalId: string;
    attempt: LoopStrategyAttempt;
  };
  'goal.clear': {};
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
