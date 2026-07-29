import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalDigest,
  createIsolatedLoopCandidateBinding,
  createWorktreeLease,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireOrRecoverWorktreeLease,
} from '../src/isolated-loop-runtime';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  WorktreeLeaseStore,
  type WorktreeLeaseAuthorityV1,
} from '../src/worktree-lease-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('isolated Loop worktree owner recovery', () => {
  it('resumes the exact same process identity without rotating fencing', async () => {
    const value = await fixture();
    const expected = authority(value.lease);
    const resumeOwned = vi.spyOn(value.store, 'resumeOwned')
      .mockResolvedValue(expected);
    const adoptDeadOwner = vi.spyOn(value.store, 'adoptDeadOwner');

    await expect(acquireOrRecoverWorktreeLease({
      store: value.store,
      binding: value.binding,
      processAuthority: {
        identityDigest: value.lease.ownerProcessIdentityDigest,
      },
    })).resolves.toBe(expected);
    expect(resumeOwned).toHaveBeenCalledWith({
      candidateId: value.lease.candidateId,
      runId: value.lease.runId,
      ownerRunId: value.lease.ownerRunId,
      ownerProcessIdentityDigest:
        value.lease.ownerProcessIdentityDigest,
      expectedLeaseDigest: value.lease.leaseDigest,
    });
    expect(adoptDeadOwner).not.toHaveBeenCalled();
  });

  it('fails closed when a different process cannot prove liveness', async () => {
    const value = await fixture();
    await expect(acquireOrRecoverWorktreeLease({
      store: value.store,
      binding: value.binding,
      processAuthority: {
        identityDigest: digest('fallback-process'),
      },
    })).rejects.toMatchObject({
      reasonCode: 'worktree_lease_liveness_unproven',
    });
  });

  it('delegates a different proven process to dead-owner adoption', async () => {
    const value = await fixture();
    const nextProof = await processProof(84, 'next-process');
    const expected = authority(value.lease);
    const adoptDeadOwner = vi.spyOn(value.store, 'adoptDeadOwner')
      .mockResolvedValue(expected);

    await expect(acquireOrRecoverWorktreeLease({
      store: value.store,
      binding: value.binding,
      processAuthority: {
        identityDigest: nextProof.proofDigest,
        livenessProof: nextProof,
      },
    })).resolves.toBe(expected);
    expect(adoptDeadOwner).toHaveBeenCalledWith({
      candidateId: value.lease.candidateId,
      runId: value.lease.runId,
      ownerRunId: value.lease.ownerRunId,
      expectedLeaseDigest: value.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });
  });
});

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), 'wukong-worktree-runtime-recovery-'),
  );
  roots.push(root);
  const process = await processProof(42, 'old-process');
  const created = createWorktreeLease({
    leaseId: '019f8cf0-0000-7abc-8def-0123456789ab',
    candidateId: '019f8cf0-0001-7abc-8def-0123456789ab',
    goalId: '019f8cf0-0002-7abc-8def-0123456789ab',
    contractId: '019f8cf0-0003-7abc-8def-0123456789ab',
    runId: '019f8cf0-0004-7abc-8def-0123456789ab',
    ownerRunId: '019f8cf0-0005-7abc-8def-0123456789ab',
    ownerProcessIdentityDigest: process.proofDigest,
    sourceSnapshotDigest: digest('source'),
    snapshotBlobLeaseId:
      '019f8cf0-0006-7abc-8def-0123456789ab',
    snapshotBlobLeaseDigest: digest('blob-lease'),
    manifestDigest: digest('manifest'),
    materializationPolicyDigest: digest('materialization-policy'),
    bootstrapPlanDigest: digest('bootstrap'),
    gatePlanDigest: digest('gate'),
    criteriaSelectionDigest: null,
    repositoryIdentity: digest('repository'),
    baseCommit: 'a'.repeat(40),
    repositoryRelativeCwd: '.',
    candidateBranch:
      'wukong/candidate/019f8cf0-0001-7abc-8def-0123456789ab',
    createdByRunId: '019f8cf0-0004-7abc-8def-0123456789ab',
    createdAt: '2026-07-29T13:00:00.000Z',
    expiresAt: '2026-07-29T14:00:00.000Z',
    fencingTokenDigest: digest('fencing'),
  });
  const binding = createIsolatedLoopCandidateBinding({
    goalId: created.lease.goalId,
    contractId: created.lease.contractId,
    runId: created.lease.runId,
    ownerRunId: created.lease.ownerRunId,
    candidateId: created.lease.candidateId,
    worktreeLeaseId: created.lease.leaseId,
    sourceSnapshotDigest: created.lease.sourceSnapshotDigest,
    bootstrapPlanDigest: created.lease.bootstrapPlanDigest,
    gatePlanDigest: created.lease.gatePlanDigest,
    criteriaSelectionDigest: created.lease.criteriaSelectionDigest,
    reservedLeaseDigest: created.lease.leaseDigest,
    createdAt: created.lease.createdAt,
  });
  const store = new WorktreeLeaseStore({
    candidatesRootDirectory: root,
  });
  vi.spyOn(store, 'inspect').mockResolvedValue(created.lease);
  return { store, lease: created.lease, binding };
}

function authority(
  lease: ReturnType<typeof createWorktreeLease>['lease'],
): WorktreeLeaseAuthorityV1 {
  return {
    lease,
    binding: {} as WorktreeLeaseAuthorityV1['binding'],
  };
}

function processProof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/worktree-runtime-recovery/v1',
    label,
  );
}
