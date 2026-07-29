import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createCandidateGateResult,
  validateCandidateGateResult,
} from '../src';

const CANDIDATE_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-gate-result/v1', label);
}

describe('CandidateGateResultV1', () => {
  it.each(['PASS', 'NEEDS_WORK', 'ERROR'] as const)(
    'seals the %s outcome to one exact candidate delta',
    (candidateGateOutcome) => {
      const result = createCandidateGateResult({
        candidateId: CANDIDATE_ID,
        candidateDeltaDigest: digest('delta'),
        candidateGateAttemptId: ATTEMPT_ID,
        candidateGateOutcome,
      });

      expect(validateCandidateGateResult(result)).toBe(true);
      expect(result.candidateGateOutcome).toBe(candidateGateOutcome);
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it('rejects stale ids, unknown outcomes and digest tampering', () => {
    const result = createCandidateGateResult({
      candidateId: CANDIDATE_ID,
      candidateDeltaDigest: digest('delta'),
      candidateGateAttemptId: ATTEMPT_ID,
      candidateGateOutcome: 'PASS',
    });

    expect(validateCandidateGateResult({
      ...result,
      candidateDeltaDigest: digest('other-delta'),
    })).toBe(false);
    expect(validateCandidateGateResult({
      ...result,
      candidateGateOutcome: 'MAYBE',
    })).toBe(false);
    expect(() => createCandidateGateResult({
      candidateId: 'not-a-uuid',
      candidateDeltaDigest: digest('delta'),
      candidateGateAttemptId: ATTEMPT_ID,
      candidateGateOutcome: 'PASS',
    })).toThrow(TypeError);
  });
});
