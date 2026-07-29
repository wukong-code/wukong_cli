import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgePromotionConsent,
  canonicalDigest,
  canonicalJson,
  createPromotionConsentProposal,
  createTargetStateFingerprint,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  TargetPromotionLeaseStore,
  TargetPromotionLeaseStoreError,
} from '../src/target-promotion-lease-store';

const PROMOTION_ID = '019f8cc0-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8cc0-0001-7abc-8def-0123456789ab';
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T13:00:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('TargetPromotionLeaseStore', () => {
  it('serializes one target owner and fences every CAS transition', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const competing = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 1_000),
    });

    expect(JSON.stringify(acquired.binding)).toContain('[REDACTED]');
    await expect(competing.acquire({
      ...value.acquire,
      ownerRunId: 'run_competing',
      ownerProcessIdentityDigest: digest('process-competing'),
      ownerProcessLivenessProof: undefined,
    })).rejects.toMatchObject({ reasonCode: 'promotion_target_busy' });

    const applying = await value.store.transition(
      acquired.binding,
      'applying',
    );
    expect(applying.lease).toMatchObject({
      state: 'applying',
      registryRevision: 1,
      previousLeaseDigest: acquired.lease.leaseDigest,
    });
    await expect(value.store.transition(
      acquired.binding,
      'final_verifying',
    )).rejects.toMatchObject({ reasonCode: 'promotion_fencing_lost' });
    const finalVerifying = await value.store.transition(
      applying.binding,
      'final_verifying',
    );
    const released = await value.store.transition(
      finalVerifying.binding,
      'released',
    );
    const next = await competing.acquire({
      ...value.acquire,
      ownerRunId: 'run_next',
      ownerProcessIdentityDigest: digest('process-next'),
      ownerProcessLivenessProof: undefined,
    });
    expect(next.lease.registryRevision)
      .toBe(released.lease.registryRevision + 1);
    expect(next.lease.previousLeaseDigest).toBe(released.lease.leaseDigest);
    expect(next.lease.fencingTokenDigest)
      .not.toBe(released.lease.fencingTokenDigest);
  });

  it('repairs one journal-ahead write and fails closed on event tampering', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const applying = await value.store.transition(
      acquired.binding,
      'applying',
    );
    const paths = value.paths(applying.lease.targetRegistryKey);
    await writeFile(paths.lease, canonicalJson(acquired.lease), {
      mode: 0o600,
    });
    const reopened = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 2_000),
    });

    await expect(reopened.inspect(applying.lease.targetRegistryKey))
      .resolves.toMatchObject({
        state: 'applying',
        leaseDigest: applying.lease.leaseDigest,
      });
    const eventPath = join(paths.events, '000000000001.json');
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
      eventDigest: string;
    };
    event.eventDigest = digest('tampered-event');
    await writeFile(eventPath, JSON.stringify(event), { mode: 0o600 });
    await expect(reopened.inspect(applying.lease.targetRegistryKey))
      .rejects.toBeInstanceOf(TargetPromotionLeaseStoreError);
    await expect(reopened.inspect(applying.lease.targetRegistryKey))
      .rejects.toMatchObject({
        reasonCode: 'promotion_lease_integrity_failed',
      });
  });

  it('rejects a recomputed event digest with false transition semantics', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const applying = await value.store.transition(
      acquired.binding,
      'applying',
    );
    const paths = value.paths(applying.lease.targetRegistryKey);
    const eventPath = join(paths.events, '000000000001.json');
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
      eventDigest: string;
      eventType: string;
      [key: string]: unknown;
    };
    const { eventDigest: _eventDigest, ...core } = {
      ...event,
      eventType: 'ownership_adopted',
    };
    await writeFile(eventPath, canonicalJson({
      ...core,
      eventDigest: canonicalDigest(
        'wukong/target-promotion-lease-event/v1',
        core,
      ),
    }), { mode: 0o600 });

    await expect(value.store.inspect(
      applying.lease.targetRegistryKey,
    )).rejects.toMatchObject({
      reasonCode: 'promotion_lease_integrity_failed',
    });
  });

  it('uses private registry permissions and exact owned resume', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const paths = value.paths(acquired.lease.targetRegistryKey);
    if (process.platform !== 'win32') {
      expect((await lstat(value.registryRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(paths.lease)).mode & 0o777).toBe(0o600);
      expect((await lstat(paths.capability)).mode & 0o777).toBe(0o600);
    }
    await expect(value.store.resumeOwned({
      targetRegistryKey: acquired.lease.targetRegistryKey,
      ownerRunId: value.acquire.ownerRunId,
      ownerProcessIdentityDigest:
        value.acquire.ownerProcessIdentityDigest,
      expectedLeaseDigest: acquired.lease.leaseDigest,
    })).resolves.toMatchObject({
      lease: { leaseDigest: acquired.lease.leaseDigest },
    });
    await expect(value.store.resumeOwned({
      targetRegistryKey: acquired.lease.targetRegistryKey,
      ownerRunId: value.acquire.ownerRunId,
      ownerProcessIdentityDigest: digest('other-process'),
      expectedLeaseDigest: acquired.lease.leaseDigest,
    })).rejects.toMatchObject({ reasonCode: 'promotion_fencing_lost' });
  });

  it('holds one OS lock across an exclusive Apply callback', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const applying = await value.store.transition(
      acquired.binding,
      'applying',
    );
    let releaseCallback!: () => void;
    const callbackRelease = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    let enteredCallback!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      enteredCallback = resolve;
    });
    let escapedAssertion: (() => Promise<void>) | undefined;
    const exclusive = value.store.withExclusiveLease(
      applying.binding,
      'applying',
      async (view) => {
        escapedAssertion = view.assertAuthority;
        await view.assertAuthority();
        expect(view.registryDirectory)
          .toContain(applying.lease.targetRegistryKey.slice('sha256:'.length));
        enteredCallback();
        await callbackRelease;
      },
    );
    await callbackEntered;
    const competing = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 2_000),
    });
    let transitionSettled = false;
    const transition = competing.transition(
      applying.binding,
      'final_verifying',
    ).finally(() => {
      transitionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transitionSettled).toBe(false);
    releaseCallback();
    await exclusive;
    await expect(transition).resolves.toMatchObject({
      lease: { state: 'final_verifying' },
    });
    if (escapedAssertion === undefined) {
      throw new Error('Exclusive assertion was not captured.');
    }
    await expect(escapedAssertion()).rejects.toMatchObject({
      reasonCode: 'promotion_fencing_lost',
    });
  });

  it('adopts a provably dead acquired owner and fences the old binding', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const nextProof = await proof(84, 'next-process');
    const adopting = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 1_000),
      probeLiveness: () => Promise.resolve('dead'),
    });

    const adopted = await adopting.adoptAcquired({
      targetRegistryKey: acquired.lease.targetRegistryKey,
      ownerRunId: value.acquire.ownerRunId,
      expectedLeaseDigest: acquired.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });

    expect(adopted.lease).toMatchObject({
      state: 'acquired',
      ownerRunId: acquired.lease.ownerRunId,
      ownerProcessIdentityDigest: nextProof.proofDigest,
      previousLeaseDigest: acquired.lease.leaseDigest,
      registryRevision: acquired.lease.registryRevision + 1,
    });
    expect(adopted.lease.fencingTokenDigest)
      .not.toBe(acquired.lease.fencingTokenDigest);
    await expect(value.store.transition(
      acquired.binding,
      'applying',
    )).rejects.toMatchObject({
      reasonCode: 'promotion_fencing_lost',
    });
    await expect(adopting.resumeOwned({
      targetRegistryKey: adopted.lease.targetRegistryKey,
      ownerRunId: adopted.lease.ownerRunId,
      ownerProcessIdentityDigest: nextProof.proofDigest,
      expectedLeaseDigest: adopted.lease.leaseDigest,
    })).resolves.toMatchObject({
      lease: { leaseDigest: adopted.lease.leaseDigest },
    });
  });

  it('allows exactly one concurrent adoption winner', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const first = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 1_000),
      probeLiveness: () => Promise.resolve('dead'),
    });
    const second = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 2_000),
      probeLiveness: () => Promise.resolve('dead'),
    });
    const results = await Promise.allSettled([
      first.adoptAcquired({
        targetRegistryKey: acquired.lease.targetRegistryKey,
        ownerRunId: acquired.lease.ownerRunId,
        expectedLeaseDigest: acquired.lease.leaseDigest,
        nextProcessLivenessProof:
          await proof(84, 'first-process'),
      }),
      second.adoptAcquired({
        targetRegistryKey: acquired.lease.targetRegistryKey,
        ownerRunId: acquired.lease.ownerRunId,
        expectedLeaseDigest: acquired.lease.leaseDigest,
        nextProcessLivenessProof:
          await proof(126, 'second-process'),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { reasonCode: 'promotion_fencing_lost' },
    });
    const current = await value.store.inspect(
      acquired.lease.targetRegistryKey,
    );
    expect(current.registryRevision)
      .toBe(acquired.lease.registryRevision + 1);
  });

  it('never adopts a live, unknown, or post-Apply owner', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const nextProof = await proof(84, 'next-process');
    for (const outcome of ['live', 'unknown'] as const) {
      const adopting = new TargetPromotionLeaseStore({
        registryRootDirectory: value.registryRoot,
        probeLiveness: () => Promise.resolve(outcome),
      });
      await expect(adopting.adoptAcquired({
        targetRegistryKey: acquired.lease.targetRegistryKey,
        ownerRunId: acquired.lease.ownerRunId,
        expectedLeaseDigest: acquired.lease.leaseDigest,
        nextProcessLivenessProof: nextProof,
      })).rejects.toMatchObject({
        reasonCode: outcome === 'live'
          ? 'promotion_owner_live'
          : 'promotion_liveness_unproven',
      });
    }
    const applying = await value.store.transition(
      acquired.binding,
      'applying',
    );
    const probeLiveness = vi.fn(() => Promise.resolve('dead' as const));
    const adopting = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      probeLiveness,
    });
    await expect(adopting.adoptAcquired({
      targetRegistryKey: applying.lease.targetRegistryKey,
      ownerRunId: applying.lease.ownerRunId,
      expectedLeaseDigest: applying.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    })).rejects.toMatchObject({
      reasonCode: 'promotion_adoption_unsafe_state',
    });
    expect(probeLiveness).not.toHaveBeenCalled();
  });

  it('repairs adoption interrupted after its event without exposing the new token', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const paths = value.paths(acquired.lease.targetRegistryKey);
    const oldCapability = await readFile(paths.capability, 'utf8');
    const nextProof = await proof(84, 'next-process');
    const adopting = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 1_000),
      probeLiveness: () => Promise.resolve('dead'),
    });
    const adopted = await adopting.adoptAcquired({
      targetRegistryKey: acquired.lease.targetRegistryKey,
      ownerRunId: acquired.lease.ownerRunId,
      expectedLeaseDigest: acquired.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });
    const newCapability = JSON.parse(
      await readFile(paths.capability, 'utf8'),
    ) as {
      rawFencingToken: string;
    };
    const pendingCore = {
      schemaVersion: 1,
      targetPromotionLeaseId:
        adopted.lease.targetPromotionLeaseId,
      targetRegistryKey: adopted.lease.targetRegistryKey,
      previousLeaseDigest: acquired.lease.leaseDigest,
      nextLease: adopted.lease,
      nextRawFencingToken: newCapability.rawFencingToken,
      nextProcessLivenessProof: nextProof,
    };
    await writeFile(
      paths.adoptionPending,
      canonicalJson({
        ...pendingCore,
        pendingDigest: canonicalDigest(
          'wukong/target-promotion-adoption-pending/v1',
          pendingCore,
        ),
      }),
      { mode: 0o600 },
    );
    await writeFile(paths.lease, canonicalJson(acquired.lease), {
      mode: 0o600,
    });
    await writeFile(paths.capability, oldCapability, {
      mode: 0o600,
    });

    const reopened = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
    });
    await expect(reopened.inspect(adopted.lease.targetRegistryKey))
      .resolves.toMatchObject({
        leaseDigest: adopted.lease.leaseDigest,
      });
    await expect(reopened.resumeOwned({
      targetRegistryKey: adopted.lease.targetRegistryKey,
      ownerRunId: adopted.lease.ownerRunId,
      ownerProcessIdentityDigest: nextProof.proofDigest,
      expectedLeaseDigest: adopted.lease.leaseDigest,
    })).resolves.toMatchObject({
      lease: { leaseDigest: adopted.lease.leaseDigest },
    });
  });

  it('rolls back adoption interrupted before its event', async () => {
    const value = await fixture();
    const acquired = await value.store.acquire(value.acquire);
    const paths = value.paths(acquired.lease.targetRegistryKey);
    const oldCapability = await readFile(paths.capability, 'utf8');
    const nextProof = await proof(84, 'next-process');
    const adopting = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
      now: () => new Date(BASE_TIME + 1_000),
      probeLiveness: () => Promise.resolve('dead'),
    });
    const adopted = await adopting.adoptAcquired({
      targetRegistryKey: acquired.lease.targetRegistryKey,
      ownerRunId: acquired.lease.ownerRunId,
      expectedLeaseDigest: acquired.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });
    const newCapability = JSON.parse(
      await readFile(paths.capability, 'utf8'),
    ) as {
      rawFencingToken: string;
    };
    const pendingCore = {
      schemaVersion: 1,
      targetPromotionLeaseId:
        adopted.lease.targetPromotionLeaseId,
      targetRegistryKey: adopted.lease.targetRegistryKey,
      previousLeaseDigest: acquired.lease.leaseDigest,
      nextLease: adopted.lease,
      nextRawFencingToken: newCapability.rawFencingToken,
      nextProcessLivenessProof: nextProof,
    };
    await writeFile(paths.adoptionPending, canonicalJson({
      ...pendingCore,
      pendingDigest: canonicalDigest(
        'wukong/target-promotion-adoption-pending/v1',
        pendingCore,
      ),
    }), { mode: 0o600 });
    await unlink(join(paths.events, '000000000001.json'));
    await writeFile(paths.lease, canonicalJson(acquired.lease), {
      mode: 0o600,
    });
    await writeFile(paths.capability, oldCapability, {
      mode: 0o600,
    });

    const reopened = new TargetPromotionLeaseStore({
      registryRootDirectory: value.registryRoot,
    });
    await expect(reopened.inspect(acquired.lease.targetRegistryKey))
      .resolves.toMatchObject({
        leaseDigest: acquired.lease.leaseDigest,
      });
    await expect(readFile(paths.adoptionPending, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(reopened.resumeOwned({
      targetRegistryKey: acquired.lease.targetRegistryKey,
      ownerRunId: acquired.lease.ownerRunId,
      ownerProcessIdentityDigest:
        value.acquire.ownerProcessIdentityDigest,
      expectedLeaseDigest: acquired.lease.leaseDigest,
    })).resolves.toMatchObject({
      lease: { leaseDigest: acquired.lease.leaseDigest },
    });
  });
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-promotion-lease-'));
  roots.push(parent);
  const registryRoot = join(parent, 'registry');
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
    promotionId: PROMOTION_ID,
    candidateId: CANDIDATE_ID,
    candidateDeltaDigest: digest('candidate-delta'),
    candidateGateResultDigest: digest('candidate-gate'),
    sourceSnapshotDigest: digest('source'),
    targetFingerprint,
    permissionDigest: digest('permission'),
  });
  const ownerProcessLivenessProof =
    await proof(42, 'owner-process');
  const acquire = {
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T12:59:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: 'run_promotion',
    ownerProcessIdentityDigest:
      ownerProcessLivenessProof.proofDigest,
    ownerProcessLivenessProof,
  };
  return {
    registryRoot,
    acquire,
    store: new TargetPromotionLeaseStore({
      registryRootDirectory: registryRoot,
      now: () => new Date(BASE_TIME),
    }),
    paths: (key: string) => {
      const directory = join(
        registryRoot,
        key.slice('sha256:'.length),
      );
      return {
        directory,
        lease: join(directory, 'lease.json'),
        capability: join(directory, 'capability.json'),
        adoptionPending: join(
          directory,
          'adoption-pending.json',
        ),
        events: join(directory, 'events'),
      };
    },
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
    'wukong/test/target-promotion-lease-store/v1',
    label,
  );
}
