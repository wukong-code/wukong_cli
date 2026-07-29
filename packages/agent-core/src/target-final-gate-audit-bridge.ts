import {
  canonicalDigest,
  createTargetFinalGateCheckResultRef,
  createTargetFinalGateEvidenceSnapshot,
  type TargetFinalGateEvidenceSnapshotV1,
} from '@wukong/verification';

import type {
  BuiltinRiskScanResultRecordedV1,
  FreshCriteriaVerdictRecordedV1,
  GateAttemptCompletedV1,
  GateCheckResultRecordedV1,
  LoopContractV2,
  LoopContractV3,
  LoopEvidenceSnapshotCreatedV2,
  LoopRunCreated,
  ProofAggregateRecordedV2,
  ReviewSubjectManifestRecordedV1,
} from './agent/goal';
import {
  validateTargetFinalGateAttemptState,
  type TargetFinalGateAttemptStateV1,
} from './target-final-gate-attempt-store';

export interface TargetFinalGateGoalAuditV1 {
  readonly contract: LoopContractV2 | LoopContractV3;
  readonly run: LoopRunCreated;
  readonly completedAttempt: GateAttemptCompletedV1;
  readonly evidenceSnapshot: LoopEvidenceSnapshotCreatedV2;
  readonly checkResults: readonly GateCheckResultRecordedV1[];
  readonly riskScan: BuiltinRiskScanResultRecordedV1;
  readonly reviewSubjectManifest:
    ReviewSubjectManifestRecordedV1;
  readonly freshCriteriaVerdict: FreshCriteriaVerdictRecordedV1;
  readonly proofAggregate: ProofAggregateRecordedV2;
}

/**
 * Rebinds an already durable 0.0.20 Goal Gate audit to the exact post-Apply
 * target state. It does not trust the Gate outcome alone: every ordered
 * component and the target fingerprint must join before canonical target
 * evidence can be created.
 */
export function createTargetFinalGateEvidenceFromGoalAudit(input: {
  readonly targetAttempt: TargetFinalGateAttemptStateV1;
  readonly evidenceSnapshotId: string;
  readonly audit: TargetFinalGateGoalAuditV1;
}): TargetFinalGateEvidenceSnapshotV1 {
  const { targetAttempt, audit } = input;
  if (!validateTargetFinalGateAttemptState(targetAttempt)
    || targetAttempt.state !== 'prepared'
    || audit.run.runId !== targetAttempt.runId
    || audit.run.contractId !== targetAttempt.contractId
    || audit.completedAttempt.attemptId
      !== targetAttempt.finalGateAttemptId
    || audit.completedAttempt.runId !== targetAttempt.runId
    || audit.completedAttempt.contractId !== targetAttempt.contractId
    || audit.completedAttempt.planDigest
      !== targetAttempt.gatePlanDigest
    || audit.completedAttempt.evidenceSnapshotId
      !== audit.evidenceSnapshot.evidenceSnapshotId
    || audit.completedAttempt.evidenceDigest
      !== audit.evidenceSnapshot.evidenceDigest
    || audit.evidenceSnapshot.attemptId
      !== targetAttempt.finalGateAttemptId
    || acceptanceContractDigest(audit.contract)
      !== targetAttempt.acceptanceContractDigest
    || criteriaSelectionDigest(audit.contract)
      !== targetAttempt.criteriaSelectionDigest
    || audit.contract.gatePlan.planDigest
      !== targetAttempt.gatePlanDigest) {
    throw new TypeError(
      'Goal Gate audit does not bind the prepared Target Final Gate.',
    );
  }
  validateAuditDigests(audit);
  const orderedCheckResults =
    audit.evidenceSnapshot.orderedCheckResults.map(
      (snapshotEntry, index) => {
        const result = audit.checkResults[index];
        if (result === undefined
          || snapshotEntry.checkId !== result.checkId
          || snapshotEntry.resultRef !== result.checkResultRef
          || snapshotEntry.resultDigest !== result.checkResultDigest
          || snapshotEntry.status !== result.status
          || (result.status === 'passed'
            && result.definitionDigest === undefined)) {
          throw new TypeError(
            'Target Final Gate ordered check audit is incomplete.',
          );
        }
        return createTargetFinalGateCheckResultRef({
          checkId: result.checkId,
          commandDigest: result.commandDigest,
          definitionDigest: result.definitionDigest
            ?? canonicalDigest(
              'wukong/target-final-gate-unresolved-definition/v1',
              {
                checkId: result.checkId,
                commandDigest: result.commandDigest,
                gatePlanDigest: targetAttempt.gatePlanDigest,
              },
            ),
          resultDigest: result.checkResultDigest,
          status: targetCheckStatus(result.status),
        });
      },
    );
  if (orderedCheckResults.length !== audit.checkResults.length) {
    throw new TypeError(
      'Target Final Gate ordered check coverage is incomplete.',
    );
  }
  const criteriaStatus = criteriaEvidenceStatus(audit);
  return createTargetFinalGateEvidenceSnapshot({
    evidenceSnapshotId: input.evidenceSnapshotId,
    finalGateAttemptId: targetAttempt.finalGateAttemptId,
    runId: targetAttempt.runId,
    contractId: targetAttempt.contractId,
    acceptanceContractDigest:
      targetAttempt.acceptanceContractDigest,
    gatePlanDigest: targetAttempt.gatePlanDigest,
    criteriaSelectionDigest:
      targetAttempt.criteriaSelectionDigest,
    promotionId: targetAttempt.promotionId,
    candidateId: targetAttempt.candidateId,
    sourceSnapshotDigest: targetAttempt.sourceSnapshotDigest,
    candidateDeltaDigest: targetAttempt.candidateDeltaDigest,
    promotionJournalId: targetAttempt.promotionJournalId,
    promotionJournalHeadDigest:
      targetAttempt.promotionJournalHeadDigest,
    targetPromotionLeaseId:
      targetAttempt.targetPromotionLeaseId,
    targetFencingTokenDigest:
      targetAttempt.targetFencingTokenDigest,
    targetAfterFingerprintDigest:
      targetAttempt.targetAfterFingerprintDigest,
    orderedCheckResults,
    builtinRiskScanResultDigest:
      audit.riskScan.scanResultDigest,
    builtinRiskScanStatus: audit.riskScan.status,
    criteriaEvidenceDigest: canonicalDigest(
      'wukong/target-final-gate-criteria-evidence/v1',
      {
        reviewSubjectManifestDigest:
          audit.evidenceSnapshot.reviewSubjectManifestDigest,
        freshCriteriaVerdictDigest:
          audit.freshCriteriaVerdict.verdictDigest,
        proofAggregateDigest:
          audit.proofAggregate.proofAggregateDigest,
      },
    ),
    criteriaStatus,
    freshReviewerResultDigest:
      audit.freshCriteriaVerdict.verdictDigest,
    freshReviewerStatus:
      audit.freshCriteriaVerdict.verdict.status,
    finalGateCompletedAt: new Date(
      audit.completedAttempt.createdAt,
    ).toISOString(),
  });
}

export function acceptanceContractDigest(
  contract: LoopContractV2 | LoopContractV3,
): string {
  return canonicalDigest(
    'wukong/loop-acceptance-contract/v1',
    contract,
  );
}

export function criteriaSelectionDigest(
  contract: LoopContractV2 | LoopContractV3,
): string {
  return contract.schemaVersion === 3
    ? contract.verificationCriteria.selectionDigest
    : canonicalDigest(
      'wukong/verification-selection/none/v1',
      { contractId: contract.contractId },
    );
}

function validateAuditDigests(
  audit: TargetFinalGateGoalAuditV1,
): void {
  const checksValid = audit.checkResults.every((result) => {
    const { checkResultDigest, ...base } = result;
    return canonicalDigest(
      'wukong/gate-check-result/v1',
      base,
    ) === checkResultDigest;
  });
  const { scanResultDigest, ...scanBase } = audit.riskScan;
  const { manifestDigest, ...manifestBase } =
    audit.reviewSubjectManifest.manifest;
  const { proofAggregateDigest, ...aggregateBase } =
    audit.proofAggregate;
  const { evidenceDigest, ...snapshotBase } =
    audit.evidenceSnapshot;
  const { resultDigest, ...completionBase } =
    audit.completedAttempt;
  const auditRecords = [
    audit.riskScan,
    audit.reviewSubjectManifest,
    audit.freshCriteriaVerdict,
    audit.proofAggregate,
  ];
  if (!checksValid
    || auditRecords.some((record) =>
      record.attemptId !== audit.completedAttempt.attemptId
      || record.runId !== audit.completedAttempt.runId
      || record.contractId !== audit.completedAttempt.contractId
      || record.planDigest !== audit.completedAttempt.planDigest)
    || canonicalDigest(
      'wukong/builtin-risk-scan-result/v1',
      scanBase,
    ) !== scanResultDigest
    || canonicalDigest(
      'wukong/review-subject-manifest/v1',
      manifestBase,
    ) !== manifestDigest
    || audit.reviewSubjectManifest.manifestDigest
      !== manifestDigest
    || audit.reviewSubjectManifest.manifestRef
      !== audit.evidenceSnapshot.reviewSubjectManifestRef
    || manifestDigest
      !== audit.evidenceSnapshot.reviewSubjectManifestDigest
    || canonicalDigest(
      'wukong/fresh-criteria-verdict/v1',
      audit.freshCriteriaVerdict.verdict,
    ) !== audit.freshCriteriaVerdict.verdictDigest
    || audit.freshCriteriaVerdict.verdict.attemptId
      !== audit.freshCriteriaVerdict.attemptId
    || audit.freshCriteriaVerdict.verdict.reviewerInputDigest
      !== audit.freshCriteriaVerdict.reviewerInputDigest
    || canonicalDigest(
      'wukong/proof-aggregate/v2',
      aggregateBase,
    ) !== proofAggregateDigest
    || canonicalDigest(
      'wukong/loop-evidence-snapshot/v2',
      snapshotBase,
    ) !== evidenceDigest
    || canonicalDigest(
      'wukong/gate-attempt-result/v1',
      completionBase,
    ) !== resultDigest
    || audit.evidenceSnapshot.builtinRiskScanResultDigest
      !== audit.riskScan.scanResultDigest
    || audit.evidenceSnapshot.freshCriteriaVerdictDigest
      !== audit.freshCriteriaVerdict.verdictDigest
    || audit.evidenceSnapshot.proofAggregateDigest
      !== audit.proofAggregate.proofAggregateDigest
    || audit.completedAttempt.status
      !== audit.proofAggregate.status
    || audit.completedAttempt.reasonCode
      !== audit.proofAggregate.reasonCode) {
    throw new TypeError(
      'Goal Gate audit digest chain is invalid.',
    );
  }
}

function criteriaEvidenceStatus(
  audit: TargetFinalGateGoalAuditV1,
): 'satisfied' | 'unsatisfied' | 'error' {
  if (audit.completedAttempt.status === 'ERROR') return 'error';
  const verdict = audit.freshCriteriaVerdict.verdict;
  const criteria = audit.contract.schemaVersion === 3
    ? audit.contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      provenanceDigest: criterion.criterionProvenanceDigest,
    }))
    : audit.contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      provenanceDigest: canonicalDigest(
        'wukong/legacy-criterion-provenance/v1',
        {
          contractId: audit.contract.contractId,
          id: criterion.id,
          text: criterion.text,
          source: criterion.source,
        },
      ),
    }));
  const criteriaSatisfied = criteria.every((criterion) => {
    return verdict.criterionDispositions.some(
      (disposition) =>
        disposition.criterionId === criterion.id
        && disposition.criterionProvenanceDigest
          === criterion.provenanceDigest
        && disposition.status === 'satisfied',
    );
  });
  const blockersResolved = audit.run.carriedBlockerKeys.every(
    (key) => verdict.priorBlockerDispositions.some(
      (disposition) =>
        disposition.blockerKey === key
        && disposition.status === 'resolved',
    ),
  );
  return verdict.status === 'PASS'
    && criteriaSatisfied
    && blockersResolved
    && verdict.findings.every(
      (finding) => finding.severity !== 'blocking',
    )
    ? 'satisfied'
    : 'unsatisfied';
}

function targetCheckStatus(
  status: GateCheckResultRecordedV1['status'],
): 'passed' | 'failed' | 'error' {
  if (status === 'passed') return 'passed';
  if (status === 'error' || status === 'unavailable') {
    return 'error';
  }
  return 'failed';
}
