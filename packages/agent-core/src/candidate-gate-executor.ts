import {
  createWorkspaceSnapshot,
  runProof,
  validateFrozenCandidateGatePlan,
  WorkspaceChangedError,
  type FinishLineProposal,
  type GatePlanValidation,
  type ProofResult,
  type CandidateBootstrapPlanV1,
  type VerificationCommand,
  type WorktreeLeaseV1,
} from '@wukong/verification';

import {
  CandidateDeltaStore,
  type CandidateDeltaSealV1,
} from './candidate-delta-store';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
} from './worktree-lease-store';

export type CandidateGateContractV1 = Pick<
  FinishLineProposal,
  'workspaceIdentity' | 'workspaceTrust' | 'gatePlan' | 'gateApproval' | 'reviewPolicy'
>;

export interface CandidateDeterministicGateResultV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly candidateDeltaDigest: string;
  readonly candidateDeltaSealDigest: string;
  readonly status: 'passed' | 'blocked' | 'error';
  readonly reasonCode: string;
  readonly reason: string;
  readonly gatePlanDigest: string;
  readonly workspaceSnapshotId: string | null;
  readonly validation: GatePlanValidation;
  readonly proof: ProofResult | null;
}

export interface RunCandidateDeterministicGateInputV1 {
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly candidateDeltaStore: CandidateDeltaStore;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly contract: CandidateGateContractV1;
  readonly signal?: AbortSignal;
}

/**
 * Runs only the deterministic candidate Gate segment. A fresh reviewer and
 * terminal completion seal remain separate, later orchestration stages.
 */
export async function runCandidateDeterministicGate(
  input: RunCandidateDeterministicGateInputV1,
): Promise<CandidateDeterministicGateResultV1> {
  if (!(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.candidateDeltaStore instanceof CandidateDeltaStore)
    || !(input.rootCapability instanceof CandidateRootCapabilityV1)) {
    throw new TypeError(
      'Authentic candidate Gate stores and root capability are required.',
    );
  }
  const initialSeal = await input.candidateDeltaStore.sealDelta({
    worktreeLeaseStore: input.worktreeLeaseStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
  });
  const gateResult = await input.worktreeLeaseStore.withCandidateRoot(
    input.rootCapability,
    async (view) => {
    const lease = await input.worktreeLeaseStore.inspect(
      input.rootCapability.candidateId,
    );
    assertDeltaBinding(initialSeal, lease);
    const validation = await validateFrozenCandidateGatePlan(
      view.candidateRelativeCwd,
      input.contract,
      lease.gatePlanDigest,
    );
    if (!validation.ok) {
      return result({
        seal: initialSeal,
        status: 'error',
        reasonCode: validation.reasonCode ?? 'gate_plan_invalid',
        reason: validation.message ?? 'The candidate Gate Plan is invalid.',
        gatePlanDigest: lease.gatePlanDigest,
        validation,
      });
    }
    const unresolved = input.contract.gatePlan.requiredChecks.find(
      (check) => check.resolution === 'expected-unresolved',
    );
    if (unresolved !== undefined) {
      return result({
        seal: initialSeal,
        status: 'blocked',
        reasonCode: 'check_definition_unresolved',
        reason: `Required check is not defined yet: ${unresolved.displayCommand}`,
        gatePlanDigest: lease.gatePlanDigest,
        validation,
      });
    }
    const selectedCommands: VerificationCommand[] =
      input.contract.gatePlan.requiredChecks.flatMap((check) =>
        check.resolution === 'resolved'
          ? [{
              id: check.id,
              command: check.executionCommand,
              source: check.source,
              sourceLocator: check.sourceLocator,
            }]
          : []);
    const before = await createWorkspaceSnapshot({
      cwd: view.candidateRelativeCwd,
      commands: selectedCommands,
    });
    let proof: ProofResult;
    try {
      proof = await runProof({
        cwd: view.candidateRelativeCwd,
        commands: selectedCommands.map(({ command }) => command),
        selectedCommands,
        retryOnWorkspaceChange: false,
        writeReport: false,
        signal: input.signal,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceChangedError)) throw error;
      return result({
        seal: initialSeal,
        status: 'error',
        reasonCode: 'candidate_changed_during_gate',
        reason: error.message,
        gatePlanDigest: lease.gatePlanDigest,
        workspaceSnapshotId: before.id,
        validation,
      });
    }
    if (proof.snapshotId !== before.id) {
      return result({
        seal: initialSeal,
        status: 'error',
        reasonCode: 'candidate_changed_before_gate',
        reason: 'The candidate changed between Gate authorization and execution.',
        gatePlanDigest: lease.gatePlanDigest,
        workspaceSnapshotId: before.id,
        validation,
        proof,
      });
    }
    const postValidation = await validateFrozenCandidateGatePlan(
      view.candidateRelativeCwd,
      input.contract,
      lease.gatePlanDigest,
    );
    if (!postValidation.ok) {
      return result({
        seal: initialSeal,
        status: 'error',
        reasonCode: postValidation.reasonCode ?? 'gate_plan_changed',
        reason: postValidation.message
          ?? 'The candidate Gate Plan changed during execution.',
        gatePlanDigest: lease.gatePlanDigest,
        workspaceSnapshotId: proof.snapshotId,
        validation: postValidation,
        proof,
      });
    }
    return result({
      seal: initialSeal,
      status: proof.status,
      reasonCode: proof.reasonCode,
      reason: proof.status === 'passed'
        ? proof.summary
        : proof.recommendation,
      gatePlanDigest: lease.gatePlanDigest,
      workspaceSnapshotId: proof.snapshotId,
      validation: postValidation,
      proof,
    });
  },
  );
  const finalSeal = await input.candidateDeltaStore.sealDelta({
    worktreeLeaseStore: input.worktreeLeaseStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
  });
  if (finalSeal.sealDigest !== initialSeal.sealDigest) {
    throw new Error('The candidate delta seal changed during Gate execution.');
  }
  return gateResult;
}

function result(
  input: Omit<
    CandidateDeterministicGateResultV1,
    | 'schemaVersion'
    | 'candidateId'
    | 'leaseId'
    | 'candidateDeltaDigest'
    | 'candidateDeltaSealDigest'
    | 'workspaceSnapshotId'
    | 'proof'
  > & {
    readonly seal: CandidateDeltaSealV1;
    readonly workspaceSnapshotId?: string;
    readonly proof?: ProofResult;
  },
): CandidateDeterministicGateResultV1 {
  return Object.freeze({
    schemaVersion: 1,
    candidateId: input.seal.candidateId,
    leaseId: input.seal.leaseId,
    candidateDeltaDigest: input.seal.delta.candidateDeltaDigest,
    candidateDeltaSealDigest: input.seal.sealDigest,
    status: input.status,
    reasonCode: input.reasonCode,
    reason: input.reason,
    gatePlanDigest: input.gatePlanDigest,
    workspaceSnapshotId: input.workspaceSnapshotId ?? null,
    validation: input.validation,
    proof: input.proof ?? null,
  });
}

function assertDeltaBinding(
  seal: CandidateDeltaSealV1,
  lease: WorktreeLeaseV1,
): void {
  if (seal.candidateId !== lease.candidateId
    || seal.leaseId !== lease.leaseId
    || seal.leaseCasRevision !== lease.casRevision
    || seal.verifyingLeaseDigest !== lease.leaseDigest) {
    throw new Error('The candidate Gate delta seal has a stale lease binding.');
  }
}
