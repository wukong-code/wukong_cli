import {
  candidateGateAttemptIdForLease,
  validateIsolatedLoopCandidateBinding,
  type CandidateBootstrapPlanV1,
  type IsolatedLoopCandidateBindingV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';

import type { Agent } from './agent';
import type { LoopGateReviewRuntimeV2 } from './agent/goal';
import {
  withCandidateWriterAgent,
} from './candidate-agent-writer';
import { CandidateDeltaStore } from './candidate-delta-store';
import {
  CandidateGateAttemptStore,
} from './candidate-gate-attempt-store';
import type {
  CandidateGateContractV1,
} from './candidate-gate-executor';
import {
  runCandidateGateAttempt,
  type CandidateGateOrchestrationResultV1,
} from './candidate-gate-orchestrator';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseBindingV1,
  WorktreeLeaseStore,
} from './worktree-lease-store';

export interface RunIsolatedLoopCandidateIterationInputV1 {
  readonly agent: Agent;
  readonly binding: IsolatedLoopCandidateBindingV1;
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly worktreeBinding: WorktreeLeaseBindingV1;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly candidateDeltaStore: CandidateDeltaStore;
  readonly candidateGateAttemptStore: CandidateGateAttemptStore;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly gateContract: CandidateGateContractV1;
  readonly gateRuntime: LoopGateReviewRuntimeV2;
  readonly objective: string;
  readonly writerSystemPrompt: string;
  readonly writerModel?: string;
  readonly reviewerModel?: string;
  readonly writerMaxSteps: number;
  readonly parentToolCallId: string;
  readonly signal: AbortSignal;
}

export interface IsolatedLoopCandidateIterationResultV1 {
  readonly schemaVersion: 1;
  readonly writerRan: boolean;
  readonly candidateGateAttemptId: string;
  readonly gate: CandidateGateOrchestrationResultV1;
}

export async function runIsolatedLoopCandidateIteration(
  input: RunIsolatedLoopCandidateIterationInputV1,
): Promise<IsolatedLoopCandidateIterationResultV1> {
  assertInput(input);
  let lease = await input.worktreeLeaseStore.inspect(
    input.binding.candidateId,
  );
  assertLiveBinding(input, lease);
  let writerRan = false;
  let verifyingBinding = input.worktreeBinding;
  if (lease.state === 'active') {
    await runCandidateWriter(input);
    writerRan = true;
    const verifying = await input.worktreeLeaseStore.transition(
      input.worktreeBinding,
      'verifying',
    );
    lease = verifying.lease;
    verifyingBinding = verifying.binding;
  } else if (lease.state !== 'verifying'
    && lease.state !== 'awaiting_promotion') {
    throw new Error(
      `Isolated candidate cannot run from lease state ${lease.state}.`,
    );
  }
  const verifyingLeaseDigest =
    await input.worktreeLeaseStore.inspectVerifyingLeaseDigest(
      input.binding.candidateId,
    );
  const candidateGateAttemptId = candidateGateAttemptIdForLease(
    input.binding,
    verifyingLeaseDigest,
  );
  const gateRuntime: LoopGateReviewRuntimeV2 = {
    ...input.gateRuntime,
    attemptId: candidateGateAttemptId,
  };
  const gate = await runCandidateGateAttempt({
    agent: input.agent,
    worktreeLeaseStore: input.worktreeLeaseStore,
    candidateDeltaStore: input.candidateDeltaStore,
    candidateGateAttemptStore: input.candidateGateAttemptStore,
    rootCapability: input.rootCapability,
    verifyingBinding,
    bootstrapPlan: input.bootstrapPlan,
    contract: input.gateContract,
    runtime: gateRuntime,
    objective: input.objective,
    reviewModel: input.reviewerModel,
    parentToolCallId: input.parentToolCallId,
    signal: input.signal,
  });
  return Object.freeze({
    schemaVersion: 1,
    writerRan,
    candidateGateAttemptId,
    gate,
  });
}

async function runCandidateWriter(
  input: RunIsolatedLoopCandidateIterationInputV1,
): Promise<void> {
  const modelProvider = input.agent.modelProvider;
  const modelAlias = input.writerModel ?? input.agent.config.modelAlias;
  if (modelProvider === undefined || modelAlias === undefined) {
    throw new Error('The isolated candidate Writer model is unavailable.');
  }
  await withCandidateWriterAgent(
    input.worktreeLeaseStore,
    input.candidateDeltaStore,
    input.rootCapability,
    input.bootstrapPlan,
    {
      kaos: input.agent.kaos,
      modelProvider,
      modelAlias,
      systemPrompt: input.writerSystemPrompt,
      config: input.agent.wukongConfig,
      generate: input.agent.rawGenerate,
      permission: { parent: input.agent.permission },
      log: input.agent.log,
      experimentalFlags: input.agent.experimentalFlags,
    },
    async (writer) => {
      const turnId = writer.turn.prompt(
        [{ type: 'text', text: input.objective }],
        {
          kind: 'system_trigger',
          name: 'isolated_loop_candidate_writer',
        },
        { maxSteps: input.writerMaxSteps },
      );
      if (turnId === null) {
        throw new Error('The isolated candidate Writer did not start.');
      }
      const completion = await writer.turn.waitForCurrentTurn(
        input.signal,
      );
      if (completion.event.reason !== 'completed') {
        throw new Error(
          `The isolated candidate Writer ended as ${completion.event.reason}.`,
        );
      }
      if (completion.stopReason === 'max_tokens') {
        throw new Error(
          'The isolated candidate Writer reached its output limit.',
        );
      }
    },
  );
}

function assertInput(
  input: RunIsolatedLoopCandidateIterationInputV1,
): void {
  if (!validateIsolatedLoopCandidateBinding(input.binding)
    || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.worktreeBinding instanceof WorktreeLeaseBindingV1)
    || !(input.rootCapability instanceof CandidateRootCapabilityV1)
    || !(input.candidateDeltaStore instanceof CandidateDeltaStore)
    || !(input.candidateGateAttemptStore
      instanceof CandidateGateAttemptStore)
    || !Number.isSafeInteger(input.writerMaxSteps)
    || input.writerMaxSteps <= 0
    || input.objective.trim().length === 0
    || input.writerSystemPrompt.trim().length === 0
    || input.parentToolCallId.length === 0
    || input.gateRuntime.runId !== input.binding.runId
    || input.gateRuntime.contractId !== input.binding.contractId
    || (input.binding.criteriaSelectionDigest !== null
      && input.gateRuntime.selectionDigest
        !== input.binding.criteriaSelectionDigest)
    || input.bootstrapPlan.bootstrapPlanDigest
      !== input.binding.bootstrapPlanDigest
    || input.gateContract.gatePlan.planDigest
      !== input.binding.gatePlanDigest) {
    throw new TypeError(
      'The isolated candidate iteration input is invalid.',
    );
  }
}

function assertLiveBinding(
  input: RunIsolatedLoopCandidateIterationInputV1,
  lease: WorktreeLeaseV1,
): void {
  if (lease.leaseId !== input.binding.worktreeLeaseId
    || lease.candidateId !== input.binding.candidateId
    || lease.goalId !== input.binding.goalId
    || lease.contractId !== input.binding.contractId
    || lease.runId !== input.binding.runId
    || lease.ownerRunId !== input.binding.ownerRunId
    || lease.sourceSnapshotDigest
      !== input.binding.sourceSnapshotDigest
    || lease.bootstrapPlanDigest
      !== input.binding.bootstrapPlanDigest
    || lease.gatePlanDigest !== input.binding.gatePlanDigest
    || lease.criteriaSelectionDigest
      !== input.binding.criteriaSelectionDigest
    || input.worktreeBinding.leaseId !== lease.leaseId
    || input.worktreeBinding.candidateId !== lease.candidateId
    || input.worktreeBinding.leaseDigest !== lease.leaseDigest
    || input.rootCapability.candidateId !== lease.candidateId
    || input.rootCapability.leaseId !== lease.leaseId) {
    throw new Error(
      'The isolated candidate iteration authority is stale.',
    );
  }
}
