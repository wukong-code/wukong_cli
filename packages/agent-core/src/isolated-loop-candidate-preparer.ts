import {
  createIsolatedLoopCandidateBinding,
  sealSourceSnapshot,
  validateCandidateBootstrapPlan,
  validateSourceSnapshot,
  type CandidateBootstrapPlanV1,
  type IsolatedLoopCandidateBindingV1,
  type SourceSnapshotV1,
} from '@wukong/verification';

import {
  executePreparedCandidateBootstrap,
} from './candidate-bootstrap-orchestrator';
import {
  inspectCandidateWorkspaceBackendCapability,
  type CandidateWorkspaceBackendCapabilityV1,
} from './candidate-workspace-backend-capability';
import {
  type CandidateBootstrapStepExecutionResultV1,
} from './candidate-bootstrap-executor';
import {
  type PreparedCandidateBootstrapPlanV1,
} from './candidate-bootstrap-plan-builder';
import {
  SnapshotBlobLeaseStore,
} from './snapshot-blob-lease-store';
import {
  SnapshotCandidateMaterializer,
  type MaterializedSnapshotCandidateRecordV1,
} from './snapshot-candidate-materializer';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
  type ActivatedWorktreeLeaseV1,
} from './worktree-lease-store';

export type IsolatedLoopCandidatePreparerErrorCode =
  | 'isolated_loop_candidate_invalid_input'
  | 'isolated_loop_candidate_backend_unavailable'
  | 'isolated_loop_candidate_bootstrap_unsupported'
  | 'isolated_loop_candidate_binding_rejected';

export class IsolatedLoopCandidatePreparerError extends Error {
  constructor(
    readonly reasonCode: IsolatedLoopCandidatePreparerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IsolatedLoopCandidatePreparerError';
  }
}

export interface PrepareIsolatedLoopCandidateInputV1 {
  readonly sourceRepositoryRoot: string;
  readonly sourceSnapshotCwd: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly snapshotBlobLeaseStore: SnapshotBlobLeaseStore;
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly materializer: SnapshotCandidateMaterializer;
  readonly goalId: string;
  readonly contractId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly preparedBootstrap?: PreparedCandidateBootstrapPlanV1;
  readonly approvedBootstrapPlanDigest?: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string | null;
  readonly expiresAt: string;
  readonly recordBinding: (
    binding: IsolatedLoopCandidateBindingV1,
  ) => IsolatedLoopCandidateBindingV1;
  /**
   * Controlled test/runtime injection. Product callers use the local backend
   * capability probe before any snapshot or candidate state is persisted.
   */
  readonly candidateWorkspaceBackendProbe?:
    () => CandidateWorkspaceBackendCapabilityV1;
  readonly signal?: AbortSignal;
}

export interface PreparedIsolatedLoopCandidateV1 {
  readonly binding: IsolatedLoopCandidateBindingV1;
  readonly worktree: ActivatedWorktreeLeaseV1;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly materializedRecord: MaterializedSnapshotCandidateRecordV1;
  readonly bootstrapResults:
    readonly CandidateBootstrapStepExecutionResultV1[];
}

export async function prepareIsolatedLoopCandidate(
  input: PrepareIsolatedLoopCandidateInputV1,
): Promise<PreparedIsolatedLoopCandidateV1> {
  assertInput(input);
  const backendCapability = (
    input.candidateWorkspaceBackendProbe
    ?? inspectCandidateWorkspaceBackendCapability
  )();
  if (!backendCapability.available) {
    throw new IsolatedLoopCandidatePreparerError(
      'isolated_loop_candidate_backend_unavailable',
      `The isolated Candidate file backend is unavailable: ${
        backendCapability.reasonCode
      }.`,
    );
  }
  const bootstrapRequired = input.bootstrapPlan.steps.length > 0;
  const sealed = await sealSourceSnapshot({
    cwd: input.sourceSnapshotCwd,
    snapshot: input.sourceSnapshot,
  });
  const staged = await input.snapshotBlobLeaseStore.stageAndSeal({
    containerBytes: sealed.containerBytes,
    sourceSnapshot: input.sourceSnapshot,
    createdByRunId: input.runId,
    ownerRunId: input.ownerRunId,
    expiresAt: input.expiresAt,
  });
  const confirmed = await input.snapshotBlobLeaseStore.confirm(
    staged.binding,
  );
  const reserved = await input.worktreeLeaseStore.reserve({
    sourceRepositoryRoot: input.sourceRepositoryRoot,
    sourceSnapshot: input.sourceSnapshot,
    snapshotBlobLease: confirmed.lease,
    goalId: input.goalId,
    contractId: input.contractId,
    runId: input.runId,
    ownerRunId: input.ownerRunId,
    bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: input.gatePlanDigest,
    criteriaSelectionDigest: input.criteriaSelectionDigest,
    expiresAt: input.expiresAt,
  });
  const binding = createIsolatedLoopCandidateBinding({
    goalId: input.goalId,
    contractId: input.contractId,
    runId: input.runId,
    ownerRunId: input.ownerRunId,
    candidateId: reserved.lease.candidateId,
    worktreeLeaseId: reserved.lease.leaseId,
    sourceSnapshotDigest: input.sourceSnapshot.snapshotDigest,
    bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: input.gatePlanDigest,
    criteriaSelectionDigest: input.criteriaSelectionDigest,
    reservedLeaseDigest: reserved.lease.leaseDigest,
    createdAt: reserved.lease.createdAt,
  });
  let recorded: IsolatedLoopCandidateBindingV1;
  try {
    recorded = input.recordBinding(binding);
  } catch (error) {
    throw new IsolatedLoopCandidatePreparerError(
      'isolated_loop_candidate_binding_rejected',
      'The reserved candidate could not be joined to the Loop run.',
      { cause: error },
    );
  }
  if (recorded.bindingDigest !== binding.bindingDigest) {
    throw new IsolatedLoopCandidatePreparerError(
      'isolated_loop_candidate_binding_rejected',
      'The Loop run returned a different candidate binding.',
    );
  }
  const materialized = await input.materializer.materialize({
    sourceRepositoryRoot: input.sourceRepositoryRoot,
    sourceSnapshot: input.sourceSnapshot,
    leaseStore: input.snapshotBlobLeaseStore,
    confirmedBinding: confirmed.binding,
    worktreeLeaseStore: input.worktreeLeaseStore,
    worktreeLeaseBinding: reserved.binding,
  });
  const bootstrapped = bootstrapRequired
    ? await executePreparedCandidateBootstrap({
        worktreeLeaseStore: input.worktreeLeaseStore,
        worktreeAuthority: materialized.worktreeLease,
        preparedBootstrap: input.preparedBootstrap!,
        approvedBootstrapPlanDigest:
          input.approvedBootstrapPlanDigest!,
        signal: input.signal,
      })
    : null;
  const active = bootstrapped?.activeWorktree
    ?? await input.worktreeLeaseStore.activate(
      materialized.worktreeLease.binding,
    );
  return Object.freeze({
    binding,
    worktree: active,
    rootCapability: active.rootCapability,
    materializedRecord: materialized.record,
    bootstrapResults: bootstrapped?.results ?? Object.freeze([]),
  });
}

function assertInput(
  input: PrepareIsolatedLoopCandidateInputV1,
): void {
  if (typeof input !== 'object'
    || input === null
    || typeof input.sourceRepositoryRoot !== 'string'
    || input.sourceRepositoryRoot.length === 0
    || typeof input.sourceSnapshotCwd !== 'string'
    || input.sourceSnapshotCwd.length === 0
    || !validateSourceSnapshot(input.sourceSnapshot)
    || input.sourceSnapshot.exclusions.length > 0
    || !(input.snapshotBlobLeaseStore instanceof SnapshotBlobLeaseStore)
    || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.materializer instanceof SnapshotCandidateMaterializer)
    || !isUuid(input.goalId)
    || !isUuid(input.contractId)
    || !isUuid(input.runId)
    || !isUuid(input.ownerRunId)
    || !validateCandidateBootstrapPlan(input.bootstrapPlan)
    || input.bootstrapPlan.sourceSnapshotDigest
      !== input.sourceSnapshot.snapshotDigest
    || input.bootstrapPlan.gatePlanDigest !== input.gatePlanDigest
    || !validBootstrapExecutionBinding(input)
    || !isDigest(input.gatePlanDigest)
    || (input.criteriaSelectionDigest !== null
      && !isDigest(input.criteriaSelectionDigest))
    || !isCanonicalTimestamp(input.expiresAt)
    || typeof input.recordBinding !== 'function'
    || (input.candidateWorkspaceBackendProbe !== undefined
      && typeof input.candidateWorkspaceBackendProbe !== 'function')
    || (input.signal !== undefined
      && !(input.signal instanceof AbortSignal))) {
    throw new IsolatedLoopCandidatePreparerError(
      'isolated_loop_candidate_invalid_input',
      'The isolated Loop candidate preparation input is invalid.',
    );
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validBootstrapExecutionBinding(
  input: PrepareIsolatedLoopCandidateInputV1,
): boolean {
  if (input.bootstrapPlan.steps.length === 0) {
    return input.preparedBootstrap === undefined
      && input.approvedBootstrapPlanDigest === undefined
      && input.bootstrapPlan.ecosystemRefs.length === 0
      && input.bootstrapPlan.lockfileDigests.length === 0
      && input.bootstrapPlan.injectedEnvironmentNames.length === 0
      && input.bootstrapPlan.networkPolicy === 'deny'
      && input.bootstrapPlan.allowedRegistryEndpointDigests.length === 0;
  }
  return input.preparedBootstrap !== undefined
    && input.approvedBootstrapPlanDigest
      === input.bootstrapPlan.bootstrapPlanDigest
    && input.preparedBootstrap.plan.bootstrapPlanDigest
      === input.bootstrapPlan.bootstrapPlanDigest
    && input.preparedBootstrap.budget.budgetDigest
      === input.bootstrapPlan.bootstrapBudgetDigest;
}
