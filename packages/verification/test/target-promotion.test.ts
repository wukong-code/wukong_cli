import { describe, expect, it } from 'vitest';

import {
  adoptTargetPromotionLease,
  acknowledgePromotionConsent,
  canonicalDigest,
  createPromotionConsentProposal,
  createTargetPromotionLease,
  createTargetStateFingerprint,
  targetPromotionRegistryKey,
  transitionTargetPromotionLease,
  validatePromotionConsentBinding,
  validateTargetPromotionLease,
  validateTargetStateFingerprint,
} from '../src';

const PROMOTION_ID = '019f8cb0-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8cb0-0001-7abc-8def-0123456789ab';
const LEASE_ID = '019f8cb0-0002-7abc-8def-0123456789ab';

describe('target promotion contracts', () => {
  it('binds exact target state and consent without accepting stale approval', () => {
    const target = fingerprint();
    const proposal = createPromotionConsentProposal({
      promotionId: PROMOTION_ID,
      candidateId: CANDIDATE_ID,
      candidateDeltaDigest: digest('candidate-delta'),
      candidateGateResultDigest: digest('candidate-gate'),
      sourceSnapshotDigest: digest('source'),
      targetFingerprint: target,
      permissionDigest: digest('permission'),
    });
    const consent = acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T12:00:00.000Z',
    );

    expect(validateTargetStateFingerprint(target)).toBe(true);
    expect(validatePromotionConsentBinding(consent)).toBe(true);
    expect(() => acknowledgePromotionConsent(
      proposal,
      digest('stale-proposal'),
      '2026-07-29T12:00:00.000Z',
    )).toThrow(/acknowledgement/u);
    expect(targetPromotionRegistryKey(target)).toBe(
      targetPromotionRegistryKey({
        targetWorkspaceIdentity: target.targetWorkspaceIdentity,
        targetGitCommonDirIdentity: target.targetGitCommonDirIdentity,
      }),
    );
  });

  it('advances a fenced target lease monotonically and rejects stale tokens', () => {
    const lease = createTargetPromotionLease({
      targetPromotionLeaseId: LEASE_ID,
      registryRevision: 7,
      targetFingerprint: fingerprint(),
      promotionId: PROMOTION_ID,
      candidateId: CANDIDATE_ID,
      promotionConsentDigest: digest('consent'),
      candidateDeltaDigest: digest('candidate-delta'),
      candidateGateResultDigest: digest('candidate-gate'),
      ownerRunId: 'run_promotion',
      ownerProcessIdentityDigest: digest('process'),
      fencingTokenDigest: digest('fencing'),
      acquiredAt: '2026-07-29T12:00:00.000Z',
    });
    const applying = transitionTargetPromotionLease(lease, {
      toState: 'applying',
      expectedFencingTokenDigest: lease.fencingTokenDigest,
      occurredAt: '2026-07-29T12:00:01.000Z',
    });
    const verifying = transitionTargetPromotionLease(applying, {
      toState: 'final_verifying',
      expectedFencingTokenDigest: applying.fencingTokenDigest,
      occurredAt: '2026-07-29T12:00:02.000Z',
    });

    expect(applying.registryRevision).toBe(8);
    expect(applying.previousLeaseDigest).toBe(lease.leaseDigest);
    expect(verifying.state).toBe('final_verifying');
    expect(validateTargetPromotionLease(verifying)).toBe(true);
    expect(() => transitionTargetPromotionLease(applying, {
      toState: 'final_verifying',
      expectedFencingTokenDigest: digest('stale-fencing'),
      occurredAt: '2026-07-29T12:00:02.000Z',
    })).toThrow(/transition/u);
    expect(() => transitionTargetPromotionLease(verifying, {
      toState: 'applying',
      expectedFencingTokenDigest: verifying.fencingTokenDigest,
      occurredAt: '2026-07-29T12:00:03.000Z',
    })).toThrow(/transition/u);
  });

  it('rejects digest tampering and contradictory branch state', () => {
    const target = fingerprint();
    expect(validateTargetStateFingerprint({
      ...target,
      branchRef: null,
    })).toBe(false);
    const lease = createTargetPromotionLease({
      targetPromotionLeaseId: LEASE_ID,
      registryRevision: 0,
      targetFingerprint: target,
      promotionId: PROMOTION_ID,
      candidateId: CANDIDATE_ID,
      promotionConsentDigest: digest('consent'),
      candidateDeltaDigest: digest('candidate-delta'),
      candidateGateResultDigest: digest('candidate-gate'),
      ownerRunId: 'run_promotion',
      ownerProcessIdentityDigest: digest('process'),
      fencingTokenDigest: digest('fencing'),
      acquiredAt: '2026-07-29T12:00:00.000Z',
    });
    expect(validateTargetPromotionLease({
      ...lease,
      acquiredFingerprintDigest: digest('tampered'),
    })).toBe(false);
  });

  it('adopts only an unreleased exact owner and rotates process and fencing identities', () => {
    const lease = createTargetPromotionLease({
      targetPromotionLeaseId: LEASE_ID,
      registryRevision: 2,
      targetFingerprint: fingerprint(),
      promotionId: PROMOTION_ID,
      candidateId: CANDIDATE_ID,
      promotionConsentDigest: digest('consent'),
      candidateDeltaDigest: digest('candidate-delta'),
      candidateGateResultDigest: digest('candidate-gate'),
      ownerRunId: 'run_promotion',
      ownerProcessIdentityDigest: digest('process-old'),
      fencingTokenDigest: digest('fencing-old'),
      acquiredAt: '2026-07-29T12:00:00.000Z',
    });
    const adopted = adoptTargetPromotionLease(lease, {
      expectedOwnerProcessIdentityDigest:
        lease.ownerProcessIdentityDigest,
      expectedFencingTokenDigest: lease.fencingTokenDigest,
      nextOwnerProcessIdentityDigest: digest('process-next'),
      nextFencingTokenDigest: digest('fencing-next'),
      occurredAt: '2026-07-29T12:00:01.000Z',
    });

    expect(adopted).toMatchObject({
      registryRevision: 3,
      state: 'acquired',
      ownerRunId: lease.ownerRunId,
      ownerProcessIdentityDigest: digest('process-next'),
      fencingTokenDigest: digest('fencing-next'),
      previousLeaseDigest: lease.leaseDigest,
    });
    expect(validateTargetPromotionLease(adopted)).toBe(true);
    expect(() => adoptTargetPromotionLease(lease, {
      expectedOwnerProcessIdentityDigest: digest('stale-process'),
      expectedFencingTokenDigest: lease.fencingTokenDigest,
      nextOwnerProcessIdentityDigest: digest('process-next'),
      nextFencingTokenDigest: digest('fencing-next'),
      occurredAt: '2026-07-29T12:00:01.000Z',
    })).toThrow(/adoption/u);
    const released = transitionTargetPromotionLease(lease, {
      toState: 'released',
      expectedFencingTokenDigest: lease.fencingTokenDigest,
      occurredAt: '2026-07-29T12:00:01.000Z',
    });
    expect(() => adoptTargetPromotionLease(released, {
      expectedOwnerProcessIdentityDigest:
        released.ownerProcessIdentityDigest,
      expectedFencingTokenDigest: released.fencingTokenDigest,
      nextOwnerProcessIdentityDigest: digest('process-next'),
      nextFencingTokenDigest: digest('fencing-next'),
      occurredAt: '2026-07-29T12:00:02.000Z',
    })).toThrow(/adoption/u);
  });
});

function fingerprint() {
  return createTargetStateFingerprint({
    targetWorkspaceIdentity: digest('workspace'),
    targetGitCommonDirIdentity: digest('git-common-dir'),
    headOid: 'a'.repeat(40),
    branchRef: 'refs/heads/main',
    branchRefDigest: digest('branch'),
    indexDigest: digest('index'),
    trackedWorkingDeltaDigest: digest('tracked-delta'),
    untrackedProjectionDigest: digest('untracked'),
    protectedRefsDigest: digest('refs'),
    sourceSnapshotDigest: digest('source'),
    promotableContentDigest: digest('content'),
  });
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/target-promotion/v1', label);
}
