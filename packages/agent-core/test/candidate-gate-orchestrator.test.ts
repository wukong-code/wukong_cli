import {
  beginCandidateGateReview,
  canonicalDigest,
  completeCandidateGateAttempt,
  createCandidateGateAttempt,
  recordCandidateDeterministicGate,
  type CandidateGateAttemptV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../src/agent';
import type { LoopGateReviewRuntimeV2 } from '../src/agent/goal';
import { CandidateDeltaStore } from '../src/candidate-delta-store';
import { CandidateGateAttemptStore } from '../src/candidate-gate-attempt-store';
import { runCandidateGateAttempt } from '../src/candidate-gate-orchestrator';
import type { CandidateBrokeredReviewPlanV1 } from '../src/candidate-review-plan';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseBindingV1,
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const ATTEMPT_ID = '019f8ca0-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8ca0-0001-7abc-8def-0123456789ab';
const LEASE_ID = '019f8ca0-0002-7abc-8def-0123456789ab';

describe('runCandidateGateAttempt recovery join', () => {
  it.each([
    ['PASS', 'awaiting_promotion'],
    ['NEEDS_WORK', 'active'],
    ['ERROR', 'active'],
  ] as const)(
    'joins a durable %s without rerunning candidate evidence',
    async (outcome, expectedLeaseState) => {
      const value = fixture(completedAttempt(outcome));

      const result = await runCandidateGateAttempt(value.input);

      expect(result.attempt.candidateGateResult?.candidateGateOutcome)
        .toBe(outcome);
      expect(result.leaseState).toBe(expectedLeaseState);
      if (outcome === 'PASS') {
        expect(value.transition).toHaveBeenCalledWith(
          value.input.verifyingBinding,
          'awaiting_promotion',
          `candidate_gate_passed:${ATTEMPT_ID}`,
        );
      } else if (outcome === 'NEEDS_WORK') {
        expect(value.transition).toHaveBeenCalledWith(
          value.input.verifyingBinding,
          'active',
          `candidate_gate_failed:${ATTEMPT_ID}`,
        );
      } else {
        expect(value.transition).toHaveBeenCalledWith(
          value.input.verifyingBinding,
          'active',
          `candidate_gate_error:${ATTEMPT_ID}`,
        );
      }
    },
  );

  it('rejoins an already transitioned PASS only with exact journal evidence', async () => {
    const attempt = completedAttempt('PASS');
    const value = fixture(attempt, 'awaiting_promotion');
    const evidence = vi.spyOn(
      value.input.worktreeLeaseStore,
      'hasTransitionEvidence',
    ).mockResolvedValue(true);

    const result = await runCandidateGateAttempt(value.input);

    expect(result.leaseState).toBe('awaiting_promotion');
    expect(value.transition).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      leaseId: LEASE_ID,
      previousLeaseDigest: attempt.verifyingLeaseDigest,
      toState: 'awaiting_promotion',
      reasonCode: `candidate_gate_passed:${ATTEMPT_ID}`,
    });
  });

  it('rejoins an already recovered ERROR only with exact journal evidence', async () => {
    const attempt = completedAttempt('ERROR');
    const value = fixture(attempt, 'active');
    const evidence = vi.spyOn(
      value.input.worktreeLeaseStore,
      'hasTransitionEvidence',
    ).mockResolvedValue(true);

    const result = await runCandidateGateAttempt(value.input);

    expect(result.leaseState).toBe('active');
    expect(value.transition).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      leaseId: LEASE_ID,
      previousLeaseDigest: attempt.verifyingLeaseDigest,
      toState: 'active',
      reasonCode: `candidate_gate_error:${ATTEMPT_ID}`,
    });
  });
});

function fixture(
  attempt: CandidateGateAttemptV1,
  state: WorktreeLeaseV1['state'] = 'verifying',
): {
  readonly input: Parameters<typeof runCandidateGateAttempt>[0];
  readonly transition: ReturnType<typeof vi.fn>;
} {
  const rawFencingToken = 'raw-fencing-token';
  const lease = {
    schemaVersion: 1,
    leaseId: LEASE_ID,
    candidateId: CANDIDATE_ID,
    state,
    casRevision: 5,
    leaseDigest: digest('lease'),
    gatePlanDigest: digest('gate-plan'),
    worktreeIdentity: digest('worktree'),
    fencingTokenDigest: digest('fencing'),
  } as unknown as WorktreeLeaseV1;
  const verifyingBinding = WorktreeLeaseBindingV1.create(
    lease,
    rawFencingToken,
  );
  const rootCapability = CandidateRootCapabilityV1.create(
    lease,
    '/tmp/wukong-orchestrator-candidate',
    '/tmp/wukong-orchestrator-candidate',
    rawFencingToken,
  );
  const worktreeLeaseStore = new WorktreeLeaseStore({
    candidatesRootDirectory: '/tmp/wukong-orchestrator-candidates',
  });
  vi.spyOn(worktreeLeaseStore, 'inspect').mockResolvedValue(lease);
  const transition = vi.spyOn(
    worktreeLeaseStore,
    'transition',
  ).mockImplementation(async (_binding, state) => {
    const next = { ...lease, state } as WorktreeLeaseV1;
    return {
      lease: next,
      binding: WorktreeLeaseBindingV1.create(next, rawFencingToken),
    };
  });
  const candidateGateAttemptStore = new CandidateGateAttemptStore({
    privateRootDirectory: '/tmp/wukong-orchestrator-candidates',
    sourceRepositoryRoot: '/tmp/wukong-orchestrator-source',
  });
  vi.spyOn(candidateGateAttemptStore, 'inspect').mockResolvedValue(attempt);
  const candidateDeltaStore = new CandidateDeltaStore({
    privateRootDirectory: '/tmp/wukong-orchestrator-candidates',
    sourceRepositoryRoot: '/tmp/wukong-orchestrator-source',
  });
  const reviewPlan = {
    reviewPlanDigest: digest('review-plan'),
  } as CandidateBrokeredReviewPlanV1;
  const runtime = {
    attemptId: ATTEMPT_ID,
  } as LoopGateReviewRuntimeV2;
  return {
    input: {
      agent: {} as Pick<
        Agent,
        'config' | 'modelProvider' | 'subagentHost'
      >,
      worktreeLeaseStore,
      candidateDeltaStore,
      candidateGateAttemptStore,
      rootCapability,
      verifyingBinding,
      bootstrapPlan: {} as never,
      contract: {} as never,
      runtime,
      objective: 'Join candidate Gate',
      parentToolCallId: 'tool-call',
      signal: new AbortController().signal,
    },
    transition,
  };
}

function completedAttempt(
  outcome: 'PASS' | 'NEEDS_WORK' | 'ERROR',
): CandidateGateAttemptV1 {
  const prepared = createCandidateGateAttempt({
    candidateGateAttemptId: ATTEMPT_ID,
    candidateId: CANDIDATE_ID,
    leaseId: LEASE_ID,
    leaseCasRevision: 5,
    verifyingLeaseDigest: digest('lease'),
    candidateDeltaDigest: digest('delta'),
    candidateDeltaSealDigest: digest('seal'),
    gatePlanDigest: digest('gate-plan'),
    createdAt: '2026-07-29T11:00:00.000Z',
  });
  if (outcome === 'PASS') {
    const deterministic = recordCandidateDeterministicGate(prepared, {
      deterministicGateResultDigest: digest('deterministic'),
      deterministicGateStatus: 'passed',
      reviewPlanDigest: digest('review-plan'),
      occurredAt: '2026-07-29T11:00:01.000Z',
    });
    const reviewing = beginCandidateGateReview(deterministic, {
      reviewSubjectManifestDigest: digest('manifest'),
      reviewerInputDigest: digest('reviewer-input'),
      occurredAt: '2026-07-29T11:00:02.000Z',
    });
    return completeCandidateGateAttempt(reviewing, {
      outcome,
      reasonCode: 'passed',
      reviewerPayloadDigest: digest('payload'),
      freshCriteriaVerdictDigest: digest('verdict'),
      reviewerVerdictStatus: 'PASS',
      occurredAt: '2026-07-29T11:00:03.000Z',
    });
  }
  const deterministic = recordCandidateDeterministicGate(prepared, {
    deterministicGateResultDigest: digest('deterministic'),
    deterministicGateStatus:
      outcome === 'NEEDS_WORK' ? 'blocked' : 'error',
    reviewPlanDigest: null,
    occurredAt: '2026-07-29T11:00:01.000Z',
  });
  return completeCandidateGateAttempt(deterministic, {
    outcome,
    reasonCode: outcome === 'NEEDS_WORK'
      ? 'check_failed'
      : 'gate_error',
    reviewerPayloadDigest: null,
    freshCriteriaVerdictDigest: null,
    reviewerVerdictStatus: null,
    occurredAt: '2026-07-29T11:00:02.000Z',
  });
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/candidate-gate-orchestrator/v1',
    label,
  );
}
