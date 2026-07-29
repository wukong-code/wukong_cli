import { execFile } from 'node:child_process';
import { link } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  parseSnapshotMaterializationContainer,
  SNAPSHOT_MATERIALIZATION_POLICY,
  SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  validateSnapshotMaterializationSourceBinding,
} from '../src/snapshot-materialization';
import {
  sealSourceSnapshot,
  SourceSnapshotSealError,
} from '../src/source-snapshot-sealer';
import { inspectSourceSnapshot, type SourceSnapshotV1 } from '../src/source-snapshot';
import {
  gitAdd,
  gitCommit,
  gitMove,
  makeTempRepo,
  writeRepoFile,
} from './helpers';

const execFileAsync = promisify(execFile);

async function readySnapshot(
  cwd: string,
  selectedUntrackedPaths: readonly string[] = [],
): Promise<SourceSnapshotV1> {
  const result = await inspectSourceSnapshot({ cwd, selectedUntrackedPaths });
  expect(result.status).toBe('ready');
  expect(result.proposedSnapshot).not.toBeNull();
  return result.proposedSnapshot!;
}

describe('source snapshot exact-byte sealer', () => {
  it('seals staged, unstaged, and selected untracked postimages', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-dirty-');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 2;\n');
    await gitAdd(cwd, 'src/index.ts');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 3;\n');
    await writeRepoFile(cwd, 'src/new.ts', 'export const added = true;\n');
    const snapshot = await readySnapshot(cwd, ['src/new.ts']);

    const sealed = await sealSourceSnapshot({ cwd, snapshot });
    const parsed = parseSnapshotMaterializationContainer(sealed.containerBytes);

    expect(sealed.materializationPolicyDigest)
      .toBe(SNAPSHOT_MATERIALIZATION_POLICY_DIGEST);
    expect(SNAPSHOT_MATERIALIZATION_POLICY).toMatchObject({
      excludedTrackedPolicy: 'deny',
      excludedUntrackedPolicy: 'deny',
      selectedUntrackedPolicy: 'materialize-approved',
    });
    expect(parsed.manifest.entries).toMatchObject([
      {
        canonicalRelativePath: 'src/index.ts',
        selectedUntracked: false,
        indexObjectId: expect.stringMatching(/^[a-f0-9]{40}$/u),
        indexImage: { mode: 0o100644 },
        worktreeImage: { mode: 0o100644 },
      },
      {
        canonicalRelativePath: 'src/new.ts',
        selectedUntracked: true,
        indexObjectId: null,
        indexImage: null,
        worktreeImage: { mode: 0o100644 },
      },
    ]);
    expect(validateSnapshotMaterializationSourceBinding(
      snapshot,
      parsed.manifest,
      parsed.payloadBytes,
    )).toBe(true);
  });

  it('seals a clean snapshot as an empty exact container', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-clean-');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    const snapshot = await readySnapshot(cwd);

    const sealed = await sealSourceSnapshot({ cwd, snapshot });

    expect(sealed.manifest).toMatchObject({
      entryCount: 0,
      payloadSizeBytes: 0,
      entries: [],
    });
  });

  it('represents a detected rename as an exact delete plus add', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-rename-');
    await writeRepoFile(cwd, 'src/old.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await gitMove(cwd, 'src/old.ts', 'src/new.ts');
    const snapshot = await readySnapshot(cwd);

    const sealed = await sealSourceSnapshot({ cwd, snapshot });

    expect(sealed.manifest.entries).toMatchObject([
      {
        canonicalRelativePath: 'src/new.ts',
        indexImage: { mode: 0o100644 },
        worktreeImage: { mode: 0o100644 },
      },
      {
        canonicalRelativePath: 'src/old.ts',
        indexObjectId: null,
        indexImage: null,
        worktreeImage: null,
      },
    ]);
  });

  it('keeps a staged delete plus recreated worktree path as one tracked entry', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-recreate-');
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await execFileAsync('git', ['rm', 'tracked.ts'], { cwd });
    await writeRepoFile(cwd, 'tracked.ts', 'export const replacement = true;\n');
    const inspected = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['tracked.ts'],
    });

    expect(inspected).toMatchObject({
      status: 'ready',
      proposedSnapshot: { includedUntracked: [] },
    });
    const sealed = await sealSourceSnapshot({
      cwd,
      snapshot: inspected.proposedSnapshot!,
    });
    expect(sealed.manifest.entries).toMatchObject([{
      canonicalRelativePath: 'tracked.ts',
      selectedUntracked: false,
      indexObjectId: null,
      indexImage: null,
      worktreeImage: { mode: 0o100644 },
    }]);
  });

  it('rejects clean tracked bytes that require Git worktree conversion', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-conversion-');
    await writeRepoFile(cwd, '.gitattributes', '* text eol=lf\n');
    await writeRepoFile(cwd, 'tracked.txt', 'first\nsecond\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'tracked.txt', 'first\r\nsecond\r\n');
    const snapshot = await readySnapshot(cwd);
    expect(snapshot.trackedDeltaDigest).toBeNull();

    await expect(sealSourceSnapshot({ cwd, snapshot })).rejects.toMatchObject({
      reasonCode: 'source_snapshot_seal_binding_failed',
    });
  });

  it('rejects Git LFS pointer materialization before a private lease is created', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-lfs-');
    await writeRepoFile(
      cwd,
      'asset.bin',
      [
        'version https://git-lfs.github.com/spec/v1',
        `oid sha256:${'a'.repeat(64)}`,
        'size 123',
        '',
      ].join('\n'),
    );
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    const snapshot = await readySnapshot(cwd);

    await expect(sealSourceSnapshot({ cwd, snapshot })).rejects.toMatchObject({
      reasonCode: 'source_snapshot_seal_unsafe_file',
    });
  });

  it('fails closed when the workspace drifts after approval', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-drift-');
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 2;\n');
    const snapshot = await readySnapshot(cwd);
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 3;\n');

    await expect(sealSourceSnapshot({ cwd, snapshot })).rejects.toMatchObject({
      reasonCode: 'source_snapshot_seal_drift',
    });
  });

  it('does not seal a blocked snapshot with exclusions', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-excluded-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, '.env', 'API_KEY=sk-example123456789\n');
    const inspected = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['.env'],
    });
    expect(inspected.proposedSnapshot).not.toBeNull();

    await expect(sealSourceSnapshot({
      cwd,
      snapshot: inspected.proposedSnapshot!,
    })).rejects.toBeInstanceOf(SourceSnapshotSealError);
  });

  it('rejects a hardlinked source postimage', async () => {
    const cwd = await makeTempRepo('wukong-source-sealer-hardlink-');
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 2;\n');
    await link(join(cwd, 'tracked.ts'), join(cwd, 'alias.ts'));
    const snapshot = await readySnapshot(cwd);

    await expect(sealSourceSnapshot({ cwd, snapshot })).rejects.toMatchObject({
      reasonCode: 'source_snapshot_seal_unsafe_file',
    });
  });
});
