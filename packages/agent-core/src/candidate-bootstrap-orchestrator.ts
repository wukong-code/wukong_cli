import {
  canonicalDigest,
  validateBootstrapBudget,
  validateCandidateBootstrapPlan,
  validateWorktreeLease,
  type CandidateBootstrapStepV1,
} from '@wukong/verification';

import {
  CandidateBootstrapExecutor,
  fingerprintGeneratedScopes,
  type CandidateBootstrapStepExecutionResultV1,
} from './candidate-bootstrap-executor';
import {
  CandidateBootstrapStateStore,
} from './candidate-bootstrap-state-store';
import {
  confirmCandidateBootstrapPlan,
  type PreparedCandidateBootstrapPlanV1,
} from './candidate-bootstrap-plan-builder';
import {
  WorktreeLeaseBindingV1,
  WorktreeLeaseStore,
  type ActivatedWorktreeLeaseV1,
  type WorktreeLeaseAuthorityV1,
} from './worktree-lease-store';

export type CandidateBootstrapOrchestratorErrorCode =
  | 'candidate_bootstrap_orchestrator_invalid_input'
  | 'candidate_bootstrap_failed'
  | 'candidate_bootstrap_reconciliation_required';

export class CandidateBootstrapOrchestratorError extends Error {
  constructor(
    readonly reasonCode: CandidateBootstrapOrchestratorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateBootstrapOrchestratorError';
  }
}

export interface ExecutePreparedCandidateBootstrapInputV1 {
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly worktreeAuthority: WorktreeLeaseAuthorityV1;
  readonly preparedBootstrap: PreparedCandidateBootstrapPlanV1;
  readonly approvedBootstrapPlanDigest: string;
  readonly signal?: AbortSignal;
}

export interface ExecutedCandidateBootstrapV1 {
  readonly activeWorktree: ActivatedWorktreeLeaseV1;
  readonly results: readonly CandidateBootstrapStepExecutionResultV1[];
}

export interface RecoverPreparedCandidateBootstrapOwnershipInputV1 {
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly worktreeAuthority: WorktreeLeaseAuthorityV1;
  readonly preparedBootstrap: PreparedCandidateBootstrapPlanV1;
  readonly approvedBootstrapPlanDigest: string;
}

export async function recoverPreparedCandidateBootstrapOwnership(
  input: RecoverPreparedCandidateBootstrapOwnershipInputV1,
): Promise<void> {
  if (!isRecord(input)
    || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !isRecord(input.worktreeAuthority)
    || !validateWorktreeLease(input.worktreeAuthority.lease)
    || input.worktreeAuthority.lease.state !== 'bootstrapping'
    || !(input.worktreeAuthority.binding
      instanceof WorktreeLeaseBindingV1)
    || typeof input.approvedBootstrapPlanDigest !== 'string') {
    throw new CandidateBootstrapOrchestratorError(
      'candidate_bootstrap_orchestrator_invalid_input',
      'The bootstrap ownership recovery input is invalid.',
    );
  }
  const prepared = confirmCandidateBootstrapPlan(
    input.preparedBootstrap,
    input.approvedBootstrapPlanDigest,
  );
  await input.worktreeLeaseStore.withBootstrappingCandidate(
    input.worktreeAuthority.binding,
    async (view, ownershipAncestors) => {
      const stateStore = new CandidateBootstrapStateStore({
        rootDirectory: view.bootstrapPrivateDirectory,
      });
      const recovery = await stateStore.inspectOwnershipRecovery({
        worktreeLease: input.worktreeAuthority.lease,
        bootstrapPlan: prepared.plan,
        ownershipAncestors,
      });
      if (recovery === null || recovery.status === 'current') {
        return;
      }
      const observed = await fingerprintGeneratedScopes(
        view.candidateDirectory,
        recovery.generatedPathScopes,
      );
      const identity = {
        leaseId: input.worktreeAuthority.lease.leaseId,
        worktreeLeaseDigest:
          input.worktreeAuthority.lease.leaseDigest,
        previousStateDigest: recovery.stateDigest,
      };
      await stateStore.adoptOwnership({
        worktreeLease: input.worktreeAuthority.lease,
        bootstrapPlan: prepared.plan,
        expectedPreviousStateDigest: recovery.stateDigest,
        journalEventId:
          stableUuid('ownership-adoption', identity),
        observedGeneratedScopeFingerprint:
          observed.fingerprint,
        idempotencyKey:
          `bootstrap_owner_adoption_${input.worktreeAuthority.lease.casRevision}`,
      });
    },
  );
}

/**
 * Joins an exact confirmed plan to a materialized bootstrapping lease. Every
 * durable identifier is derived from the plan/lease/step binding, so restart
 * re-enters the existing reservation and journal instead of spawning again.
 */
export async function executePreparedCandidateBootstrap(
  input: ExecutePreparedCandidateBootstrapInputV1,
): Promise<ExecutedCandidateBootstrapV1> {
  assertInput(input);
  const prepared = confirmCandidateBootstrapPlan(
    input.preparedBootstrap,
    input.approvedBootstrapPlanDigest,
  );
  const executor = new CandidateBootstrapExecutor({
    worktreeLeaseStore: input.worktreeLeaseStore,
  });
  const results: CandidateBootstrapStepExecutionResultV1[] = [];
  for (const preparedStep of prepared.preparedSteps) {
    const ids = stepIds(
      prepared.plan.bootstrapPlanDigest,
      input.worktreeAuthority.lease.leaseId,
      preparedStep.step,
    );
    const result = await executor.executeStep({
      worktreeAuthority: input.worktreeAuthority,
      bootstrapPlan: prepared.plan,
      bootstrapBudget: prepared.budget,
      journalId: ids.journal,
      step: preparedStep.step,
      trustedExecutable: preparedStep.trustedExecutable,
      argv: preparedStep.argv,
      effectiveEnvironment: preparedStep.effectiveEnvironment,
      privateInputsExpiresAt: input.worktreeAuthority.lease.expiresAt,
      reservationId: ids.reservation,
      reserveBudgetEventId: ids.reserveBudget,
      prepareJournalEventId: ids.prepareJournal,
      startBudgetEventId: ids.startBudget,
      startJournalEventId: ids.startJournal,
      finishBudgetEventId: ids.finishBudget,
      finishJournalEventId: ids.finishJournal,
      reservedWallClockMs: preparedStep.reservedWallClockMs,
      reservedGeneratedBytes: preparedStep.reservedGeneratedBytes,
      reservedOutputBytes: preparedStep.reservedOutputBytes,
      idempotencyKey: `bootstrap_${preparedStep.step.stepId}`,
      signal: input.signal,
    });
    results.push(result);
    if (result.status === 'retained_unknown') {
      throw new CandidateBootstrapOrchestratorError(
        'candidate_bootstrap_reconciliation_required',
        'Bootstrap usage or process termination could not be reconciled.',
      );
    }
    if (result.status !== 'observed') {
      throw new CandidateBootstrapOrchestratorError(
        'candidate_bootstrap_failed',
        'The exact candidate bootstrap step failed.',
      );
    }
  }
  const activeWorktree = await input.worktreeLeaseStore.activate(
    input.worktreeAuthority.binding,
  );
  return Object.freeze({
    activeWorktree,
    results: Object.freeze(results),
  });
}

function assertInput(
  input: ExecutePreparedCandidateBootstrapInputV1,
): void {
  if (!isRecord(input)
    || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !isRecord(input.worktreeAuthority)
    || !validateWorktreeLease(input.worktreeAuthority.lease)
    || input.worktreeAuthority.lease.state !== 'bootstrapping'
    || !(input.worktreeAuthority.binding instanceof WorktreeLeaseBindingV1)
    || !isRecord(input.preparedBootstrap)
    || !validateCandidateBootstrapPlan(input.preparedBootstrap.plan)
    || !validateBootstrapBudget(input.preparedBootstrap.budget)
    || input.preparedBootstrap.plan.bootstrapPlanDigest
      !== input.worktreeAuthority.lease.bootstrapPlanDigest
    || typeof input.approvedBootstrapPlanDigest !== 'string'
    || (input.signal !== undefined
      && !(input.signal instanceof AbortSignal))) {
    throw new CandidateBootstrapOrchestratorError(
      'candidate_bootstrap_orchestrator_invalid_input',
      'The candidate bootstrap orchestration input is invalid.',
    );
  }
}

function stepIds(
  planDigest: string,
  leaseId: string,
  step: CandidateBootstrapStepV1,
): {
  readonly journal: string;
  readonly reservation: string;
  readonly reserveBudget: string;
  readonly prepareJournal: string;
  readonly startBudget: string;
  readonly startJournal: string;
  readonly finishBudget: string;
  readonly finishJournal: string;
} {
  const identity = {
    planDigest,
    leaseId,
    stepDigest: step.stepDigest,
  };
  return {
    journal: stableUuid('journal', { planDigest, leaseId }),
    reservation: stableUuid('reservation', identity),
    reserveBudget: stableUuid('reserve-budget', identity),
    prepareJournal: stableUuid('prepare-journal', identity),
    startBudget: stableUuid('start-budget', identity),
    startJournal: stableUuid('start-journal', identity),
    finishBudget: stableUuid('finish-budget', identity),
    finishJournal: stableUuid('finish-journal', identity),
  };
}

function stableUuid(label: string, identity: unknown): string {
  return uuidFromDigest(canonicalDigest(
    `wukong/candidate-bootstrap-${label}-id/v1`,
    identity,
  ));
}

function uuidFromDigest(digest: string): string {
  const hex = digest.slice('sha256:'.length, 'sha256:'.length + 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
