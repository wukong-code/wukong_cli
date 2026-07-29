import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgePromotionConsent,
  canonicalDigest,
  createPromotionConsentProposal,
  createTargetStateFingerprint,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireOrRecoverTargetPromotionLease,
} from '../src/isolated-loop-runtime';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';

const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T13:00:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('isolated Loop promotion lease recovery', () => {
  it('acquires once and resumes the same pre-Apply process exactly', async () => {
    const value = await fixture();
    const authority = processAuthority(
      await proof(42, 'same-process'),
    );
    const acquired = await acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: authority,
    });
    const resumed = await acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: authority,
    });

    expect(resumed.lease).toEqual(acquired.lease);
    await expect(value.store.transition(
      resumed.binding,
      'applying',
    )).resolves.toMatchObject({
      lease: { state: 'applying' },
    });
  });

  it('adopts only a provably dead pre-Apply process', async () => {
    const value = await fixture('dead');
    const acquired = await acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: processAuthority(
        await proof(42, 'old-process'),
      ),
    });
    const nextProof = await proof(84, 'next-process');
    const adopted = await acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: processAuthority(nextProof),
    });

    expect(adopted.lease).toMatchObject({
      state: 'acquired',
      registryRevision: acquired.lease.registryRevision + 1,
      previousLeaseDigest: acquired.lease.leaseDigest,
      ownerProcessIdentityDigest: nextProof.proofDigest,
    });
    await expect(value.store.transition(
      acquired.binding,
      'applying',
    )).rejects.toMatchObject({
      reasonCode: 'promotion_fencing_lost',
    });
  });

  it('does not recover across Apply or when liveness is unknown', async () => {
    const probe = vi.fn(() => Promise.resolve('unknown' as const));
    const value = await fixture(probe);
    const acquired = await acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: processAuthority(
        await proof(42, 'old-process'),
      ),
    });
    await expect(acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: processAuthority(
        await proof(84, 'next-process'),
      ),
    })).rejects.toMatchObject({
      reasonCode: 'promotion_liveness_unproven',
    });
    const applying = await value.store.transition(
      acquired.binding,
      'applying',
    );
    probe.mockClear();
    await expect(acquireOrRecoverTargetPromotionLease({
      ...value.input,
      processAuthority: processAuthority(
        await proof(126, 'third-process'),
      ),
    })).rejects.toMatchObject({
      reasonCode: 'promotion_liveness_unproven',
    });
    expect(applying.lease.state).toBe('applying');
    expect(probe).toHaveBeenCalledOnce();
  });
});

async function fixture(
  outcome:
    | 'live'
    | 'dead'
    | 'unknown'
    | (() => Promise<'live' | 'dead' | 'unknown'>) = 'live',
) {
  const registryRoot = await mkdtemp(
    join(tmpdir(), 'wukong-runtime-promotion-'),
  );
  roots.push(registryRoot);
  let tick = 0;
  const targetFingerprint = createTargetStateFingerprint({
    targetWorkspaceIdentity: digest('workspace'),
    targetGitCommonDirIdentity: digest('git-common-dir'),
    headOid: 'a'.repeat(40),
    branchRef: 'refs/heads/main',
    branchRefDigest: digest('branch'),
    indexDigest: digest('index'),
    trackedWorkingDeltaDigest: digest('tracked'),
    untrackedProjectionDigest: digest('untracked'),
    protectedRefsDigest: digest('protected-refs'),
    sourceSnapshotDigest: digest('source'),
    promotableContentDigest: digest('content'),
  });
  const proposal = createPromotionConsentProposal({
    promotionId: '019f8cc0-1000-7abc-8def-0123456789ab',
    candidateId: '019f8cc0-1001-7abc-8def-0123456789ab',
    candidateDeltaDigest: digest('candidate-delta'),
    candidateGateResultDigest: digest('candidate-gate'),
    sourceSnapshotDigest: digest('source'),
    targetFingerprint,
    permissionDigest: digest('permission'),
  });
  const probeLiveness = typeof outcome === 'function'
    ? outcome
    : () => Promise.resolve(outcome);
  const store = new TargetPromotionLeaseStore({
    registryRootDirectory: registryRoot,
    now: () => new Date(BASE_TIME + tick++ * 1_000),
    probeLiveness,
  });
  return {
    store,
    input: {
      store,
      consent: acknowledgePromotionConsent(
        proposal,
        proposal.proposalDigest,
        '2026-07-29T12:59:00.000Z',
      ),
      targetFingerprint,
      ownerRunId: 'run_promotion',
    },
  };
}

function processAuthority(
  livenessProof: Awaited<
    ReturnType<typeof captureProcessLivenessProof>
  >,
) {
  return {
    identityDigest: livenessProof.proofDigest,
    livenessProof,
  };
}

function proof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/target-promotion-runtime-recovery/v1',
    label,
  );
}
