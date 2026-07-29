import { describe, expect, it } from 'vitest';

import {
  beginCandidateGateReview,
  canonicalDigest,
  completeCandidateGateAttempt,
  createCandidateGateAttempt,
  recordCandidateDeterministicGate,
  validateCandidateGateAttempt,
} from '../src';

const IDS = {
  attempt: '10000000-0000-4000-8000-000000000001',
  candidate: '20000000-0000-4000-8000-000000000002',
  lease: '30000000-0000-4000-8000-000000000003',
} as const;

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-gate-attempt/v1', label);
}

function prepared() {
  return createCandidateGateAttempt({
    candidateGateAttemptId: IDS.attempt,
    candidateId: IDS.candidate,
    leaseId: IDS.lease,
    leaseCasRevision: 4,
    verifyingLeaseDigest: digest('lease'),
    candidateDeltaDigest: digest('delta'),
    candidateDeltaSealDigest: digest('seal'),
    gatePlanDigest: digest('gate-plan'),
    createdAt: '2026-07-29T08:00:00.000Z',
  });
}

describe('CandidateGateAttemptV1', () => {
  it('requires deterministic PASS and reviewer PASS before final PASS', () => {
    const deterministic = recordCandidateDeterministicGate(prepared(), {
      deterministicGateResultDigest: digest('deterministic'),
      deterministicGateStatus: 'passed',
      reviewPlanDigest: digest('review-plan'),
      occurredAt: '2026-07-29T08:00:01.000Z',
    });
    expect(() => completeCandidateGateAttempt(deterministic, {
      outcome: 'PASS',
      reasonCode: 'passed',
      reviewerPayloadDigest: null,
      freshCriteriaVerdictDigest: null,
      reviewerVerdictStatus: null,
      occurredAt: '2026-07-29T08:00:02.000Z',
    })).toThrow(/requires a reviewer/u);

    const reviewing = beginCandidateGateReview(deterministic, {
      reviewSubjectManifestDigest: digest('manifest'),
      reviewerInputDigest: digest('reviewer-input'),
      occurredAt: '2026-07-29T08:00:02.000Z',
    });
    const completed = completeCandidateGateAttempt(reviewing, {
      outcome: 'PASS',
      reasonCode: 'passed',
      reviewerPayloadDigest: digest('payload'),
      freshCriteriaVerdictDigest: digest('verdict'),
      reviewerVerdictStatus: 'PASS',
      occurredAt: '2026-07-29T08:00:03.000Z',
    });

    expect(completed.state).toBe('completed');
    expect(completed.candidateGateResult?.candidateGateOutcome).toBe('PASS');
    expect(completed.casRevision).toBe(3);
    expect(validateCandidateGateAttempt(completed)).toBe(true);
  });

  it('completes deterministic blockers without fabricating reviewer evidence', () => {
    const deterministic = recordCandidateDeterministicGate(prepared(), {
      deterministicGateResultDigest: digest('deterministic-blocked'),
      deterministicGateStatus: 'blocked',
      reviewPlanDigest: null,
      occurredAt: '2026-07-29T08:00:01.000Z',
    });
    const completed = completeCandidateGateAttempt(deterministic, {
      outcome: 'NEEDS_WORK',
      reasonCode: 'check_failed',
      reviewerPayloadDigest: null,
      freshCriteriaVerdictDigest: null,
      reviewerVerdictStatus: null,
      occurredAt: '2026-07-29T08:00:02.000Z',
    });

    expect(completed.candidateGateResult?.candidateGateOutcome)
      .toBe('NEEDS_WORK');
    expect(completed.reviewSubjectManifestDigest).toBeNull();
    expect(validateCandidateGateAttempt(completed)).toBe(true);
  });

  it('maps missing or inconclusive reviewer output only to ERROR', () => {
    const deterministic = recordCandidateDeterministicGate(prepared(), {
      deterministicGateResultDigest: digest('deterministic'),
      deterministicGateStatus: 'passed',
      reviewPlanDigest: digest('review-plan'),
      occurredAt: '2026-07-29T08:00:01.000Z',
    });
    const reviewing = beginCandidateGateReview(deterministic, {
      reviewSubjectManifestDigest: digest('manifest'),
      reviewerInputDigest: digest('reviewer-input'),
      occurredAt: '2026-07-29T08:00:02.000Z',
    });

    expect(() => completeCandidateGateAttempt(reviewing, {
      outcome: 'NEEDS_WORK',
      reasonCode: 'reviewer_invalid_output',
      reviewerPayloadDigest: digest('invalid-payload'),
      freshCriteriaVerdictDigest: null,
      reviewerVerdictStatus: null,
      occurredAt: '2026-07-29T08:00:03.000Z',
    })).toThrow(/must complete as ERROR/u);
    expect(completeCandidateGateAttempt(reviewing, {
      outcome: 'ERROR',
      reasonCode: 'reviewer_invalid_output',
      reviewerPayloadDigest: digest('invalid-payload'),
      freshCriteriaVerdictDigest: null,
      reviewerVerdictStatus: null,
      occurredAt: '2026-07-29T08:00:03.000Z',
    }).candidateGateResult?.candidateGateOutcome).toBe('ERROR');
    expect(completeCandidateGateAttempt(reviewing, {
      outcome: 'ERROR',
      reasonCode: 'review_evidence_inconclusive',
      reviewerPayloadDigest: digest('payload'),
      freshCriteriaVerdictDigest: digest('inconclusive'),
      reviewerVerdictStatus: 'INCONCLUSIVE',
      occurredAt: '2026-07-29T08:00:03.000Z',
    }).candidateGateResult?.candidateGateOutcome).toBe('ERROR');
  });

  it('rejects illegal order, contradictory outcomes and tampering', () => {
    expect(() => beginCandidateGateReview(prepared(), {
      reviewSubjectManifestDigest: digest('manifest'),
      reviewerInputDigest: digest('input'),
      occurredAt: '2026-07-29T08:00:01.000Z',
    })).toThrow(/must be deterministic_completed/u);
    expect(() => recordCandidateDeterministicGate(prepared(), {
      deterministicGateResultDigest: digest('deterministic'),
      deterministicGateStatus: 'passed',
      reviewPlanDigest: null,
      occurredAt: '2026-07-29T08:00:01.000Z',
    })).toThrow(/evidence is invalid/u);
    expect(validateCandidateGateAttempt({
      ...prepared(),
      gatePlanDigest: digest('tampered'),
    })).toBe(false);
  });
});
