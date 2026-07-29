import type { SourceSnapshotV1 } from '@wukong/verification';

export interface RunIsolatedLoopCandidateIterationPayloadV1 {
  readonly schemaVersion: 1;
  readonly sourceRepositoryRoot: string;
  readonly sourceSnapshotCwd: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly approvedBootstrapPlanDigest?: string;
}

export interface IsolatedLoopCandidateIterationPublicResultV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly worktreeLeaseId: string;
  readonly bindingDigest: string;
  readonly candidateGateAttemptId: string;
  readonly outcome: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly leaseState: 'active' | 'verifying' | 'awaiting_promotion';
  readonly writerRan: boolean;
  readonly iteration: number;
}

export interface IsolatedLoopPromotionChangeSummaryV1 {
  readonly operation: 'create' | 'update' | 'delete' | 'rename' | 'mode';
  readonly sourcePath: string | null;
  readonly targetPath: string | null;
  readonly modeBefore: number | null;
  readonly modeAfter: number | null;
}

export type PrepareIsolatedLoopPromotionPayloadV1 =
  RunIsolatedLoopCandidateIterationPayloadV1;

/**
 * Safe, reviewable promotion challenge. It contains no candidate path,
 * capability, fencing token, raw source bytes, or private artifact reference.
 */
export interface IsolatedLoopPromotionProposalPublicResultV1 {
  readonly schemaVersion: 1;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly candidateGateAttemptId: string;
  readonly candidateGateResultDigest: string;
  readonly candidateDeltaDigest: string;
  readonly targetFingerprintDigest: string;
  readonly permissionDigest: string;
  readonly proposalDigest: string;
  readonly changedFileCount: number;
  readonly changes: readonly IsolatedLoopPromotionChangeSummaryV1[];
}

export interface PromoteIsolatedLoopCandidatePayloadV1
  extends RunIsolatedLoopCandidateIterationPayloadV1 {
  readonly proposalDigest: string;
}

export interface IsolatedLoopPromotionPublicResultV1 {
  readonly schemaVersion: 1;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly proposalDigest: string;
  readonly targetPromotionLeaseId: string;
  readonly targetAfterFingerprintDigest: string;
  readonly finalGateAttemptId: string;
  readonly outcome: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly blockerKeys: readonly string[];
  readonly completionSealDigest: string;
}
