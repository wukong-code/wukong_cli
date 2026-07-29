import {
  canonicalDigest,
  validateCandidateGateAttempt,
  type CandidateBootstrapPlanV1,
  type CandidateGateAttemptV1,
} from '@wukong/verification';

import type { Agent } from './agent';
import type { LoopGateReviewRuntimeV2 } from './agent/goal';
import { CandidateDeltaStore } from './candidate-delta-store';
import { runCandidateFreshReviewer } from './candidate-fresh-reviewer';
import {
  CandidateGateAttemptStore,
  CandidateGateAttemptStoreError,
} from './candidate-gate-attempt-store';
import {
  runCandidateDeterministicGate,
  type CandidateGateContractV1,
} from './candidate-gate-executor';
import { createCandidateBrokeredReviewPlan } from './candidate-review-plan';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseBindingV1,
  WorktreeLeaseStore,
  type WorktreeLeaseAuthorityV1,
} from './worktree-lease-store';

export interface RunCandidateGateAttemptInputV1 {
  readonly agent: Pick<
    Agent,
    'config' | 'modelProvider' | 'subagentHost'
  >;
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly candidateDeltaStore: CandidateDeltaStore;
  readonly candidateGateAttemptStore: CandidateGateAttemptStore;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly verifyingBinding: WorktreeLeaseBindingV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly contract: CandidateGateContractV1;
  readonly runtime: LoopGateReviewRuntimeV2;
  readonly objective: string;
  readonly reviewModel?: string;
  readonly parentToolCallId: string;
  readonly signal: AbortSignal;
}

export interface CandidateGateOrchestrationResultV1 {
  readonly schemaVersion: 1;
  readonly attempt: CandidateGateAttemptV1;
  readonly leaseState: 'active' | 'verifying' | 'awaiting_promotion';
  readonly transitionedLease?: WorktreeLeaseAuthorityV1;
}

/**
 * Joins the deterministic Gate, fresh reviewer and Worktree Lease transition
 * into one resumable candidate attempt. A Candidate PASS can only move the
 * lease to `awaiting_promotion`; it never creates a root terminal PASS.
 */
export async function runCandidateGateAttempt(
  input: RunCandidateGateAttemptInputV1,
): Promise<CandidateGateOrchestrationResultV1> {
  assertInput(input);
  const existing = await inspectAttemptOrNull(input);
  if (existing?.state === 'completed') {
    return joinCompletedAttempt(input, existing);
  }
  if (existing?.state === 'reviewing') {
    const interrupted =
      await input.candidateGateAttemptStore.complete({
        ...liveInput(input),
        expected: existing,
        outcome: 'ERROR',
        reasonCode: 'reviewer_interrupted',
        reviewerPayloadDigest: canonicalDigest(
          'wukong/candidate-fresh-reviewer-failure/v1',
          {
            reasonCode: 'reviewer_interrupted',
            errorName: 'InterruptedReview',
          },
        ),
        verdict: null,
        reviewerVerdictStatus: null,
      });
    return joinCompletedAttempt(input, interrupted);
  }

  const prepared = existing
    ?? await input.candidateGateAttemptStore.initialize({
      ...liveInput(input),
      candidateGateAttemptId: input.runtime.attemptId,
    });
  const deterministicGate = await runCandidateDeterministicGate({
    worktreeLeaseStore: input.worktreeLeaseStore,
    candidateDeltaStore: input.candidateDeltaStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
    contract: input.contract,
    signal: input.signal,
  });
  const reviewPlan = deterministicGate.status === 'passed'
    ? createCandidateBrokeredReviewPlan({
        deltaSeal: await requireCurrentDeltaSeal(input),
        deterministicGate,
      })
    : null;
  const deterministic =
    await input.candidateGateAttemptStore.recordDeterministic({
      ...liveInput(input),
      expected: prepared,
      deterministicGate,
      reviewPlan,
    });
  if (deterministicGate.status !== 'passed' || reviewPlan === null) {
    const completed = await input.candidateGateAttemptStore.complete({
      ...liveInput(input),
      expected: deterministic,
      outcome: deterministicGate.status === 'blocked'
        ? 'NEEDS_WORK'
        : 'ERROR',
      reasonCode: deterministicGate.reasonCode,
      reviewerPayloadDigest: null,
      verdict: null,
      reviewerVerdictStatus: null,
    });
    return joinCompletedAttempt(input, completed);
  }
  const reviewed = await runCandidateFreshReviewer({
    agent: input.agent,
    ...liveInput(input),
    candidateGateAttemptStore: input.candidateGateAttemptStore,
    expectedAttempt: deterministic,
    deterministicGate,
    reviewPlan,
    runtime: input.runtime,
    objective: input.objective,
    reviewModel: input.reviewModel,
    parentToolCallId: input.parentToolCallId,
    signal: input.signal,
  });
  const reread = await input.candidateGateAttemptStore.inspect({
    candidateId: reviewed.candidateId,
    candidateGateAttemptId: reviewed.candidateGateAttemptId,
  });
  if (reread.stateDigest !== reviewed.stateDigest
    || !validateCandidateGateAttempt(reread)
    || reread.state !== 'completed') {
    throw new Error('Candidate Gate completion could not be rejoined.');
  }
  return joinCompletedAttempt(input, reread);
}

async function joinCompletedAttempt(
  input: RunCandidateGateAttemptInputV1,
  attempt: CandidateGateAttemptV1,
): Promise<CandidateGateOrchestrationResultV1> {
  if (!validateCandidateGateAttempt(attempt)
    || attempt.state !== 'completed'
    || attempt.candidateGateResult === null
    || attempt.candidateGateResult.candidateId
      !== input.rootCapability.candidateId) {
    throw new Error('Candidate Gate completion is invalid.');
  }
  const lease = await input.worktreeLeaseStore.inspect(
    input.rootCapability.candidateId,
  );
  const outcome = attempt.candidateGateResult.candidateGateOutcome;
  if (outcome === 'PASS') {
    if (lease.state === 'awaiting_promotion') {
      await requireTransitionEvidence(
        input,
        attempt,
        'awaiting_promotion',
        transitionReason('candidate_gate_passed', attempt),
      );
      return { schemaVersion: 1, attempt, leaseState: 'awaiting_promotion' };
    }
    if (lease.state !== 'verifying'
      || !matchesVerifyingLease(attempt, lease)) {
      throw new Error('Candidate PASS has an incompatible Worktree Lease.');
    }
    const transitionedLease = await input.worktreeLeaseStore.transition(
      input.verifyingBinding,
      'awaiting_promotion',
      transitionReason('candidate_gate_passed', attempt),
    );
    return {
      schemaVersion: 1,
      attempt,
      leaseState: 'awaiting_promotion',
      transitionedLease,
    };
  }
  if (outcome === 'NEEDS_WORK') {
    if (lease.state === 'active') {
      await requireTransitionEvidence(
        input,
        attempt,
        'active',
        transitionReason('candidate_gate_failed', attempt),
      );
      return { schemaVersion: 1, attempt, leaseState: 'active' };
    }
    if (lease.state !== 'verifying'
      || !matchesVerifyingLease(attempt, lease)) {
      throw new Error(
        'Candidate NEEDS_WORK has an incompatible Worktree Lease.',
      );
    }
    const transitionedLease = await input.worktreeLeaseStore.transition(
      input.verifyingBinding,
      'active',
      transitionReason('candidate_gate_failed', attempt),
    );
    return {
      schemaVersion: 1,
      attempt,
      leaseState: 'active',
      transitionedLease,
    };
  }
  if (lease.state === 'active') {
    await requireTransitionEvidence(
      input,
      attempt,
      'active',
      transitionReason('candidate_gate_error', attempt),
    );
    return { schemaVersion: 1, attempt, leaseState: 'active' };
  }
  if (lease.state !== 'verifying'
    || !matchesVerifyingLease(attempt, lease)) {
    throw new Error(
      'Candidate Gate ERROR has an incompatible Worktree Lease.',
    );
  }
  const transitionedLease = await input.worktreeLeaseStore.transition(
    input.verifyingBinding,
    'active',
    transitionReason('candidate_gate_error', attempt),
  );
  return {
    schemaVersion: 1,
    attempt,
    leaseState: 'active',
    transitionedLease,
  };
}

async function requireTransitionEvidence(
  input: RunCandidateGateAttemptInputV1,
  attempt: CandidateGateAttemptV1,
  toState: 'active' | 'awaiting_promotion',
  reasonCode: string,
): Promise<void> {
  if (!await input.worktreeLeaseStore.hasTransitionEvidence({
    candidateId: attempt.candidateId,
    leaseId: attempt.leaseId,
    previousLeaseDigest: attempt.verifyingLeaseDigest,
    toState,
    reasonCode,
  })) {
    throw new Error(
      'Candidate Gate lease transition evidence is missing.',
    );
  }
}

function matchesVerifyingLease(
  attempt: CandidateGateAttemptV1,
  lease: {
    readonly leaseId: string;
    readonly casRevision: number;
    readonly leaseDigest: string;
    readonly gatePlanDigest: string;
  },
): boolean {
  return attempt.leaseId === lease.leaseId
    && attempt.leaseCasRevision === lease.casRevision
    && attempt.verifyingLeaseDigest === lease.leaseDigest
    && attempt.gatePlanDigest === lease.gatePlanDigest;
}

function transitionReason(
  prefix:
    | 'candidate_gate_passed'
    | 'candidate_gate_failed'
    | 'candidate_gate_error',
  attempt: CandidateGateAttemptV1,
): string {
  return `${prefix}:${attempt.candidateGateAttemptId}`;
}

async function inspectAttemptOrNull(
  input: RunCandidateGateAttemptInputV1,
): Promise<CandidateGateAttemptV1 | null> {
  try {
    return await input.candidateGateAttemptStore.inspect({
      candidateId: input.rootCapability.candidateId,
      candidateGateAttemptId: input.runtime.attemptId,
    });
  } catch (error) {
    if (error instanceof CandidateGateAttemptStoreError
      && error.reasonCode === 'candidate_gate_attempt_not_found') {
      return null;
    }
    throw error;
  }
}

async function requireCurrentDeltaSeal(
  input: RunCandidateGateAttemptInputV1,
) {
  const seal = await input.candidateDeltaStore.sealDelta({
    worktreeLeaseStore: input.worktreeLeaseStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
  });
  if (seal.candidateId !== input.rootCapability.candidateId) {
    throw new Error('Candidate Gate delta seal identity is stale.');
  }
  return seal;
}

function liveInput(input: RunCandidateGateAttemptInputV1) {
  return {
    worktreeLeaseStore: input.worktreeLeaseStore,
    candidateDeltaStore: input.candidateDeltaStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
  };
}

function assertInput(input: RunCandidateGateAttemptInputV1): void {
  if (!(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.candidateDeltaStore instanceof CandidateDeltaStore)
    || !(input.candidateGateAttemptStore
      instanceof CandidateGateAttemptStore)
    || !(input.rootCapability instanceof CandidateRootCapabilityV1)
    || !(input.verifyingBinding instanceof WorktreeLeaseBindingV1)
    || input.runtime.attemptId.length === 0
    || input.objective.length === 0
    || input.parentToolCallId.length === 0) {
    throw new TypeError('Candidate Gate orchestration input is invalid.');
  }
}
