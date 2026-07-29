import {
  createCandidateGateResult,
  validateCandidateGateResult,
  type CandidateGateOutcomeV1,
  type CandidateGateResultV1,
} from './candidate-gate';
import { canonicalDigest } from './finish-line';
import { containsSensitiveText } from './redaction';

export type CandidateGateAttemptStateV1 =
  | 'prepared'
  | 'deterministic_completed'
  | 'reviewing'
  | 'completed';

export type CandidateDeterministicGateStatusV1 =
  | 'passed'
  | 'blocked'
  | 'error';

export type CandidateReviewerVerdictStatusV1 =
  | 'PASS'
  | 'NEEDS_WORK'
  | 'INCONCLUSIVE';

export interface CandidateGateAttemptV1 {
  readonly schemaVersion: 1;
  readonly candidateGateAttemptId: string;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly leaseCasRevision: number;
  readonly verifyingLeaseDigest: string;
  readonly candidateDeltaDigest: string;
  readonly candidateDeltaSealDigest: string;
  readonly gatePlanDigest: string;
  readonly state: CandidateGateAttemptStateV1;
  readonly deterministicGateResultDigest: string | null;
  readonly deterministicGateStatus:
    CandidateDeterministicGateStatusV1 | null;
  readonly reviewPlanDigest: string | null;
  readonly reviewSubjectManifestDigest: string | null;
  readonly reviewerInputDigest: string | null;
  readonly reviewerPayloadDigest: string | null;
  readonly freshCriteriaVerdictDigest: string | null;
  readonly reviewerVerdictStatus:
    CandidateReviewerVerdictStatusV1 | null;
  readonly reasonCode: string | null;
  readonly candidateGateResult: CandidateGateResultV1 | null;
  readonly casRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateDigest: string;
}

export function createCandidateGateAttempt(input: {
  readonly candidateGateAttemptId: string;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly leaseCasRevision: number;
  readonly verifyingLeaseDigest: string;
  readonly candidateDeltaDigest: string;
  readonly candidateDeltaSealDigest: string;
  readonly gatePlanDigest: string;
  readonly createdAt: string;
}): CandidateGateAttemptV1 {
  const core = {
    schemaVersion: 1 as const,
    candidateGateAttemptId: input.candidateGateAttemptId,
    candidateId: input.candidateId,
    leaseId: input.leaseId,
    leaseCasRevision: input.leaseCasRevision,
    verifyingLeaseDigest: input.verifyingLeaseDigest,
    candidateDeltaDigest: input.candidateDeltaDigest,
    candidateDeltaSealDigest: input.candidateDeltaSealDigest,
    gatePlanDigest: input.gatePlanDigest,
    state: 'prepared' as const,
    deterministicGateResultDigest: null,
    deterministicGateStatus: null,
    reviewPlanDigest: null,
    reviewSubjectManifestDigest: null,
    reviewerInputDigest: null,
    reviewerPayloadDigest: null,
    freshCriteriaVerdictDigest: null,
    reviewerVerdictStatus: null,
    reasonCode: null,
    candidateGateResult: null,
    casRevision: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  return seal(core);
}

export function recordCandidateDeterministicGate(
  current: CandidateGateAttemptV1,
  input: {
    readonly deterministicGateResultDigest: string;
    readonly deterministicGateStatus: CandidateDeterministicGateStatusV1;
    readonly reviewPlanDigest: string | null;
    readonly occurredAt: string;
  },
): CandidateGateAttemptV1 {
  assertCurrent(current, 'prepared');
  if (!isDigest(input.deterministicGateResultDigest)
    || (input.deterministicGateStatus !== 'passed'
      && input.deterministicGateStatus !== 'blocked'
      && input.deterministicGateStatus !== 'error')
    || (input.deterministicGateStatus === 'passed')
      !== isDigest(input.reviewPlanDigest)) {
    throw new TypeError('Candidate deterministic Gate evidence is invalid.');
  }
  return transition(current, {
    state: 'deterministic_completed',
    deterministicGateResultDigest: input.deterministicGateResultDigest,
    deterministicGateStatus: input.deterministicGateStatus,
    reviewPlanDigest: input.reviewPlanDigest,
    occurredAt: input.occurredAt,
  });
}

export function beginCandidateGateReview(
  current: CandidateGateAttemptV1,
  input: {
    readonly reviewSubjectManifestDigest: string;
    readonly reviewerInputDigest: string;
    readonly occurredAt: string;
  },
): CandidateGateAttemptV1 {
  assertCurrent(current, 'deterministic_completed');
  if (current.deterministicGateStatus !== 'passed'
    || !isDigest(current.reviewPlanDigest)
    || !isDigest(input.reviewSubjectManifestDigest)
    || !isDigest(input.reviewerInputDigest)) {
    throw new TypeError('Candidate reviewer binding is invalid.');
  }
  return transition(current, {
    state: 'reviewing',
    reviewSubjectManifestDigest: input.reviewSubjectManifestDigest,
    reviewerInputDigest: input.reviewerInputDigest,
    occurredAt: input.occurredAt,
  });
}

export function completeCandidateGateAttempt(
  current: CandidateGateAttemptV1,
  input: {
    readonly outcome: CandidateGateOutcomeV1;
    readonly reasonCode: string;
    readonly reviewerPayloadDigest: string | null;
    readonly freshCriteriaVerdictDigest: string | null;
    readonly reviewerVerdictStatus:
      CandidateReviewerVerdictStatusV1 | null;
    readonly occurredAt: string;
  },
): CandidateGateAttemptV1 {
  if (!validateCandidateGateAttempt(current)
    || (current.state !== 'deterministic_completed'
      && current.state !== 'reviewing')
    || !isReasonCode(input.reasonCode)) {
    throw new TypeError('Candidate Gate completion input is invalid.');
  }
  assertCompletion(current, input);
  const candidateGateResult = createCandidateGateResult({
    candidateId: current.candidateId,
    candidateDeltaDigest: current.candidateDeltaDigest,
    candidateGateAttemptId: current.candidateGateAttemptId,
    candidateGateOutcome: input.outcome,
  });
  return transition(current, {
    state: 'completed',
    reviewerPayloadDigest: input.reviewerPayloadDigest,
    freshCriteriaVerdictDigest: input.freshCriteriaVerdictDigest,
    reviewerVerdictStatus: input.reviewerVerdictStatus,
    reasonCode: input.reasonCode,
    candidateGateResult,
    occurredAt: input.occurredAt,
  });
}

export function validateCandidateGateAttempt(
  value: unknown,
): value is CandidateGateAttemptV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== ATTEMPT_KEYS
      .toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['candidateGateAttemptId'])
    || !isUuid(value['candidateId'])
    || !isUuid(value['leaseId'])
    || !isNonNegativeInteger(value['leaseCasRevision'])
    || !isDigest(value['verifyingLeaseDigest'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isDigest(value['candidateDeltaSealDigest'])
    || !isDigest(value['gatePlanDigest'])
    || !isState(value['state'])
    || !isNullableDigest(value['deterministicGateResultDigest'])
    || !isNullableDeterministicStatus(value['deterministicGateStatus'])
    || !isNullableDigest(value['reviewPlanDigest'])
    || !isNullableDigest(value['reviewSubjectManifestDigest'])
    || !isNullableDigest(value['reviewerInputDigest'])
    || !isNullableDigest(value['reviewerPayloadDigest'])
    || !isNullableDigest(value['freshCriteriaVerdictDigest'])
    || !isNullableReviewerStatus(value['reviewerVerdictStatus'])
    || (value['reasonCode'] !== null && !isReasonCode(value['reasonCode']))
    || (value['candidateGateResult'] !== null
      && !validateCandidateGateResult(value['candidateGateResult']))
    || !isNonNegativeInteger(value['casRevision'])
    || !isCanonicalTimestamp(value['createdAt'])
    || !isCanonicalTimestamp(value['updatedAt'])
    || Date.parse(value['createdAt'])
      > Date.parse(value['updatedAt'])
    || !isDigest(value['stateDigest'])) {
    return false;
  }
  const attempt = value as unknown as CandidateGateAttemptV1;
  if (!stateFieldsAreConsistent(attempt)) return false;
  const { stateDigest, ...core } = attempt;
  return canonicalDigest('wukong/candidate-gate-attempt/v1', core)
    === stateDigest;
}

const ATTEMPT_KEYS = [
  'candidateDeltaDigest',
  'candidateDeltaSealDigest',
  'candidateGateAttemptId',
  'candidateGateResult',
  'candidateId',
  'casRevision',
  'createdAt',
  'deterministicGateResultDigest',
  'deterministicGateStatus',
  'freshCriteriaVerdictDigest',
  'gatePlanDigest',
  'leaseCasRevision',
  'leaseId',
  'reasonCode',
  'reviewPlanDigest',
  'reviewSubjectManifestDigest',
  'reviewerInputDigest',
  'reviewerPayloadDigest',
  'reviewerVerdictStatus',
  'schemaVersion',
  'state',
  'stateDigest',
  'updatedAt',
  'verifyingLeaseDigest',
] as const;

function transition(
  current: CandidateGateAttemptV1,
  updates: Partial<CandidateGateAttemptV1> & {
    readonly state: CandidateGateAttemptStateV1;
    readonly occurredAt: string;
  },
): CandidateGateAttemptV1 {
  if (!isCanonicalTimestamp(updates.occurredAt)
    || Date.parse(updates.occurredAt) < Date.parse(current.updatedAt)) {
    throw new TypeError('Candidate Gate attempt transition time is invalid.');
  }
  const { occurredAt, ...fields } = updates;
  const { stateDigest: _stateDigest, ...core } = current;
  return seal({
    ...core,
    ...fields,
    casRevision: current.casRevision + 1,
    updatedAt: occurredAt,
  });
}

function seal(
  core: Omit<CandidateGateAttemptV1, 'stateDigest'>,
): CandidateGateAttemptV1 {
  const attempt = Object.freeze({
    ...core,
    stateDigest: canonicalDigest(
      'wukong/candidate-gate-attempt/v1',
      core,
    ),
  });
  if (!validateCandidateGateAttempt(attempt)) {
    throw new TypeError('The candidate Gate attempt is invalid.');
  }
  return attempt;
}

function assertCurrent(
  current: CandidateGateAttemptV1,
  state: CandidateGateAttemptStateV1,
): void {
  if (!validateCandidateGateAttempt(current) || current.state !== state) {
    throw new TypeError(`Candidate Gate attempt must be ${state}.`);
  }
}

function assertCompletion(
  current: CandidateGateAttemptV1,
  input: {
    readonly outcome: CandidateGateOutcomeV1;
    readonly reviewerPayloadDigest: string | null;
    readonly freshCriteriaVerdictDigest: string | null;
    readonly reviewerVerdictStatus:
      CandidateReviewerVerdictStatusV1 | null;
  },
): void {
  if (current.state === 'deterministic_completed') {
    const expected = current.deterministicGateStatus === 'blocked'
      ? 'NEEDS_WORK'
      : current.deterministicGateStatus === 'error'
        ? 'ERROR'
        : null;
    if (expected === null
      || input.outcome !== expected
      || input.reviewerPayloadDigest !== null
      || input.freshCriteriaVerdictDigest !== null
      || input.reviewerVerdictStatus !== null) {
      throw new TypeError(
        'A passing deterministic Gate requires a reviewer before completion.',
      );
    }
    return;
  }
  if (current.deterministicGateStatus !== 'passed'
    || !isDigest(current.reviewSubjectManifestDigest)
    || !isDigest(current.reviewerInputDigest)) {
    throw new TypeError('Candidate reviewer evidence is incomplete.');
  }
  if (input.reviewerVerdictStatus === null) {
    if (input.outcome !== 'ERROR'
      || !isDigest(input.reviewerPayloadDigest)
      || input.freshCriteriaVerdictDigest !== null) {
      throw new TypeError('Missing reviewer verdict must complete as ERROR.');
    }
    return;
  }
  if (!isDigest(input.reviewerPayloadDigest)
    || !isDigest(input.freshCriteriaVerdictDigest)
    || (input.reviewerVerdictStatus === 'PASS'
      && input.outcome !== 'PASS')
    || (input.reviewerVerdictStatus === 'NEEDS_WORK'
      && input.outcome !== 'NEEDS_WORK')
    || (input.reviewerVerdictStatus === 'INCONCLUSIVE'
      && input.outcome !== 'ERROR')) {
    throw new TypeError('Candidate reviewer outcome is contradictory.');
  }
}

function stateFieldsAreConsistent(
  attempt: CandidateGateAttemptV1,
): boolean {
  const deterministicPresent =
    attempt.deterministicGateResultDigest !== null
    && attempt.deterministicGateStatus !== null;
  const reviewPlanPresent = attempt.reviewPlanDigest !== null;
  const reviewStarted = attempt.reviewSubjectManifestDigest !== null
    && attempt.reviewerInputDigest !== null;
  const reviewerPayloadPresent = attempt.reviewerPayloadDigest !== null;
  const reviewerCompleted = attempt.reviewerVerdictStatus !== null
    && attempt.freshCriteriaVerdictDigest !== null;
  if (attempt.state === 'prepared') {
    return !deterministicPresent
      && !reviewPlanPresent
      && !reviewStarted
      && !reviewerPayloadPresent
      && !reviewerCompleted
      && attempt.reasonCode === null
      && attempt.candidateGateResult === null
      && attempt.casRevision === 0;
  }
  if (!deterministicPresent) return false;
  if (attempt.deterministicGateStatus === 'passed' !== reviewPlanPresent) {
    return false;
  }
  if (attempt.state === 'deterministic_completed') {
    return !reviewStarted
      && !reviewerPayloadPresent
      && !reviewerCompleted
      && attempt.reasonCode === null
      && attempt.candidateGateResult === null;
  }
  if (attempt.state === 'reviewing') {
    return attempt.deterministicGateStatus === 'passed'
      && reviewStarted
      && !reviewerPayloadPresent
      && !reviewerCompleted
      && attempt.reasonCode === null
      && attempt.candidateGateResult === null;
  }
  if (attempt.reasonCode === null
    || attempt.candidateGateResult === null
    || attempt.candidateGateResult.candidateId !== attempt.candidateId
    || attempt.candidateGateResult.candidateDeltaDigest
      !== attempt.candidateDeltaDigest
    || attempt.candidateGateResult.candidateGateAttemptId
      !== attempt.candidateGateAttemptId) {
    return false;
  }
  if (attempt.deterministicGateStatus !== 'passed') {
    return !reviewStarted
      && !reviewerPayloadPresent
      && !reviewerCompleted
      && attempt.candidateGateResult.candidateGateOutcome
        === (attempt.deterministicGateStatus === 'blocked'
          ? 'NEEDS_WORK'
          : 'ERROR');
  }
  if (!reviewStarted || !reviewerPayloadPresent) return false;
  if (!reviewerCompleted) {
    return attempt.candidateGateResult.candidateGateOutcome === 'ERROR'
      && attempt.reviewerVerdictStatus === null
      && attempt.freshCriteriaVerdictDigest === null;
  }
  const expectedOutcome = attempt.reviewerVerdictStatus === 'PASS'
    ? 'PASS'
    : attempt.reviewerVerdictStatus === 'NEEDS_WORK'
      ? 'NEEDS_WORK'
      : 'ERROR';
  return attempt.candidateGateResult.candidateGateOutcome === expectedOutcome;
}

function isState(value: unknown): value is CandidateGateAttemptStateV1 {
  return value === 'prepared'
    || value === 'deterministic_completed'
    || value === 'reviewing'
    || value === 'completed';
}

function isNullableDeterministicStatus(
  value: unknown,
): value is CandidateDeterministicGateStatusV1 | null {
  return value === null
    || value === 'passed'
    || value === 'blocked'
    || value === 'error';
}

function isNullableReviewerStatus(
  value: unknown,
): value is CandidateReviewerVerdictStatusV1 | null {
  return value === null
    || value === 'PASS'
    || value === 'NEEDS_WORK'
    || value === 'INCONCLUSIVE';
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    && !containsSensitiveText(value);
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
