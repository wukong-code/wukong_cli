import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalDigest, canonicalJson } from '../src/finish-line';
import { createSnapshotBlobLease } from '../src/snapshot-blob-lease';
import {
  buildSnapshotMaterializationContainer,
  digestSnapshotMaterializationContainer,
  parseSnapshotMaterializationContainer,
  SNAPSHOT_MATERIALIZATION_LIMITS,
  validateSnapshotBlobLeaseContainerBinding,
  validateSnapshotBlobLeaseSourceBinding,
  validateSnapshotMaterializationContainer,
  validateSnapshotMaterializationManifest,
  validateSnapshotMaterializationSourceBinding,
  type SnapshotMaterializationManifestV1,
} from '../src/snapshot-materialization';
import {
  digestSourceSnapshotPolicy,
  SOURCE_SNAPSHOT_LIMITS,
  type SourceSnapshotV1,
} from '../src/source-snapshot';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const HEADER_BYTES = 24;

function gitBlobObjectId(content: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function buildFixture() {
  const staged = Buffer.from('staged\n');
  return buildSnapshotMaterializationContainer({
    sourceSnapshotDigest: DIGEST_A,
    snapshotPolicyDigest: DIGEST_B,
    materializationPolicyDigest: DIGEST_C,
    entries: [
      {
        canonicalRelativePath: 'src/z.ts',
        selectedUntracked: true,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: {
          mode: 0o100644,
          content: Buffer.from('untracked\n'),
        },
      },
      {
        canonicalRelativePath: 'src/a.ts',
        selectedUntracked: false,
        indexObjectId: gitBlobObjectId(staged),
        indexImage: {
          mode: 0o100644,
          content: staged,
        },
        worktreeImage: {
          mode: 0o100755,
          content: Buffer.from('unstaged\n'),
        },
      },
    ],
  });
}

function buildSourceBoundFixture() {
  const indexContent = Buffer.from('staged\n');
  const worktreeContent = Buffer.from('unstaged\n');
  const untrackedContent = Buffer.from('untracked\n');
  const indexObjectId = gitBlobObjectId(indexContent);
  const sourceContentDigest = (content: Uint8Array) =>
    `sha256:${createHash('sha256')
      .update('wukong/snapshot-file-content/v1')
      .update('\0')
      .update(content)
      .digest('hex')}`;
  const trackedProjection = [{
    path: 'src/a.ts',
    index: [{ mode: '100644', objectId: indexObjectId, stage: 0 }],
    worktree: {
      presence: 'present',
      fileType: 'regular',
      mode: 0o100755,
      sizeBytes: worktreeContent.byteLength,
      contentDigest: sourceContentDigest(worktreeContent),
      exclusionReason: null,
    },
  }];
  const untrackedCore = {
    canonicalRelativePath: 'src/z.ts',
    mode: 0o100644,
    sizeBytes: untrackedContent.byteLength,
    contentDigest: sourceContentDigest(untrackedContent),
  };
  const snapshotCore = {
    schemaVersion: 1 as const,
    snapshotPolicyVersion: 'source-snapshot/1',
    snapshotLimits: SOURCE_SNAPSHOT_LIMITS,
    snapshotPolicyDigest: digestSourceSnapshotPolicy(SOURCE_SNAPSHOT_LIMITS),
    sourceWorkspaceIdentity: DIGEST_A,
    repositoryIdentity: DIGEST_C,
    repositoryRelativeCwd: '.',
    baseCommit: 'd'.repeat(40),
    branchName: 'main',
    headTreeDigest: canonicalDigest('wukong/test/head-tree/v1', 'tree'),
    indexDigest: canonicalDigest('wukong/test/index/v1', 'index'),
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
  const snapshot: SourceSnapshotV1 = {
    ...snapshotCore,
    snapshotDigest: canonicalDigest('wukong/source-snapshot/v1', snapshotCore),
  };
  const built = buildSnapshotMaterializationContainer({
    sourceSnapshotDigest: snapshot.snapshotDigest,
    snapshotPolicyDigest: snapshot.snapshotPolicyDigest,
    materializationPolicyDigest: DIGEST_C,
    entries: [
      {
        canonicalRelativePath: 'src/a.ts',
        selectedUntracked: false,
        indexObjectId,
        indexImage: { mode: 0o100644, content: indexContent },
        worktreeImage: { mode: 0o100755, content: worktreeContent },
      },
      {
        canonicalRelativePath: 'src/z.ts',
        selectedUntracked: true,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: { mode: 0o100644, content: untrackedContent },
      },
    ],
  });
  const parsed = parseSnapshotMaterializationContainer(built.containerBytes);
  const lease = createSnapshotBlobLease({
    blobLeaseId: '4e5303e7-aafb-4a5e-99dc-e227fe06a5b0',
    createdByRunId: 'run_creator',
    ownerRunId: 'run_owner',
    sourceSnapshotDigest: snapshot.snapshotDigest,
    snapshotPolicyDigest: snapshot.snapshotPolicyDigest,
    materializationPolicyDigest: parsed.manifest.materializationPolicyDigest,
    manifestDigest: parsed.manifest.manifestDigest,
    privateBlobPathIdentity: DIGEST_A,
    contentDigest: digestSnapshotMaterializationContainer(built.containerBytes),
    payloadSizeBytes: built.containerBytes.byteLength,
    entryCount: parsed.manifest.entryCount,
    createdAt: '2026-07-28T08:00:00.000Z',
    expiresAt: '2026-07-28T08:10:00.000Z',
    fencingTokenDigest: DIGEST_B,
  }).lease;
  return { built, lease, parsed, snapshot };
}

function rewriteManifest(
  containerBytes: Uint8Array,
  rewrite: (manifest: Record<string, unknown>) => void,
  encoding: 'canonical' | 'spaced' = 'canonical',
): Uint8Array {
  const bytes = Buffer.from(containerBytes);
  const manifestLength = bytes.readUInt32BE(12);
  const manifest = JSON.parse(
    bytes.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength).toString('utf8'),
  ) as Record<string, unknown>;
  rewrite(manifest);
  const json = encoding === 'canonical'
    ? canonicalJson(manifest)
    : ` ${canonicalJson(manifest)}`;
  const manifestBytes = Buffer.from(json);
  const payload = bytes.subarray(HEADER_BYTES + manifestLength);
  const header = Buffer.from(bytes.subarray(0, HEADER_BYTES));
  header.writeUInt32BE(manifestBytes.length, 12);
  return Uint8Array.from(Buffer.concat([header, manifestBytes, payload]));
}

describe('snapshot materialization container', () => {
  it('builds a deterministic uncompressed framed container with canonical path order', () => {
    const first = buildFixture();
    const second = buildFixture();
    const parsed = parseSnapshotMaterializationContainer(first.containerBytes);

    expect(first.containerBytes).toEqual(second.containerBytes);
    expect(Buffer.from(first.containerBytes).subarray(0, 8).toString('ascii'))
      .toBe('WKSMAT01');
    expect(parsed.manifest.entries.map((entry) => entry.canonicalRelativePath))
      .toEqual(['src/a.ts', 'src/z.ts']);
    expect(parsed.manifest).toMatchObject({
      schemaVersion: 1,
      formatVersion: 1,
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entryCount: 2,
      payloadSizeBytes: Buffer.byteLength('staged\nunstaged\nuntracked\n'),
    });
    expect(parsed.manifest.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(validateSnapshotMaterializationContainer(first.containerBytes)).toBe(true);
    expect(validateSnapshotMaterializationManifest(
      parsed.manifest,
      parsed.payloadBytes,
    )).toBe(true);
  });

  it('binds the container and lease to the exact approved source projection', () => {
    const { built, lease, parsed, snapshot } = buildSourceBoundFixture();

    expect(validateSnapshotMaterializationSourceBinding(
      snapshot,
      parsed.manifest,
      parsed.payloadBytes,
    )).toBe(true);
    expect(validateSnapshotBlobLeaseContainerBinding(lease, built.containerBytes)).toBe(true);
    expect(validateSnapshotBlobLeaseSourceBinding(
      lease,
      built.containerBytes,
      snapshot,
    )).toBe(true);

    const arbitraryDelete = buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: snapshot.snapshotDigest,
      snapshotPolicyDigest: snapshot.snapshotPolicyDigest,
      materializationPolicyDigest: DIGEST_C,
      entries: [{
        canonicalRelativePath: 'arbitrary-delete.ts',
        selectedUntracked: false,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: null,
      }],
    });
    const arbitraryParsed = parseSnapshotMaterializationContainer(
      arbitraryDelete.containerBytes,
    );
    expect(validateSnapshotMaterializationSourceBinding(
      snapshot,
      arbitraryParsed.manifest,
      arbitraryParsed.payloadBytes,
    )).toBe(false);

    const mismatchedLease = createSnapshotBlobLease({
      blobLeaseId: '35305368-b1c5-4ee1-82a8-88d05933aca9',
      createdByRunId: 'run_creator',
      ownerRunId: 'run_owner',
      sourceSnapshotDigest: snapshot.snapshotDigest,
      snapshotPolicyDigest: snapshot.snapshotPolicyDigest,
      materializationPolicyDigest: DIGEST_C,
      manifestDigest: DIGEST_A,
      privateBlobPathIdentity: DIGEST_A,
      contentDigest: digestSnapshotMaterializationContainer(built.containerBytes),
      payloadSizeBytes: built.containerBytes.byteLength,
      entryCount: parsed.manifest.entryCount,
      createdAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-28T08:10:00.000Z',
      fencingTokenDigest: DIGEST_B,
    }).lease;
    expect(validateSnapshotBlobLeaseContainerBinding(
      mismatchedLease,
      built.containerBytes,
    )).toBe(false);
  });

  it('freezes index and worktree postimages independently, including deletion states', () => {
    const stagedAdd = Buffer.from('staged add');
    const built = buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [
        {
          canonicalRelativePath: 'deleted-after-stage.ts',
          selectedUntracked: false,
          indexObjectId: gitBlobObjectId(stagedAdd),
          indexImage: {
            mode: 0o100644,
            content: stagedAdd,
          },
          worktreeImage: null,
        },
        {
          canonicalRelativePath: 'fully-deleted.ts',
          selectedUntracked: false,
          indexObjectId: null,
          indexImage: null,
          worktreeImage: null,
        },
        {
          canonicalRelativePath: 'recreated.ts',
          selectedUntracked: false,
          indexObjectId: null,
          indexImage: null,
          worktreeImage: {
            mode: 0o100755,
            content: Buffer.from('recreated'),
          },
        },
      ],
    });
    const { manifest } = parseSnapshotMaterializationContainer(built.containerBytes);

    expect(manifest.entries[0]).toMatchObject({
      canonicalRelativePath: 'deleted-after-stage.ts',
      selectedUntracked: false,
      indexImage: { mode: 0o100644, offsetBytes: 0, sizeBytes: 10 },
      worktreeImage: null,
    });
    expect(manifest.entries[1]).toMatchObject({
      canonicalRelativePath: 'fully-deleted.ts',
      selectedUntracked: false,
      indexImage: null,
      worktreeImage: null,
    });
    expect(manifest.entries[2]).toMatchObject({
      canonicalRelativePath: 'recreated.ts',
      selectedUntracked: false,
      indexImage: null,
      worktreeImage: { mode: 0o100755, offsetBytes: 10, sizeBytes: 9 },
    });
  });

  it.each([
    '',
    '/absolute.ts',
    '//server/share.ts',
    'C:/windows.ts',
    '../escape.ts',
    'src/../escape.ts',
    './relative.ts',
    'src//empty.ts',
    'src/trailing/',
    String.raw`src\windows.ts`,
    `src/control\u0000.ts`,
    'src/e\u0301.ts',
    'src/file:stream.ts',
    'src/trailing.',
    'src/trailing ',
    '.git/config',
    'CON',
    `src/${'x'.repeat(256)}`,
  ])('rejects non-canonical materialization path %j', (canonicalRelativePath) => {
    expect(() => buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [{
        canonicalRelativePath,
        selectedUntracked: false,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: { mode: 0o100644, content: Buffer.from('x') },
      }],
    })).toThrow();
  });

  it.each([
    ['src/A.ts', 'src/a.ts'],
    ['src/É.ts', 'src/é.ts'],
    ['same.ts', 'same.ts'],
  ])('rejects portable path collisions between %s and %s', (left, right) => {
    expect(() => buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [left, right].map((canonicalRelativePath) => ({
        canonicalRelativePath,
        selectedUntracked: false,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: { mode: 0o100644 as const, content: Buffer.from('x') },
      })),
    })).toThrow(/collide portably/u);
  });

  it('rejects unsupported modes and invalid selected-untracked images', () => {
    expect(() => buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [{
        canonicalRelativePath: 'link.ts',
        selectedUntracked: false,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: {
          mode: 0o120000 as 0o100644,
          content: Buffer.from('target'),
        },
      }],
    })).toThrow(/mode/u);
    expect(() => buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [{
        canonicalRelativePath: 'empty.ts',
        selectedUntracked: true,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: null,
      }],
    })).toThrow(/only have a worktree image/u);
    const mustNotEnterIndex = Buffer.from('must not enter index');
    expect(() => buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [{
        canonicalRelativePath: 'untracked.ts',
        selectedUntracked: true,
        indexObjectId: gitBlobObjectId(mustNotEnterIndex),
        indexImage: {
          mode: 0o100644,
          content: mustNotEnterIndex,
        },
        worktreeImage: {
          mode: 0o100644,
          content: Buffer.from('worktree'),
        },
      }],
    })).toThrow(/only have a worktree image/u);
  });

  it('rejects truncated, appended, payload-tampered, and header-tampered bytes', () => {
    const { containerBytes } = buildFixture();
    const truncated = containerBytes.slice(0, -1);
    const appended = Uint8Array.from([...containerBytes, 0]);
    const payloadTampered = Uint8Array.from(containerBytes);
    payloadTampered.set(
      [payloadTampered.at(-1)! ^ 1],
      payloadTampered.length - 1,
    );
    const headerTampered = Uint8Array.from(containerBytes);
    headerTampered[0]! ^= 1;

    for (const bytes of [truncated, appended, payloadTampered, headerTampered]) {
      expect(validateSnapshotMaterializationContainer(bytes)).toBe(false);
      expect(() => parseSnapshotMaterializationContainer(bytes)).toThrow();
    }
  });

  it('rejects non-canonical JSON even when its semantic manifest is unchanged', () => {
    const { containerBytes } = buildFixture();
    const noncanonical = rewriteManifest(containerBytes, () => {}, 'spaced');

    expect(() => parseSnapshotMaterializationContainer(noncanonical))
      .toThrow(/not canonical/u);
  });

  it('rejects non-canonical manifest entry sorting', () => {
    const { manifest, payloadBytes } = parseSnapshotMaterializationContainer(
      buildFixture().containerBytes,
    );
    const reversed = {
      ...manifest,
      entries: manifest.entries.toReversed(),
    };

    expect(validateSnapshotMaterializationManifest(reversed, payloadBytes)).toBe(false);
  });

  it.each([
    ['negative size', (manifest: SnapshotMaterializationManifestV1) => {
      const image = manifest.entries[0]?.indexImage;
      if (image !== null && image !== undefined) {
        (image as { sizeBytes: number }).sizeBytes = -1;
      }
    }],
    ['negative offset', (manifest: SnapshotMaterializationManifestV1) => {
      const image = manifest.entries[0]?.indexImage;
      if (image !== null && image !== undefined) {
        (image as { offsetBytes: number }).offsetBytes = -1;
      }
    }],
    ['overlap', (manifest: SnapshotMaterializationManifestV1) => {
      const image = manifest.entries[0]?.worktreeImage;
      if (image !== null && image !== undefined) {
        (image as { offsetBytes: number }).offsetBytes = 0;
      }
    }],
    ['out of bounds', (manifest: SnapshotMaterializationManifestV1) => {
      const image = manifest.entries[0]?.indexImage;
      if (image !== null && image !== undefined) {
        (image as { sizeBytes: number }).sizeBytes = manifest.payloadSizeBytes + 1;
      }
    }],
  ])('rejects an invalid image range: %s', (_label, mutate) => {
    const { manifest, payloadBytes } = parseSnapshotMaterializationContainer(
      buildFixture().containerBytes,
    );
    const mutable = structuredClone(manifest);
    mutate(mutable);

    expect(validateSnapshotMaterializationManifest(mutable, payloadBytes)).toBe(false);
  });

  it('rejects manifest field, entry, image, and payload digest tampering', () => {
    const { manifest, payloadBytes } = parseSnapshotMaterializationContainer(
      buildFixture().containerBytes,
    );
    const mutations: SnapshotMaterializationManifestV1[] = [
      { ...manifest, sourceSnapshotDigest: DIGEST_B },
      {
        ...manifest,
        entries: manifest.entries.map((entry, index) => index === 0
          ? { ...entry, entryDigest: DIGEST_A }
          : entry),
      },
      {
        ...manifest,
        entries: manifest.entries.map((entry, index) => index === 0
          ? {
              ...entry,
              indexImage: entry.indexImage === null
                ? null
                : { ...entry.indexImage, imageDigest: DIGEST_A },
            }
          : entry),
      },
    ];
    const tamperedPayload = Uint8Array.from(payloadBytes);
    tamperedPayload[0]! ^= 1;

    for (const mutation of mutations) {
      expect(validateSnapshotMaterializationManifest(mutation, payloadBytes)).toBe(false);
    }
    expect(validateSnapshotMaterializationManifest(manifest, tamperedPayload)).toBe(false);
  });

  it('rejects declared manifest and payload sizes above the fixed limits', () => {
    const { containerBytes } = buildFixture();
    const oversizedManifestHeader = Uint8Array.from(containerBytes);
    Buffer.from(
      oversizedManifestHeader.buffer,
      oversizedManifestHeader.byteOffset,
      oversizedManifestHeader.byteLength,
    ).writeUInt32BE(
      SNAPSHOT_MATERIALIZATION_LIMITS.maxManifestBytes + 1,
      12,
    );
    const oversizedPayloadHeader = Uint8Array.from(containerBytes);
    Buffer.from(
      oversizedPayloadHeader.buffer,
      oversizedPayloadHeader.byteOffset,
      oversizedPayloadHeader.byteLength,
    ).writeBigUInt64BE(
      BigInt(SNAPSHOT_MATERIALIZATION_LIMITS.maxPayloadBytes + 1),
      16,
    );

    expect(validateSnapshotMaterializationContainer(oversizedManifestHeader)).toBe(false);
    expect(validateSnapshotMaterializationContainer(oversizedPayloadHeader)).toBe(false);
  });

  it('rejects unknown manifest, entry, and image fields', () => {
    const parsed = parseSnapshotMaterializationContainer(buildFixture().containerBytes);
    const manifestExtra = { ...parsed.manifest, extra: true };
    const entryExtra = {
      ...parsed.manifest,
      entries: parsed.manifest.entries.map((entry, index) => index === 0
        ? { ...entry, extra: true }
        : entry),
    };
    const imageExtra = {
      ...parsed.manifest,
      entries: parsed.manifest.entries.map((entry, index) => index === 0
        ? {
            ...entry,
            indexImage: entry.indexImage === null
              ? null
              : { ...entry.indexImage, extra: true },
          }
        : entry),
    };

    for (const manifest of [manifestExtra, entryExtra, imageExtra]) {
      expect(validateSnapshotMaterializationManifest(
        manifest,
        parsed.payloadBytes,
      )).toBe(false);
    }
  });

  it('rejects unknown top-level build input fields before digesting', () => {
    expect(() => buildSnapshotMaterializationContainer({
      sourceSnapshotDigest: DIGEST_A,
      snapshotPolicyDigest: DIGEST_B,
      materializationPolicyDigest: DIGEST_C,
      entries: [],
      privatePayloadPath: '/must/not/be/ignored',
    } as never)).toThrow(/invalid shape/u);
  });
});
