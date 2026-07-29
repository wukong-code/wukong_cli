import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createCompletionArtifactRef,
  createTargetGateCompletionSeal,
  isTerminalPassCompletionSeal,
  validateTargetGateCompletionSeal,
} from '../src';

const SEAL_ID = '019f8d10-0000-7abc-8def-0123456789ab';

describe('TargetGateCompletionSealV1', () => {
  it('seals exactly three ordered, private artifacts', () => {
    const seal = fixture('PASS');
    expect(validateTargetGateCompletionSeal(seal)).toBe(true);
    expect(isTerminalPassCompletionSeal(seal)).toBe(true);
  });

  it('rejects missing, reordered, duplicated, and tampered artifacts', () => {
    const seal = fixture('PASS');
    expect(() => createTargetGateCompletionSeal({
      ...withoutDigest(seal),
      orderedArtifacts: seal.orderedArtifacts.slice(0, 2),
    })).toThrow(/invalid/u);
    expect(() => createTargetGateCompletionSeal({
      ...withoutDigest(seal),
      orderedArtifacts: [
        seal.orderedArtifacts[1]!,
        seal.orderedArtifacts[0]!,
        seal.orderedArtifacts[2]!,
      ],
    })).toThrow(/invalid/u);
    expect(validateTargetGateCompletionSeal({
      ...seal,
      gatePlanDigest: digest('tampered'),
    })).toBe(false);
  });

  it('allows sealed non-PASS evidence but never treats it as terminal PASS', () => {
    const seal = fixture('ERROR');
    expect(validateTargetGateCompletionSeal(seal)).toBe(true);
    expect(isTerminalPassCompletionSeal(seal)).toBe(false);
  });

  it('rejects a credential-shaped redaction policy identifier', () => {
    const seal = fixture('PASS');
    expect(() => createTargetGateCompletionSeal({
      ...withoutDigest(seal),
      redactionPolicyVersion:
        'sk_live_wukongPrivacySentinel123456789',
    })).toThrow(/invalid/u);
  });
});

function fixture(outcome: 'PASS' | 'NEEDS_WORK' | 'ERROR') {
  return createTargetGateCompletionSeal({
    completionSealId: SEAL_ID,
    runId: 'run_completion',
    contractId: 'contract_completion',
    acceptanceContractDigest: digest('contract'),
    gatePlanDigest: digest('gate-plan'),
    criteriaSelectionDigest: digest('criteria'),
    promotionId: '019f8d10-0001-7abc-8def-0123456789ab',
    candidateId: '019f8d10-0002-7abc-8def-0123456789ab',
    sourceSnapshotDigest: digest('source'),
    candidateDeltaDigest: digest('delta'),
    promotionJournalId: '019f8d10-0003-7abc-8def-0123456789ab',
    promotionJournalHeadDigest: digest('journal'),
    targetPromotionLeaseId:
      '019f8d10-0004-7abc-8def-0123456789ab',
    targetFencingTokenDigest: digest('fencing'),
    targetAfterFingerprintDigest: digest('target-after'),
    finalGateAttemptId: '019f8d10-0005-7abc-8def-0123456789ab',
    finalGateEvidenceSnapshotId:
      '019f8d10-0006-7abc-8def-0123456789ab',
    finalGateEvidenceDigest: digest('evidence'),
    requiredGateCoverageDigest: digest('coverage'),
    finalGateAttemptResultDigest: digest('attempt-result'),
    finalGateOutcome: outcome,
    orderedArtifacts: [
      artifact('promotion_apply_journal', 'journal'),
      artifact('final_gate_evidence_snapshot', 'evidence'),
      artifact('final_gate_attempt_result', 'attempt'),
    ],
    redactionPolicyVersion: 'wukong-redaction-v1',
    finalGateCompletedAt: '2026-07-29T15:40:00.000Z',
    sealedAt: '2026-07-29T15:40:01.000Z',
  });
}

function artifact(
  kind:
    | 'promotion_apply_journal'
    | 'final_gate_evidence_snapshot'
    | 'final_gate_attempt_result',
  name: 'journal' | 'evidence' | 'attempt',
) {
  return createCompletionArtifactRef({
    kind,
    privateRef: `private/target-completion/${SEAL_ID}/${name}.json`,
    byteLength: 100,
    contentDigest: digest(name),
  });
}

function withoutDigest(
  seal: ReturnType<typeof fixture>,
) {
  const { completionSealDigest: _discarded, ...input } = seal;
  return input;
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/completion-seal/v1', label);
}
