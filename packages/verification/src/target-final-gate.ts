import { canonicalDigest, canonicalJson } from './finish-line';
import { containsSensitiveText } from './redaction';
import type { TargetFinalGateOutcomeV1 } from './target-gate-completion-seal';

export interface TargetFinalGateCheckResultRefV1 {
  readonly schemaVersion: 1;
  readonly checkId: string;
  readonly commandDigest: string;
  readonly definitionDigest: string;
  readonly resultDigest: string;
  readonly status: 'passed' | 'failed' | 'error';
  readonly entryDigest: string;
}

export interface TargetFinalGateEvidenceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly evidenceSnapshotId: string;
  readonly finalGateAttemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly acceptanceContractDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly sourceSnapshotDigest: string;
  readonly candidateDeltaDigest: string;
  readonly promotionJournalId: string;
  readonly promotionJournalHeadDigest: string;
  readonly targetPromotionLeaseId: string;
  readonly targetFencingTokenDigest: string;
  readonly targetAfterFingerprintDigest: string;
  readonly orderedCheckResults:
    readonly TargetFinalGateCheckResultRefV1[];
  readonly builtinRiskScanResultDigest: string;
  readonly builtinRiskScanStatus: 'clean' | 'blocking' | 'error';
  readonly criteriaEvidenceDigest: string;
  readonly criteriaStatus: 'satisfied' | 'unsatisfied' | 'error';
  readonly freshReviewerResultDigest: string;
  readonly freshReviewerStatus: 'PASS' | 'NEEDS_WORK' | 'INCONCLUSIVE';
  readonly requiredGateCoverageDigest: string;
  readonly finalGateCompletedAt: string;
  readonly evidenceDigest: string;
}

export interface TargetFinalGateAttemptResultV1 {
  readonly schemaVersion: 1;
  readonly finalGateAttemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly promotionJournalId: string;
  readonly promotionJournalHeadDigest: string;
  readonly targetPromotionLeaseId: string;
  readonly targetFencingTokenDigest: string;
  readonly targetAfterFingerprintDigest: string;
  readonly evidenceSnapshotId: string;
  readonly evidenceDigest: string;
  readonly requiredGateCoverageDigest: string;
  readonly outcome: TargetFinalGateOutcomeV1;
  readonly reasonCode: string;
  readonly blockerKeys: readonly string[];
  readonly completedAt: string;
  readonly resultDigest: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_CHECKS = 24;
const MAX_BLOCKERS = 512;

export function createTargetFinalGateCheckResultRef(input: {
  readonly checkId: string;
  readonly commandDigest: string;
  readonly definitionDigest: string;
  readonly resultDigest: string;
  readonly status: TargetFinalGateCheckResultRefV1['status'];
}): TargetFinalGateCheckResultRefV1 {
  const core = { schemaVersion: 1 as const, ...input };
  const value = Object.freeze({
    ...core,
    entryDigest: canonicalDigest(
      'wukong/target-final-gate-check-ref/v1',
      core,
    ),
  });
  if (!validateTargetFinalGateCheckResultRef(value)) {
    throw new TypeError('Target Final Gate check reference is invalid.');
  }
  return value;
}

export function createTargetFinalGateEvidenceSnapshot(input: Omit<
  TargetFinalGateEvidenceSnapshotV1,
  'schemaVersion' | 'requiredGateCoverageDigest' | 'evidenceDigest'
>): TargetFinalGateEvidenceSnapshotV1 {
  const orderedCheckResults = Object.freeze([
    ...input.orderedCheckResults,
  ]);
  const requiredGateCoverageDigest = canonicalDigest(
    'wukong/target-final-gate-coverage/v1',
    {
      gatePlanDigest: input.gatePlanDigest,
      criteriaSelectionDigest: input.criteriaSelectionDigest,
      orderedCheckResults: orderedCheckResults.map((entry) => ({
        checkId: entry.checkId,
        commandDigest: entry.commandDigest,
        definitionDigest: entry.definitionDigest,
        resultDigest: entry.resultDigest,
        status: entry.status,
      })),
      builtinRiskScanResultDigest:
        input.builtinRiskScanResultDigest,
      builtinRiskScanStatus: input.builtinRiskScanStatus,
      criteriaEvidenceDigest: input.criteriaEvidenceDigest,
      criteriaStatus: input.criteriaStatus,
      freshReviewerResultDigest: input.freshReviewerResultDigest,
      freshReviewerStatus: input.freshReviewerStatus,
    },
  );
  const core = {
    schemaVersion: 1 as const,
    ...input,
    orderedCheckResults,
    requiredGateCoverageDigest,
  };
  const value = Object.freeze({
    ...core,
    evidenceDigest: canonicalDigest(
      'wukong/target-final-gate-evidence/v1',
      core,
    ),
  });
  if (!validateTargetFinalGateEvidenceSnapshot(value)) {
    throw new TypeError('Target Final Gate evidence input is invalid.');
  }
  return value;
}

export function createTargetFinalGateAttemptResult(input: {
  readonly evidence: TargetFinalGateEvidenceSnapshotV1;
  readonly requestedOutcome: TargetFinalGateOutcomeV1;
  readonly reasonCode: string;
  readonly blockerKeys: readonly string[];
  readonly completedAt: string;
}): TargetFinalGateAttemptResultV1 {
  if (!validateTargetFinalGateEvidenceSnapshot(input.evidence)
    || !isOutcome(input.requestedOutcome)
    || !isIdentifier(input.reasonCode)
    || !isTimestamp(input.completedAt)
    || Date.parse(input.completedAt)
      < Date.parse(input.evidence.finalGateCompletedAt)
    || !isBlockerList(input.blockerKeys)) {
    throw new TypeError('Target Final Gate attempt input is invalid.');
  }
  const passEligible = finalGateEvidenceCanPass(input.evidence)
    && input.blockerKeys.length === 0;
  const outcome: TargetFinalGateOutcomeV1 =
    input.requestedOutcome === 'PASS' && passEligible
      ? 'PASS'
      : input.requestedOutcome === 'ERROR'
        ? 'ERROR'
        : 'NEEDS_WORK';
  const core = {
    schemaVersion: 1 as const,
    finalGateAttemptId: input.evidence.finalGateAttemptId,
    runId: input.evidence.runId,
    contractId: input.evidence.contractId,
    promotionId: input.evidence.promotionId,
    candidateId: input.evidence.candidateId,
    promotionJournalId: input.evidence.promotionJournalId,
    promotionJournalHeadDigest:
      input.evidence.promotionJournalHeadDigest,
    targetPromotionLeaseId:
      input.evidence.targetPromotionLeaseId,
    targetFencingTokenDigest:
      input.evidence.targetFencingTokenDigest,
    targetAfterFingerprintDigest:
      input.evidence.targetAfterFingerprintDigest,
    evidenceSnapshotId: input.evidence.evidenceSnapshotId,
    evidenceDigest: input.evidence.evidenceDigest,
    requiredGateCoverageDigest:
      input.evidence.requiredGateCoverageDigest,
    outcome,
    reasonCode: input.reasonCode,
    blockerKeys: Object.freeze([...new Set(input.blockerKeys)].toSorted()),
    completedAt: input.completedAt,
  };
  const value = Object.freeze({
    ...core,
    resultDigest: canonicalDigest(
      'wukong/target-final-gate-attempt-result/v1',
      core,
    ),
  });
  if (!validateTargetFinalGateAttemptResult(value)) {
    throw new TypeError('Target Final Gate attempt result is invalid.');
  }
  return value;
}

export function finalGateEvidenceCanPass(
  evidence: TargetFinalGateEvidenceSnapshotV1,
): boolean {
  return validateTargetFinalGateEvidenceSnapshot(evidence)
    && evidence.orderedCheckResults.every(
      ({ status }) => status === 'passed',
    )
    && evidence.builtinRiskScanStatus === 'clean'
    && evidence.criteriaStatus === 'satisfied'
    && evidence.freshReviewerStatus === 'PASS';
}

export function validateTargetFinalGateCheckResultRef(
  value: unknown,
): value is TargetFinalGateCheckResultRefV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'checkId',
      'commandDigest',
      'definitionDigest',
      'entryDigest',
      'resultDigest',
      'schemaVersion',
      'status',
    ])
    || value['schemaVersion'] !== 1
    || !isIdentifier(value['checkId'])
    || !isDigest(value['commandDigest'])
    || !isDigest(value['definitionDigest'])
    || !isDigest(value['resultDigest'])
    || (value['status'] !== 'passed'
      && value['status'] !== 'failed'
      && value['status'] !== 'error')
    || !isDigest(value['entryDigest'])) {
    return false;
  }
  const entry = value as unknown as TargetFinalGateCheckResultRefV1;
  const { entryDigest, ...core } = entry;
  return canonicalDigest(
    'wukong/target-final-gate-check-ref/v1',
    core,
  ) === entryDigest;
}

export function validateTargetFinalGateEvidenceSnapshot(
  value: unknown,
): value is TargetFinalGateEvidenceSnapshotV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'acceptanceContractDigest',
      'builtinRiskScanResultDigest',
      'builtinRiskScanStatus',
      'candidateDeltaDigest',
      'candidateId',
      'contractId',
      'criteriaEvidenceDigest',
      'criteriaSelectionDigest',
      'criteriaStatus',
      'evidenceDigest',
      'evidenceSnapshotId',
      'finalGateAttemptId',
      'finalGateCompletedAt',
      'freshReviewerResultDigest',
      'freshReviewerStatus',
      'gatePlanDigest',
      'orderedCheckResults',
      'promotionId',
      'promotionJournalHeadDigest',
      'promotionJournalId',
      'requiredGateCoverageDigest',
      'runId',
      'schemaVersion',
      'sourceSnapshotDigest',
      'targetAfterFingerprintDigest',
      'targetFencingTokenDigest',
      'targetPromotionLeaseId',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['evidenceSnapshotId'])
    || !isUuid(value['finalGateAttemptId'])
    || !isIdentifier(value['runId'])
    || !isIdentifier(value['contractId'])
    || !isDigest(value['acceptanceContractDigest'])
    || !isDigest(value['gatePlanDigest'])
    || !isDigest(value['criteriaSelectionDigest'])
    || !isUuid(value['promotionId'])
    || !isUuid(value['candidateId'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isUuid(value['promotionJournalId'])
    || !isDigest(value['promotionJournalHeadDigest'])
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetFencingTokenDigest'])
    || !isDigest(value['targetAfterFingerprintDigest'])
    || !Array.isArray(value['orderedCheckResults'])
    || value['orderedCheckResults'].length > MAX_CHECKS
    || value['orderedCheckResults'].some(
      (entry) => !validateTargetFinalGateCheckResultRef(entry),
    )
    || !isDigest(value['builtinRiskScanResultDigest'])
    || (value['builtinRiskScanStatus'] !== 'clean'
      && value['builtinRiskScanStatus'] !== 'blocking'
      && value['builtinRiskScanStatus'] !== 'error')
    || !isDigest(value['criteriaEvidenceDigest'])
    || (value['criteriaStatus'] !== 'satisfied'
      && value['criteriaStatus'] !== 'unsatisfied'
      && value['criteriaStatus'] !== 'error')
    || !isDigest(value['freshReviewerResultDigest'])
    || (value['freshReviewerStatus'] !== 'PASS'
      && value['freshReviewerStatus'] !== 'NEEDS_WORK'
      && value['freshReviewerStatus'] !== 'INCONCLUSIVE')
    || !isDigest(value['requiredGateCoverageDigest'])
    || !isTimestamp(value['finalGateCompletedAt'])
    || !isDigest(value['evidenceDigest'])) {
    return false;
  }
  const evidence = value as unknown as TargetFinalGateEvidenceSnapshotV1;
  if (new Set(
    evidence.orderedCheckResults.map(({ checkId }) => checkId),
  ).size !== evidence.orderedCheckResults.length) {
    return false;
  }
  const expectedCoverage = canonicalDigest(
    'wukong/target-final-gate-coverage/v1',
    {
      gatePlanDigest: evidence.gatePlanDigest,
      criteriaSelectionDigest: evidence.criteriaSelectionDigest,
      orderedCheckResults: evidence.orderedCheckResults.map((entry) => ({
        checkId: entry.checkId,
        commandDigest: entry.commandDigest,
        definitionDigest: entry.definitionDigest,
        resultDigest: entry.resultDigest,
        status: entry.status,
      })),
      builtinRiskScanResultDigest:
        evidence.builtinRiskScanResultDigest,
      builtinRiskScanStatus: evidence.builtinRiskScanStatus,
      criteriaEvidenceDigest: evidence.criteriaEvidenceDigest,
      criteriaStatus: evidence.criteriaStatus,
      freshReviewerResultDigest: evidence.freshReviewerResultDigest,
      freshReviewerStatus: evidence.freshReviewerStatus,
    },
  );
  const { evidenceDigest, ...core } = evidence;
  return expectedCoverage === evidence.requiredGateCoverageDigest
    && canonicalDigest(
      'wukong/target-final-gate-evidence/v1',
      core,
    ) === evidenceDigest;
}

export function validateTargetFinalGateAttemptResult(
  value: unknown,
): value is TargetFinalGateAttemptResultV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'blockerKeys',
      'candidateId',
      'completedAt',
      'contractId',
      'evidenceDigest',
      'evidenceSnapshotId',
      'finalGateAttemptId',
      'outcome',
      'promotionId',
      'promotionJournalHeadDigest',
      'promotionJournalId',
      'reasonCode',
      'requiredGateCoverageDigest',
      'resultDigest',
      'runId',
      'schemaVersion',
      'targetAfterFingerprintDigest',
      'targetFencingTokenDigest',
      'targetPromotionLeaseId',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['finalGateAttemptId'])
    || !isIdentifier(value['runId'])
    || !isIdentifier(value['contractId'])
    || !isUuid(value['promotionId'])
    || !isUuid(value['candidateId'])
    || !isUuid(value['promotionJournalId'])
    || !isDigest(value['promotionJournalHeadDigest'])
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetFencingTokenDigest'])
    || !isDigest(value['targetAfterFingerprintDigest'])
    || !isUuid(value['evidenceSnapshotId'])
    || !isDigest(value['evidenceDigest'])
    || !isDigest(value['requiredGateCoverageDigest'])
    || !isOutcome(value['outcome'])
    || !isIdentifier(value['reasonCode'])
    || !isBlockerList(value['blockerKeys'])
    || !isTimestamp(value['completedAt'])
    || !isDigest(value['resultDigest'])) {
    return false;
  }
  const result = value as unknown as TargetFinalGateAttemptResultV1;
  if (canonicalJson(result.blockerKeys)
    !== canonicalJson([...new Set(result.blockerKeys)].toSorted())) {
    return false;
  }
  const { resultDigest, ...core } = result;
  return canonicalDigest(
    'wukong/target-final-gate-attempt-result/v1',
    core,
  ) === resultDigest;
}

function isBlockerList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_BLOCKERS
    && value.every(isIdentifier);
}

function isOutcome(value: unknown): value is TargetFinalGateOutcomeV1 {
  return value === 'PASS' || value === 'NEEDS_WORK' || value === 'ERROR';
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && IDENTIFIER.test(value)
    && !containsSensitiveText(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).toSorted().join(',')
    === [...expected].toSorted().join(',');
}
