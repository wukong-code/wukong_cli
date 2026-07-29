import { execFile } from 'node:child_process';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTargetStateFingerprint,
  canonicalDigest,
  inspectSourceSnapshot,
  reconstructTargetStateFingerprintForRecovery,
} from '../src';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('buildTargetStateFingerprint', () => {
  it('binds the exact dirty target while excluding Wukong candidate refs', async () => {
    const repository = await repositoryFixture();
    await writeFile(join(repository, 'tracked.txt'), 'dirty\n');
    await writeFile(join(repository, 'selected.txt'), 'selected\n');
    const inspected = await inspectSourceSnapshot({
      cwd: repository,
      selectedUntrackedPaths: ['selected.txt'],
    });
    if (inspected.status !== 'ready'
      || inspected.proposedSnapshot === null) {
      throw new Error('Source snapshot fixture failed.');
    }
    const first = await buildTargetStateFingerprint({
      cwd: repository,
      expectedSourceSnapshot: inspected.proposedSnapshot,
      promotableContentDigest: digest('content'),
    });
    await git(repository, [
      'branch',
      'wukong/candidate/019f8cd0-0000-7abc-8def-0123456789ab',
    ]);
    const second = await buildTargetStateFingerprint({
      cwd: repository,
      expectedSourceSnapshot: inspected.proposedSnapshot,
      promotableContentDigest: digest('content'),
    });

    expect(second.fingerprintDigest).toBe(first.fingerprintDigest);
    expect(first.sourceSnapshotDigest)
      .toBe(inspected.proposedSnapshot.snapshotDigest);
  });

  it('rejects source drift and exposes protected-ref drift in the digest', async () => {
    const repository = await repositoryFixture();
    const inspected = await inspectSourceSnapshot({ cwd: repository });
    if (inspected.status !== 'ready'
      || inspected.proposedSnapshot === null) {
      throw new Error('Source snapshot fixture failed.');
    }
    const before = await buildTargetStateFingerprint({
      cwd: repository,
      expectedSourceSnapshot: inspected.proposedSnapshot,
      promotableContentDigest: digest('content'),
    });
    await writeFile(join(repository, 'tracked.txt'), 'changed\n');
    await expect(buildTargetStateFingerprint({
      cwd: repository,
      expectedSourceSnapshot: inspected.proposedSnapshot,
      promotableContentDigest: digest('content'),
    })).rejects.toThrow(/changed/u);

    await writeFile(join(repository, 'tracked.txt'), 'base\n');
    await git(repository, ['branch', 'external-change']);
    const after = await buildTargetStateFingerprint({
      cwd: repository,
      expectedSourceSnapshot: inspected.proposedSnapshot,
      promotableContentDigest: digest('content'),
    });
    expect(after.protectedRefsDigest).not.toBe(before.protectedRefsDigest);
    expect(after.fingerprintDigest).not.toBe(before.fingerprintDigest);
  });

  it('reconstructs the pre-Apply key after a journaled target write', async () => {
    const repository = await repositoryFixture();
    const inspected = await inspectSourceSnapshot({ cwd: repository });
    if (inspected.status !== 'ready'
      || inspected.proposedSnapshot === null) {
      throw new Error('Source snapshot fixture failed.');
    }
    const before = await buildTargetStateFingerprint({
      cwd: repository,
      expectedSourceSnapshot: inspected.proposedSnapshot,
      promotableContentDigest: digest('content'),
    });
    await writeFile(join(repository, 'tracked.txt'), 'partial-apply\n');

    const recovered =
      await reconstructTargetStateFingerprintForRecovery({
        cwd: repository,
        expectedSourceSnapshot: inspected.proposedSnapshot,
        promotableContentDigest: digest('content'),
      });

    expect(recovered).toEqual(before);
  });
});

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-target-fingerprint-'));
  roots.push(root);
  await git(root, ['init']);
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/target-state-fingerprint-builder/v1',
    label,
  );
}
