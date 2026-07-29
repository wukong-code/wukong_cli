import { canonicalDigest } from './finish-line';

export type CandidateGateOutcomeV1 = 'PASS' | 'NEEDS_WORK' | 'ERROR';

export interface CandidateGateResultV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly candidateDeltaDigest: string;
  readonly candidateGateAttemptId: string;
  readonly candidateGateOutcome: CandidateGateOutcomeV1;
  readonly candidateGateResultDigest: string;
}

export function createCandidateGateResult(input: {
  readonly candidateId: string;
  readonly candidateDeltaDigest: string;
  readonly candidateGateAttemptId: string;
  readonly candidateGateOutcome: CandidateGateOutcomeV1;
}): CandidateGateResultV1 {
  const core = {
    schemaVersion: 1 as const,
    candidateId: input.candidateId,
    candidateDeltaDigest: input.candidateDeltaDigest,
    candidateGateAttemptId: input.candidateGateAttemptId,
    candidateGateOutcome: input.candidateGateOutcome,
  };
  const result = Object.freeze({
    ...core,
    candidateGateResultDigest: canonicalDigest(
      'wukong/candidate-gate-result/v1',
      core,
    ),
  });
  if (!validateCandidateGateResult(result)) {
    throw new TypeError('The candidate Gate result is invalid.');
  }
  return result;
}

export function validateCandidateGateResult(
  value: unknown,
): value is CandidateGateResultV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'candidateDeltaDigest',
      'candidateGateAttemptId',
      'candidateGateOutcome',
      'candidateGateResultDigest',
      'candidateId',
      'schemaVersion',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['candidateId'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isUuid(value['candidateGateAttemptId'])
    || (value['candidateGateOutcome'] !== 'PASS'
      && value['candidateGateOutcome'] !== 'NEEDS_WORK'
      && value['candidateGateOutcome'] !== 'ERROR')
    || !isDigest(value['candidateGateResultDigest'])) {
    return false;
  }
  const result = value as unknown as CandidateGateResultV1;
  const { candidateGateResultDigest, ...core } = result;
  return canonicalDigest('wukong/candidate-gate-result/v1', core)
    === candidateGateResultDigest;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
