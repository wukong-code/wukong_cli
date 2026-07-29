import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createTargetFinalGateAttemptResult,
  createTargetFinalGateCheckResultRef,
  createTargetFinalGateEvidenceSnapshot,
  finalGateEvidenceCanPass,
  validateTargetFinalGateAttemptResult,
  validateTargetFinalGateEvidenceSnapshot,
} from '../src';

describe('target Final Gate contracts', () => {
  it('binds complete coverage and permits PASS only when every layer passes', () => {
    const evidence = evidenceFixture();
    const result = createTargetFinalGateAttemptResult({
      evidence,
      requestedOutcome: 'PASS',
      reasonCode: 'target_gate_passed',
      blockerKeys: [],
      completedAt: '2026-07-29T16:00:01.000Z',
    });

    expect(finalGateEvidenceCanPass(evidence)).toBe(true);
    expect(result.outcome).toBe('PASS');
    expect(validateTargetFinalGateEvidenceSnapshot(evidence)).toBe(true);
    expect(validateTargetFinalGateAttemptResult(result)).toBe(true);
  });

  it('downgrades an incomplete requested PASS and preserves ERROR', () => {
    const blockedEvidence = createTargetFinalGateEvidenceSnapshot({
      ...evidenceInput(),
      builtinRiskScanStatus: 'blocking',
    });
    const blocked = createTargetFinalGateAttemptResult({
      evidence: blockedEvidence,
      requestedOutcome: 'PASS',
      reasonCode: 'risk_blocking',
      blockerKeys: ['risk:blocking'],
      completedAt: '2026-07-29T16:00:01.000Z',
    });
    const errored = createTargetFinalGateAttemptResult({
      evidence: blockedEvidence,
      requestedOutcome: 'ERROR',
      reasonCode: 'gate_runtime_error',
      blockerKeys: [],
      completedAt: '2026-07-29T16:00:01.000Z',
    });

    expect(blocked.outcome).toBe('NEEDS_WORK');
    expect(errored.outcome).toBe('ERROR');
  });

  it('rejects duplicate checks and digest tampering', () => {
    const input = evidenceInput();
    expect(() => createTargetFinalGateEvidenceSnapshot({
      ...input,
      orderedCheckResults: [
        input.orderedCheckResults[0]!,
        input.orderedCheckResults[0]!,
      ],
    })).toThrow(/invalid/u);
    const evidence = evidenceFixture();
    expect(validateTargetFinalGateEvidenceSnapshot({
      ...evidence,
      criteriaEvidenceDigest: digest('tampered'),
    })).toBe(false);
  });

  it('rejects credential-shaped reason codes before they become artifacts', () => {
    expect(() => createTargetFinalGateAttemptResult({
      evidence: evidenceFixture(),
      requestedOutcome: 'ERROR',
      reasonCode:
        'sk_live_wukongPrivacySentinel123456789',
      blockerKeys: [],
      completedAt: '2026-07-29T16:00:01.000Z',
    })).toThrow(/invalid/u);
  });
});

function evidenceFixture() {
  return createTargetFinalGateEvidenceSnapshot(evidenceInput());
}

function evidenceInput() {
  return {
    evidenceSnapshotId: '019f8d20-0000-7abc-8def-0123456789ab',
    finalGateAttemptId: '019f8d20-0001-7abc-8def-0123456789ab',
    runId: 'run_final_gate',
    contractId: 'contract_final_gate',
    acceptanceContractDigest: digest('contract'),
    gatePlanDigest: digest('gate-plan'),
    criteriaSelectionDigest: digest('criteria-selection'),
    promotionId: '019f8d20-0002-7abc-8def-0123456789ab',
    candidateId: '019f8d20-0003-7abc-8def-0123456789ab',
    sourceSnapshotDigest: digest('source'),
    candidateDeltaDigest: digest('candidate-delta'),
    promotionJournalId: '019f8d20-0004-7abc-8def-0123456789ab',
    promotionJournalHeadDigest: digest('journal'),
    targetPromotionLeaseId:
      '019f8d20-0005-7abc-8def-0123456789ab',
    targetFencingTokenDigest: digest('fencing'),
    targetAfterFingerprintDigest: digest('target-after'),
    orderedCheckResults: [
      createTargetFinalGateCheckResultRef({
        checkId: 'check-tests',
        commandDigest: digest('command'),
        definitionDigest: digest('definition'),
        resultDigest: digest('result'),
        status: 'passed',
      }),
    ],
    builtinRiskScanResultDigest: digest('risk'),
    builtinRiskScanStatus: 'clean' as const,
    criteriaEvidenceDigest: digest('criteria'),
    criteriaStatus: 'satisfied' as const,
    freshReviewerResultDigest: digest('reviewer'),
    freshReviewerStatus: 'PASS' as const,
    finalGateCompletedAt: '2026-07-29T16:00:00.000Z',
  };
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/target-final-gate/v1', label);
}
