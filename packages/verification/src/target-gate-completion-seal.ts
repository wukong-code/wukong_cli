import { canonicalDigest } from './finish-line';
import { containsSensitiveText } from './redaction';

export type CompletionArtifactKindV1 =
  | 'promotion_apply_journal'
  | 'final_gate_evidence_snapshot'
  | 'final_gate_attempt_result';

export interface CompletionArtifactRefV1 {
  readonly schemaVersion: 1;
  readonly kind: CompletionArtifactKindV1;
  readonly privateRef: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly artifactDigest: string;
}

export type TargetFinalGateOutcomeV1 =
  | 'PASS'
  | 'NEEDS_WORK'
  | 'ERROR';

export interface TargetGateCompletionSealV1 {
  readonly schemaVersion: 1;
  readonly completionSealId: string;
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
  readonly finalGateAttemptId: string;
  readonly finalGateEvidenceSnapshotId: string;
  readonly finalGateEvidenceDigest: string;
  readonly requiredGateCoverageDigest: string;
  readonly finalGateAttemptResultDigest: string;
  readonly finalGateOutcome: TargetFinalGateOutcomeV1;
  readonly orderedArtifacts: readonly CompletionArtifactRefV1[];
  readonly redactionPolicyVersion: string;
  readonly finalGateCompletedAt: string;
  readonly sealedAt: string;
  readonly completionSealDigest: string;
}

const ARTIFACT_ORDER: readonly CompletionArtifactKindV1[] = [
  'promotion_apply_journal',
  'final_gate_evidence_snapshot',
  'final_gate_attempt_result',
];
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PRIVATE_REF =
  /^private\/target-completion\/[0-9a-f-]{36}\/(?:journal|evidence|attempt)\.json$/u;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

export function createCompletionArtifactRef(input: {
  readonly kind: CompletionArtifactKindV1;
  readonly privateRef: string;
  readonly byteLength: number;
  readonly contentDigest: string;
}): CompletionArtifactRefV1 {
  const core = {
    schemaVersion: 1 as const,
    ...input,
  };
  const value = Object.freeze({
    ...core,
    artifactDigest: canonicalDigest(
      'wukong/completion-artifact-ref/v1',
      core,
    ),
  });
  if (!validateCompletionArtifactRef(value)) {
    throw new TypeError('Completion artifact reference input is invalid.');
  }
  return value;
}

export function createTargetGateCompletionSeal(input: Omit<
  TargetGateCompletionSealV1,
  'schemaVersion' | 'completionSealDigest'
>): TargetGateCompletionSealV1 {
  const core = {
    schemaVersion: 1 as const,
    ...input,
    orderedArtifacts: Object.freeze([...input.orderedArtifacts]),
  };
  const value = Object.freeze({
    ...core,
    completionSealDigest: canonicalDigest(
      'wukong/target-gate-completion-seal/v1',
      core,
    ),
  });
  if (!validateTargetGateCompletionSeal(value)) {
    throw new TypeError('Target Gate completion seal input is invalid.');
  }
  return value;
}

export function validateCompletionArtifactRef(
  value: unknown,
): value is CompletionArtifactRefV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'artifactDigest',
      'byteLength',
      'contentDigest',
      'kind',
      'privateRef',
      'schemaVersion',
    ])
    || value['schemaVersion'] !== 1
    || !isArtifactKind(value['kind'])
    || typeof value['privateRef'] !== 'string'
    || !PRIVATE_REF.test(value['privateRef'])
    || !isNonNegativeInteger(value['byteLength'])
    || value['byteLength'] > MAX_ARTIFACT_BYTES
    || !isDigest(value['contentDigest'])
    || !isDigest(value['artifactDigest'])) {
    return false;
  }
  const artifact = value as unknown as CompletionArtifactRefV1;
  const { artifactDigest, ...core } = artifact;
  return canonicalDigest('wukong/completion-artifact-ref/v1', core)
    === artifactDigest;
}

export function validateTargetGateCompletionSeal(
  value: unknown,
): value is TargetGateCompletionSealV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'acceptanceContractDigest',
      'candidateDeltaDigest',
      'candidateId',
      'completionSealDigest',
      'completionSealId',
      'contractId',
      'criteriaSelectionDigest',
      'finalGateAttemptId',
      'finalGateAttemptResultDigest',
      'finalGateCompletedAt',
      'finalGateEvidenceDigest',
      'finalGateEvidenceSnapshotId',
      'finalGateOutcome',
      'gatePlanDigest',
      'orderedArtifacts',
      'promotionId',
      'promotionJournalHeadDigest',
      'promotionJournalId',
      'redactionPolicyVersion',
      'requiredGateCoverageDigest',
      'runId',
      'schemaVersion',
      'sealedAt',
      'sourceSnapshotDigest',
      'targetAfterFingerprintDigest',
      'targetFencingTokenDigest',
      'targetPromotionLeaseId',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['completionSealId'])
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
    || !isUuid(value['finalGateAttemptId'])
    || !isUuid(value['finalGateEvidenceSnapshotId'])
    || !isDigest(value['finalGateEvidenceDigest'])
    || !isDigest(value['requiredGateCoverageDigest'])
    || !isDigest(value['finalGateAttemptResultDigest'])
    || !isOutcome(value['finalGateOutcome'])
    || !Array.isArray(value['orderedArtifacts'])
    || value['orderedArtifacts'].length !== ARTIFACT_ORDER.length
    || value['orderedArtifacts'].some((artifact, index) =>
      !validateCompletionArtifactRef(artifact)
      || artifact.kind !== ARTIFACT_ORDER[index])
    || typeof value['redactionPolicyVersion'] !== 'string'
    || !isIdentifier(value['redactionPolicyVersion'])
    || !isTimestamp(value['finalGateCompletedAt'])
    || !isTimestamp(value['sealedAt'])
    || Date.parse(value['sealedAt'])
      < Date.parse(value['finalGateCompletedAt'])
    || !isDigest(value['completionSealDigest'])) {
    return false;
  }
  const seal = value as unknown as TargetGateCompletionSealV1;
  const { completionSealDigest, ...core } = seal;
  return new Set(
    seal.orderedArtifacts.map(({ privateRef }) => privateRef),
  ).size === ARTIFACT_ORDER.length
    && canonicalDigest(
      'wukong/target-gate-completion-seal/v1',
      core,
    ) === completionSealDigest;
}

export function isTerminalPassCompletionSeal(
  value: unknown,
): value is TargetGateCompletionSealV1 {
  return validateTargetGateCompletionSeal(value)
    && value.finalGateOutcome === 'PASS';
}

function isArtifactKind(
  value: unknown,
): value is CompletionArtifactKindV1 {
  return value === 'promotion_apply_journal'
    || value === 'final_gate_evidence_snapshot'
    || value === 'final_gate_attempt_result';
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
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
