import {
  canonicalDigest,
  type RawGateEvidenceV1,
  type ReviewSubjectCandidateV1,
} from '@wukong/verification';

import type { CandidateDeltaSealV1 } from './candidate-delta-store';
import type { CandidateDeterministicGateResultV1 } from './candidate-gate-executor';

export interface CandidateBrokeredReviewPlanV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly candidateDeltaDigest: string;
  readonly candidateDeltaSealDigest: string;
  readonly workspaceFingerprint: string;
  readonly subjectCandidates: readonly ReviewSubjectCandidateV1[];
  readonly gateEvidence: readonly RawGateEvidenceV1[];
  readonly reviewPlanDigest: string;
}

/**
 * Projects the exact sealed Agent delta into the existing bounded Review
 * Subject broker. Original dirty snapshot paths are not included unless the
 * Agent changed them. Delete/preimage operations remain metadata evidence
 * because the current candidate no longer contains their previous bytes.
 */
export function createCandidateBrokeredReviewPlan(input: {
  readonly deltaSeal: CandidateDeltaSealV1;
  readonly deterministicGate: CandidateDeterministicGateResultV1;
}): CandidateBrokeredReviewPlanV1 {
  const { deltaSeal, deterministicGate } = input;
  if (deterministicGate.status !== 'passed'
    || deterministicGate.proof?.status !== 'passed'
    || deterministicGate.workspaceSnapshotId === null
    || deterministicGate.candidateId !== deltaSeal.candidateId
    || deterministicGate.leaseId !== deltaSeal.leaseId
    || deterministicGate.candidateDeltaDigest
      !== deltaSeal.delta.candidateDeltaDigest
    || deterministicGate.candidateDeltaSealDigest !== deltaSeal.sealDigest) {
    throw new TypeError(
      'A passing deterministic Gate bound to the exact delta seal is required.',
    );
  }
  const changedStatus = new Map(
    deterministicGate.proof.verification.changedFiles.map((file) => [
      file.path,
      file.status,
    ]),
  );
  const subjectOrigins = new Map<
    string,
    ReviewSubjectCandidateV1['origin']
  >();
  for (const change of deltaSeal.manifest.changes) {
    if (change.targetPath === null || change.postimage === null) continue;
    const status = changedStatus.get(change.targetPath)?.trim();
    const origin = status === '??' || change.operation === 'create'
      ? 'explicit-untracked'
      : 'changed-tracked';
    const previous = subjectOrigins.get(change.targetPath);
    if (previous === undefined || origin === 'explicit-untracked') {
      subjectOrigins.set(change.targetPath, origin);
    }
  }
  const subjectCandidates = Object.freeze(
    [...subjectOrigins]
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([logicalPath, origin]) =>
        Object.freeze({ logicalPath, origin })),
  );
  const gateEvidence: RawGateEvidenceV1[] =
    deltaSeal.manifest.changes.map((change) => ({
      producerId: 'candidate-delta',
      evidenceId: `change-${String(change.changeIndex).padStart(6, '0')}`,
      content: JSON.stringify({
        operation: change.operation,
        sourcePath: change.sourcePath,
        targetPath: change.targetPath,
        preimage: change.preimage === null
          ? null
          : {
              mode: change.preimage.mode,
              sizeBytes: change.preimage.sizeBytes,
              contentDigest: change.preimage.contentDigest,
            },
        postimage: change.postimage === null
          ? null
          : {
              mode: change.postimage.mode,
              sizeBytes: change.postimage.sizeBytes,
              contentDigest: change.postimage.contentDigest,
            },
        changeDigest: change.changeDigest,
      }),
      mediaType: 'application/json',
    }));
  for (const [index, result] of
    deterministicGate.proof.verification.commandResults.entries()) {
    if (result.stdout.length > 0) {
      gateEvidence.push({
        producerId: `candidate-check-${String(index).padStart(4, '0')}`,
        evidenceId: 'stdout',
        content: result.stdout,
        mediaType: 'text/plain',
      });
    }
    if (result.stderr.length > 0) {
      gateEvidence.push({
        producerId: `candidate-check-${String(index).padStart(4, '0')}`,
        evidenceId: 'stderr',
        content: result.stderr,
        mediaType: 'text/plain',
      });
    }
  }
  for (const risk of deterministicGate.proof.scan.risks) {
    const identity = canonicalDigest(
      'wukong/candidate-risk-evidence-identity/v1',
      {
        id: risk.id,
        severity: risk.severity,
        message: risk.message,
        file: risk.file,
        line: risk.line,
        evidence: risk.evidence,
      },
    );
    gateEvidence.push({
      producerId: 'candidate-risk-scan',
      evidenceId: `${risk.id}@${identity}`,
      content: JSON.stringify({
        severity: risk.severity,
        message: risk.message,
        file: risk.file,
        line: risk.line,
      }),
      mediaType: 'application/json',
    });
  }
  const frozenEvidence = Object.freeze(gateEvidence.map((entry) =>
    Object.freeze(entry)));
  const core = {
    schemaVersion: 1 as const,
    candidateId: deltaSeal.candidateId,
    leaseId: deltaSeal.leaseId,
    candidateDeltaDigest: deltaSeal.delta.candidateDeltaDigest,
    candidateDeltaSealDigest: deltaSeal.sealDigest,
    workspaceFingerprint: deterministicGate.workspaceSnapshotId,
    subjectCandidates,
    gateEvidence: frozenEvidence,
  };
  return Object.freeze({
    ...core,
    reviewPlanDigest: canonicalDigest(
      'wukong/candidate-brokered-review-plan/v1',
      core,
    ),
  });
}

export function validateCandidateBrokeredReviewPlan(
  value: unknown,
): value is CandidateBrokeredReviewPlanV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'candidateDeltaDigest',
      'candidateDeltaSealDigest',
      'candidateId',
      'gateEvidence',
      'leaseId',
      'reviewPlanDigest',
      'schemaVersion',
      'subjectCandidates',
      'workspaceFingerprint',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['candidateId'])
    || !isUuid(value['leaseId'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isDigest(value['candidateDeltaSealDigest'])
    || typeof value['workspaceFingerprint'] !== 'string'
    || value['workspaceFingerprint'].length === 0
    || !Array.isArray(value['subjectCandidates'])
    || !Array.isArray(value['gateEvidence'])
    || !isDigest(value['reviewPlanDigest'])) {
    return false;
  }
  const plan = value as unknown as CandidateBrokeredReviewPlanV1;
  const { reviewPlanDigest, ...core } = plan;
  try {
    return canonicalDigest(
      'wukong/candidate-brokered-review-plan/v1',
      core,
    ) === reviewPlanDigest;
  } catch {
    return false;
  }
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
