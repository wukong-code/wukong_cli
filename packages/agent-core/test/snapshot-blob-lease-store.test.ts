import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSnapshotMaterializationContainer,
  canonicalDigest,
  digestSourceSnapshotPolicy,
  SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  SOURCE_SNAPSHOT_LIMITS,
  type SourceSnapshotV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SnapshotBlobLeaseStore,
  SnapshotBlobLeaseStoreError,
} from '../src/snapshot-blob-lease-store';

vi.setConfig({ testTimeout: 20_000 });

const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-28T08:00:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function digest(label: string): string {
  return canonicalDigest('wukong/test/snapshot-blob-store/v1', label);
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update('wukong/snapshot-file-content/v1')
    .update('\0')
    .update(content)
    .digest('hex')}`;
}

function gitBlobObjectId(content: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function fixture() {
  const tracked = Buffer.from('tracked staged\n');
  const untracked = Buffer.from('selected untracked\n');
  const trackedObjectId = gitBlobObjectId(tracked);
  const trackedProjection = [{
    path: 'src/tracked.ts',
    index: [{ mode: '100644', objectId: trackedObjectId, stage: 0 }],
    worktree: {
      presence: 'present',
      fileType: 'regular',
      mode: 0o100644,
      sizeBytes: tracked.byteLength,
      contentDigest: contentDigest(tracked),
      exclusionReason: null,
    },
  }];
  const untrackedCore = {
    canonicalRelativePath: 'src/new.ts',
    mode: 0o100644,
    sizeBytes: untracked.byteLength,
    contentDigest: contentDigest(untracked),
  };
  const snapshotCore = {
    schemaVersion: 1 as const,
    snapshotPolicyVersion: 'source-snapshot/1',
    snapshotLimits: SOURCE_SNAPSHOT_LIMITS,
    snapshotPolicyDigest: digestSourceSnapshotPolicy(SOURCE_SNAPSHOT_LIMITS),
    sourceWorkspaceIdentity: digest('workspace'),
    repositoryIdentity: digest('repository'),
    repositoryRelativeCwd: '.',
    baseCommit: 'a'.repeat(40),
    branchName: 'main',
    headTreeDigest: digest('tree'),
    indexDigest: digest('index'),
    trackedDeltaDigest: canonicalDigest(
      'wukong/source-tracked-delta/v1',
      trackedProjection,
    ),
    includedUntracked: [{
      ...untrackedCore,
      fileRefDigest: canonicalDigest('wukong/snapshot-file-ref/v1', untrackedCore),
    }],
    exclusions: [],
  };
  const sourceSnapshot: SourceSnapshotV1 = {
    ...snapshotCore,
    snapshotDigest: canonicalDigest('wukong/source-snapshot/v1', snapshotCore),
  };
  const built = buildSnapshotMaterializationContainer({
    sourceSnapshotDigest: sourceSnapshot.snapshotDigest,
    snapshotPolicyDigest: sourceSnapshot.snapshotPolicyDigest,
    materializationPolicyDigest: SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
    entries: [
      {
        canonicalRelativePath: 'src/tracked.ts',
        selectedUntracked: false,
        indexObjectId: trackedObjectId,
        indexImage: { mode: 0o100644, content: tracked },
        worktreeImage: { mode: 0o100644, content: tracked },
      },
      {
        canonicalRelativePath: 'src/new.ts',
        selectedUntracked: true,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: { mode: 0o100644, content: untracked },
      },
    ],
  });
  return { built, sourceSnapshot, tracked, untracked };
}

async function makeStore(nowReference?: { value: number }) {
  const nowRef = nowReference ?? { value: BASE_TIME };
  const parent = await mkdtemp(join(tmpdir(), 'wukong-snapshot-blob-store-'));
  roots.push(parent);
  const rootDirectory = join(parent, 'snapshot-blobs');
  return {
    nowRef,
    parent,
    rootDirectory,
    store: new SnapshotBlobLeaseStore({
      rootDirectory,
      now: () => new Date(nowRef.value),
    }),
  };
}

async function stage(
  store: SnapshotBlobLeaseStore,
  expiresAt = '2026-07-28T08:10:00.000Z',
) {
  const { built, sourceSnapshot } = fixture();
  return store.stageAndSeal({
    containerBytes: built.containerBytes,
    sourceSnapshot,
    createdByRunId: 'run_creator',
    ownerRunId: 'run_owner',
    expiresAt,
  });
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

async function readTreeText(root: string): Promise<string> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(await readTreeText(path));
    else if (entry.isFile()) {
      output.push(await readFile(path, 'utf8').catch(() => ''));
    }
  }
  return output.join('\n');
}

describe('SnapshotBlobLeaseStore', () => {
  it('seals, confirms, consumes and durably destroys a private payload', async () => {
    const { rootDirectory, store } = await makeStore();
    const sealed = await stage(store);
    const leaseDirectory = join(rootDirectory, sealed.lease.blobLeaseId);

    expect(sealed.lease.state).toBe('sealed');
    expect(Object.keys(sealed.binding).toSorted()).toEqual([
      'blobLeaseId',
      'casRevision',
      'leaseDigest',
      'ownerRunId',
    ]);
    expect(JSON.stringify(sealed.binding)).toContain('[REDACTED]');

    if (process.platform !== 'win32') {
      expect(modeBits((await lstat(rootDirectory)).mode)).toBe(0o700);
      expect(modeBits((await lstat(leaseDirectory)).mode)).toBe(0o700);
      expect(modeBits((await lstat(join(leaseDirectory, 'events'))).mode)).toBe(0o700);
      for (const file of [
        'lease.json',
        'source-snapshot.json',
        'payload.bin',
        'capability.json',
        'lock',
      ]) {
        expect(modeBits((await lstat(join(leaseDirectory, file))).mode)).toBe(0o600);
      }
    }

    const confirmed = await store.confirm(sealed.binding);
    const result = await store.consumeAndDestroy(confirmed.binding, (view) => {
      expect(Object.isFrozen(view.manifest)).toBe(true);
      expect('payloadBytes' in view).toBe(false);
      const entry = view.manifest.entries.find(
        (candidate) => candidate.canonicalRelativePath === 'src/new.ts',
      );
      expect(entry?.worktreeImage).not.toBeNull();
      expect(Buffer.from(view.readImage(entry!.worktreeImage!)).toString('utf8'))
        .toBe('selected untracked\n');
      expect(() => view.readImage({
        ...entry!.worktreeImage!,
        sizeBytes: 1,
      })).toThrow(/not part of the verified snapshot manifest/u);
      return 'materialized';
    });

    expect(result).toMatchObject({
      result: 'materialized',
      lease: { state: 'destroyed' },
    });
    await expect(access(join(leaseDirectory, 'payload.bin')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(leaseDirectory, 'capability.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(leaseDirectory, 'lease.json'), 'utf8')))
      .toMatchObject({ state: 'destroyed' });
  });

  it('enforces 0700/0600 even when the process umask is 000', async () => {
    if (process.platform === 'win32') return;
    const previous = process.umask(0);
    try {
      const { rootDirectory, store } = await makeStore();
      const sealed = await stage(store);
      const directory = join(rootDirectory, sealed.lease.blobLeaseId);

      expect(modeBits((await lstat(directory)).mode)).toBe(0o700);
      expect(modeBits((await lstat(join(directory, 'payload.bin'))).mode)).toBe(0o600);
      await store.destroy(sealed.binding, 'test_cleanup');
    } finally {
      process.umask(previous);
    }
  });

  it('rejects a stale revision binding and keeps the exact newer owner', async () => {
    const { store } = await makeStore();
    const sealed = await stage(store);
    const confirmed = await store.confirm(sealed.binding);

    await expect(store.destroy(sealed.binding, 'stale_cleanup'))
      .rejects.toMatchObject({ reasonCode: 'snapshot_blob_stale_binding' });
    expect((await store.inspect(confirmed.lease.blobLeaseId)).state).toBe('confirmed');
    expect((await store.destroy(confirmed.binding, 'current_cleanup')).state)
      .toBe('destroyed');
  });

  it('restores only the exact private owner capability after restart', async () => {
    const { rootDirectory, store } = await makeStore();
    const sealed = await stage(store);
    const confirmed = await store.confirm(sealed.binding);
    const restarted = new SnapshotBlobLeaseStore({
      rootDirectory,
      now: () => new Date(BASE_TIME),
    });

    await expect(restarted.resumeOwned({
      blobLeaseId: confirmed.lease.blobLeaseId,
      ownerRunId: 'another_owner',
      expectedLeaseDigest: confirmed.lease.leaseDigest,
    })).rejects.toMatchObject({
      reasonCode: 'snapshot_blob_stale_binding',
    });
    const resumed = await restarted.resumeOwned({
      blobLeaseId: confirmed.lease.blobLeaseId,
      ownerRunId: confirmed.lease.ownerRunId,
      expectedLeaseDigest: confirmed.lease.leaseDigest,
    });
    const consumed = await restarted.consumeAndDestroy(
      resumed.binding,
      () => 'resumed',
    );

    expect(consumed.result).toBe('resumed');
    expect(consumed.lease.state).toBe('destroyed');
  });

  it('rejects a self-consistent container that is not the approved source projection', async () => {
    const { rootDirectory, store } = await makeStore();
    const { sourceSnapshot } = fixture();
    const arbitrary = buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: sourceSnapshot.snapshotDigest,
      snapshotPolicyDigest: sourceSnapshot.snapshotPolicyDigest,
      materializationPolicyDigest: SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
      entries: [{
        canonicalRelativePath: 'arbitrary-delete.ts',
        selectedUntracked: false,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: null,
      }],
    });

    await expect(store.stageAndSeal({
      containerBytes: arbitrary.containerBytes,
      sourceSnapshot,
      createdByRunId: 'run_creator',
      ownerRunId: 'run_owner',
      expiresAt: '2026-07-28T08:10:00.000Z',
    })).rejects.toBeInstanceOf(SnapshotBlobLeaseStoreError);
    expect(await readdir(rootDirectory)).toEqual([]);
  });

  it.each([
    ['single-byte tamper', (bytes: Buffer) => {
      bytes.writeUInt8((bytes.at(-1) ?? 0) ^ 1, bytes.length - 1);
      return bytes;
    }],
    ['truncate', (bytes: Buffer) => bytes.subarray(0, bytes.length - 1)],
    ['append', (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([0])])],
  ])('marks a %s payload corrupt and reconciles its destruction', async (_name, mutate) => {
    const { rootDirectory, store } = await makeStore();
    const sealed = await stage(store);
    const payloadPath = join(rootDirectory, sealed.lease.blobLeaseId, 'payload.bin');
    const original = await readFile(payloadPath);
    await writeFile(payloadPath, mutate(Buffer.from(original)), { mode: 0o600 });

    await expect(store.confirm(sealed.binding))
      .rejects.toMatchObject({ reasonCode: 'snapshot_blob_integrity_failed' });
    expect((await store.inspect(sealed.lease.blobLeaseId)).state).toBe('corrupt');
    const reconciled = await store.reconcileExpired();
    expect(reconciled).toMatchObject([{ state: 'destroyed' }]);
    await expect(access(payloadPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['symlink', 'hardlink'] as const)(
    'fails closed when the payload is replaced by a %s',
    async (replacement) => {
      if (process.platform === 'win32' && replacement === 'symlink') return;
      const { parent, rootDirectory, store } = await makeStore();
      const sealed = await stage(store);
      const payloadPath = join(rootDirectory, sealed.lease.blobLeaseId, 'payload.bin');
      const outside = join(parent, 'outside.txt');
      await writeFile(outside, 'outside must survive\n', { mode: 0o600 });
      await unlink(payloadPath);
      if (replacement === 'symlink') await symlink(outside, payloadPath);
      else await link(outside, payloadPath);

      await expect(store.confirm(sealed.binding))
        .rejects.toMatchObject({ reasonCode: 'snapshot_blob_integrity_failed' });
      await expect(store.reconcileExpired())
        .rejects.toMatchObject({ reasonCode: 'snapshot_blob_integrity_failed' });
      expect(await readFile(outside, 'utf8')).toBe('outside must survive\n');
    },
  );

  it('expires before confirmation and destroys through reconciliation', async () => {
    const nowRef = { value: BASE_TIME };
    const { rootDirectory, store } = await makeStore(nowRef);
    const sealed = await stage(store, '2026-07-28T08:00:01.000Z');
    nowRef.value = BASE_TIME + 2_000;

    await expect(store.confirm(sealed.binding))
      .rejects.toMatchObject({ reasonCode: 'snapshot_blob_expired' });
    expect((await store.inspect(sealed.lease.blobLeaseId)).state).toBe('expired');
    expect(await store.reconcileExpired()).toMatchObject([{ state: 'destroyed' }]);
    await expect(access(join(rootDirectory, sealed.lease.blobLeaseId, 'payload.bin')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes destroy idempotent for the same authentic owner binding', async () => {
    const { store } = await makeStore();
    const sealed = await stage(store);

    const first = await store.destroy(sealed.binding, 'user_cancelled');
    const second = await store.destroy(sealed.binding, 'user_cancelled');

    expect(first.state).toBe('destroyed');
    expect(second.leaseDigest).toBe(first.leaseDigest);
  });

  it('rejects a credential-shaped destroy reason and leaves a secret-free tombstone', async () => {
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const { rootDirectory, store } = await makeStore();
    const sealed = await stage(store);

    await expect(store.destroy(sealed.binding, secret))
      .rejects.toMatchObject({
        reasonCode: 'snapshot_blob_invalid_input',
      });
    expect((await store.inspect(sealed.lease.blobLeaseId)).state)
      .toBe('sealed');
    await store.destroy(sealed.binding, 'user_cancelled');

    const durableText = await readTreeText(rootDirectory);
    expect(durableText).not.toContain(secret);
    expect(durableText).toContain('"state":"destroyed"');
  });

  it('allows only one of two concurrent consumers to claim the lease', async () => {
    const { store } = await makeStore();
    const sealed = await stage(store);
    const confirmed = await store.confirm(sealed.binding);
    let callbackCount = 0;

    const attempts = await Promise.allSettled([
      store.consumeAndDestroy(confirmed.binding, () => {
        callbackCount += 1;
        return 'first';
      }),
      store.consumeAndDestroy(confirmed.binding, () => {
        callbackCount += 1;
        return 'second';
      }),
    ]);

    expect(callbackCount).toBe(1);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('leaves a failed callback in materializing attention without blind retry or destroy', async () => {
    const nowRef = { value: BASE_TIME };
    const { rootDirectory, store } = await makeStore(nowRef);
    const sealed = await stage(store);
    const confirmed = await store.confirm(sealed.binding);

    await expect(store.consumeAndDestroy(confirmed.binding, () => {
      throw new Error('candidate write failed');
    })).rejects.toThrow(/candidate write failed/u);
    expect((await store.inspect(sealed.lease.blobLeaseId)).state).toBe('materializing');
    nowRef.value = BASE_TIME + 20 * 60_000;
    expect(await store.reconcileExpired()).toEqual([]);
    await expect(access(join(rootDirectory, sealed.lease.blobLeaseId, 'payload.bin')))
      .resolves.toBeUndefined();
  });

  it('destroys a stranded materializing payload only after exact recovery ancestry', async () => {
    const { rootDirectory, store } = await makeStore();
    const sealed = await stage(store);
    const confirmed = await store.confirm(sealed.binding);

    await expect(store.consumeAndDestroy(confirmed.binding, () => {
      throw new Error('process stopped after verified materialization');
    })).rejects.toThrow(/process stopped/u);
    expect((await store.inspect(sealed.lease.blobLeaseId)).state)
      .toBe('materializing');

    const input = {
      blobLeaseId: confirmed.lease.blobLeaseId,
      ownerRunId: confirmed.lease.ownerRunId,
      expectedConfirmedLeaseDigest: confirmed.lease.leaseDigest,
      sourceSnapshotDigest: confirmed.lease.sourceSnapshotDigest,
      manifestDigest: confirmed.lease.manifestDigest,
    };
    await expect(store.recoverConsumedAfterMaterialization({
      ...input,
      manifestDigest: digest('wrong-manifest'),
    })).rejects.toMatchObject({
      reasonCode: 'snapshot_blob_stale_binding',
    });
    await expect(access(join(
      rootDirectory,
      sealed.lease.blobLeaseId,
      'payload.bin',
    ))).resolves.toBeUndefined();

    const destroyed = await store
      .recoverConsumedAfterMaterialization(input);
    const reopened = await store
      .recoverConsumedAfterMaterialization(input);
    expect(destroyed.state).toBe('destroyed');
    expect(reopened.leaseDigest).toBe(destroyed.leaseDigest);
    await expect(access(join(
      rootDirectory,
      sealed.lease.blobLeaseId,
      'payload.bin',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unknown journal entries instead of ignoring tamper evidence', async () => {
    const { rootDirectory, store } = await makeStore();
    const sealed = await stage(store);
    const events = join(rootDirectory, sealed.lease.blobLeaseId, 'events');
    await appendFile(join(events, 'unknown.json'), '{}', { mode: 0o600 });

    await expect(store.inspect(sealed.lease.blobLeaseId))
      .rejects.toMatchObject({ reasonCode: 'snapshot_blob_integrity_failed' });
  });
});
