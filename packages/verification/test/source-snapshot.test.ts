import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  inspectSourceSnapshot,
  isSupportedGitVersion,
  SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION,
  sourceSnapshotMatches,
  validateSourceSnapshot,
} from '../src/source-snapshot';
import { inspectGit } from '../src/git';
import { gitAdd, gitCommit, makeTempDir, makeTempRepo, writeRepoFile } from './helpers';

const execFileAsync = promisify(execFile);

vi.setConfig({ testTimeout: 20_000 });
afterAll(() => {
  vi.resetConfig();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isolated Loop source snapshots', () => {
  it('enforces the explicit minimum Git version across vendor suffixes', () => {
    expect(SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION).toBe('2.29.0');
    expect(isSupportedGitVersion('git version 2.28.9')).toBe(false);
    expect(isSupportedGitVersion('git version 2.29.0')).toBe(true);
    expect(isSupportedGitVersion('git version 2.49.0.windows.1'))
      .toBe(true);
    expect(isSupportedGitVersion('git version 2.39.3 (Apple Git-146)'))
      .toBe(true);
    expect(isSupportedGitVersion('git version 3.0.0')).toBe(true);
    expect(isSupportedGitVersion('unexpected')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'returns a stable blocker before reading a repository with old Git',
    async () => {
      const cwd = await makeTempDir(
        'wukong-source-snapshot-old-git-workspace-',
      );
      const bin = await makeTempDir(
        'wukong-source-snapshot-old-git-bin-',
      );
      const fakeGit = join(bin, 'git');
      await writeFile(
        fakeGit,
        '#!/bin/sh\nprintf "git version 2.28.9\\n"\n',
      );
      await chmod(fakeGit, 0o755);
      vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);

      await expect(inspectSourceSnapshot({ cwd }))
        .resolves.toMatchObject({
          status: 'blocked',
          reasonCode: 'isolated_loop_git_unsupported',
          proposedSnapshot: null,
        });
    },
  );

  it('builds a stable read-only snapshot for a clean Git workspace', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-clean-');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');

    const first = await inspectSourceSnapshot({ cwd });
    const second = await inspectSourceSnapshot({ cwd });

    expect(first).toMatchObject({ status: 'ready', reasonCode: null });
    expect(first.proposedSnapshot).not.toBeNull();
    expect(first.policyDigest).toMatch(/^sha256:/u);
    expect(first.proposedSnapshot).toMatchObject({
      snapshotPolicyVersion: 'source-snapshot/1',
      snapshotPolicyDigest: first.policyDigest,
      repositoryRelativeCwd: '.',
    });
    expect(first.proposedSnapshot?.trackedDeltaDigest).toBeNull();
    expect(first.proposedSnapshot?.includedUntracked).toEqual([]);
    expect(first.proposedSnapshot && validateSourceSnapshot(first.proposedSnapshot)).toBe(true);
    expect(first.proposedSnapshot && second.proposedSnapshot
      && sourceSnapshotMatches(first.proposedSnapshot, second.proposedSnapshot)).toBe(true);
  });

  it('binds effective policy limits and the repository-relative working directory', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-relative-cwd-');
    await writeRepoFile(cwd, 'packages/app/index.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');

    const first = await inspectSourceSnapshot({
      cwd: join(cwd, 'packages/app'),
      limits: { maxUntrackedFileBytes: 32 },
    });
    const second = await inspectSourceSnapshot({
      cwd: join(cwd, 'packages/app'),
      limits: { maxUntrackedFileBytes: 64 },
    });

    expect(first).toMatchObject({
      status: 'ready',
      proposedSnapshot: {
        repositoryRelativeCwd: 'packages/app',
        snapshotLimits: {
          maxUntrackedFileBytes: 32,
        },
        snapshotPolicyDigest: first.policyDigest,
      },
    });
    expect(first.policyDigest).not.toBe(second.policyDigest);
    expect(first.proposedSnapshot?.snapshotDigest)
      .not.toBe(second.proposedSnapshot?.snapshotDigest);
    expect(first.proposedSnapshot && validateSourceSnapshot({
      ...first.proposedSnapshot,
      snapshotLimits: {
        ...first.proposedSnapshot.snapshotLimits,
        maxUntrackedFileBytes: 64,
      },
    })).toBe(false);
  });

  it('binds staged, unstaged, and explicitly selected untracked content', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-dirty-');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 2;\n');
    await gitAdd(cwd, 'src/index.ts');
    await writeRepoFile(cwd, 'src/index.ts', 'export const value = 3;\n');
    await writeRepoFile(cwd, 'src/new.ts', 'export const added = true;\n');
    const gitBefore = await inspectGit(cwd);

    const before = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['src/new.ts'],
    });
    const gitAfter = await inspectGit(cwd);
    await writeRepoFile(cwd, 'src/new.ts', 'export const added = false;\n');
    const after = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['src/new.ts'],
    });

    expect(before.status).toBe('ready');
    expect(before.proposedSnapshot?.trackedDeltaDigest).toMatch(/^sha256:/u);
    expect(before.proposedSnapshot?.includedUntracked).toMatchObject([{
      canonicalRelativePath: 'src/new.ts',
      mode: 0o100644,
    }]);
    expect(gitAfter).toMatchObject({
      statusText: gitBefore.statusText,
      diffText: gitBefore.diffText,
    });
    expect(after.proposedSnapshot?.snapshotDigest).not.toBe(
      before.proposedSnapshot?.snapshotDigest,
    );
  });

  it('discovers untracked files without silently including them', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-discovery-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'untracked.ts', 'export const value = 1;\n');

    const result = await inspectSourceSnapshot({ cwd });

    expect(result.untrackedCandidateCount).toBe(1);
    expect(result.untrackedCandidates).toMatchObject([{
      pathProjection: 'untracked.ts',
      selected: false,
      eligibility: 'eligible',
    }]);
    expect(result.proposedSnapshot?.includedUntracked).toEqual([]);
  });

  it('excludes secrets and blocks when the frozen Gate requires one', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-secret-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, '.env', 'API_KEY=sk-example123456789\n');

    const result = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['.env'],
      requiredGatePaths: ['.env'],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'snapshot_dependency_excluded',
    });
    expect(result.proposedSnapshot?.includedUntracked).toEqual([]);
    expect(result.proposedSnapshot?.exclusions).toMatchObject([{
      pathProjection: '.env',
      reason: 'secret_or_credential',
      requiredByFrozenGate: true,
    }]);
  });

  it('blocks instead of silently dropping an explicitly selected exclusion', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-selected-exclusion-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, '.env', 'API_KEY=sk-example123456789\n');

    const result = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['.env'],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'snapshot_selection_excluded',
      proposedSnapshot: {
        includedUntracked: [],
      },
    });
  });

  it('excludes clean tracked secrets, symlinks, and gitlinks from the source contract', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-clean-exclusions-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await writeRepoFile(cwd, '.env', 'API_KEY=sk-example123456789\n');
    await symlink('tracked.ts', join(cwd, 'linked.ts'));
    await gitAdd(cwd);
    await gitCommit(cwd, 'tracked exclusions');
    const { stdout: baseCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    await execFileAsync(
      'git',
      ['update-index', '--add', '--cacheinfo', `160000,${baseCommit.trim()},third-party/sub`],
      { cwd },
    );
    await gitCommit(cwd, 'gitlink exclusion');

    const result = await inspectSourceSnapshot({
      cwd,
      requiredGatePaths: ['.env', 'linked.ts', 'third-party/sub'],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
    });
    expect(result.proposedSnapshot?.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathProjection: '.env',
        reason: 'secret_or_credential',
        requiredByFrozenGate: true,
      }),
      expect.objectContaining({
        pathProjection: 'linked.ts',
        reason: 'symlink',
        requiredByFrozenGate: true,
      }),
      expect.objectContaining({
        pathProjection: 'third-party/sub',
        reason: 'unsupported_file_type',
        requiredByFrozenGate: true,
      }),
    ]));
  });

  it('excludes Python virtual environments even when explicitly selected', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-venv-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, '.venv/pyvenv.cfg', 'home = /usr/bin\n');

    const result = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['.venv/pyvenv.cfg'],
      requiredGatePaths: ['.venv/pyvenv.cfg'],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'snapshot_dependency_excluded',
    });
    expect(result.proposedSnapshot?.includedUntracked).toEqual([]);
    expect(result.proposedSnapshot?.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathProjection: '.venv/pyvenv.cfg',
        reason: 'ignored_or_generated',
      }),
    ]));
  });

  it('ignores inherited Git repository overrides', async () => {
    const expectedRepo = await makeTempRepo('wukong-source-snapshot-git-env-a-');
    const injectedRepo = await makeTempRepo('wukong-source-snapshot-git-env-b-');
    await writeRepoFile(expectedRepo, 'expected.ts', 'export const source = "expected";\n');
    await gitAdd(expectedRepo);
    await gitCommit(expectedRepo, 'expected');
    await writeRepoFile(injectedRepo, 'injected.ts', 'export const source = "injected";\n');
    await gitAdd(injectedRepo);
    await gitCommit(injectedRepo, 'injected');
    const { stdout: expectedHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: expectedRepo,
    });
    const { stdout: injectedHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: injectedRepo,
    });
    const previousGitDir = process.env['GIT_DIR'];
    const previousGitWorkTree = process.env['GIT_WORK_TREE'];

    try {
      process.env['GIT_DIR'] = join(injectedRepo, '.git');
      process.env['GIT_WORK_TREE'] = injectedRepo;
      const result = await inspectSourceSnapshot({ cwd: expectedRepo });

      expect(result).toMatchObject({ status: 'ready', reasonCode: null });
      expect(result.proposedSnapshot?.baseCommit).toBe(expectedHead.trim());
      expect(result.proposedSnapshot?.baseCommit).not.toBe(injectedHead.trim());
    } finally {
      if (previousGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previousGitDir;
      if (previousGitWorkTree === undefined) delete process.env['GIT_WORK_TREE'];
      else process.env['GIT_WORK_TREE'] = previousGitWorkTree;
    }
  });

  it('fails closed when tracked files use skip-worktree flags', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-skip-worktree-');
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await execFileAsync('git', ['update-index', '--skip-worktree', 'tracked.ts'], { cwd });
    await writeRepoFile(cwd, 'tracked.ts', 'export const value = 2;\n');

    const result = await inspectSourceSnapshot({ cwd });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
    });
    expect(result.proposedSnapshot?.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathProjection: 'tracked.ts',
        reason: 'policy_denied',
      }),
    ]));
  });

  it('fails closed for portable case-insensitive path collisions', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-case-collision-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'collision.txt', 'collision\n');
    const { stdout: objectId } = await execFileAsync(
      'git',
      ['hash-object', '-w', 'collision.txt'],
      { cwd },
    );
    await rm(join(cwd, 'collision.txt'));
    await execFileAsync(
      'git',
      ['update-index', '--add', '--cacheinfo', `100644,${objectId.trim()},Foo.ts`],
      { cwd },
    );
    await execFileAsync(
      'git',
      ['update-index', '--add', '--cacheinfo', `100644,${objectId.trim()},foo.ts`],
      { cwd },
    );

    const result = await inspectSourceSnapshot({ cwd });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
      proposedSnapshot: null,
    });
  });

  it('does not execute a repository-configured fsmonitor hook', async () => {
    if (process.platform === 'win32') return;
    const cwd = await makeTempRepo('wukong-source-snapshot-fsmonitor-');
    const hookDir = await makeTempDir('wukong-source-snapshot-fsmonitor-hook-');
    const hookPath = join(hookDir, 'fsmonitor.sh');
    const markerPath = `${hookPath}.called`;
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(hookDir, 'fsmonitor.sh', '#!/bin/sh\n: > "$0.called"\nexit 0\n');
    await chmod(hookPath, 0o755);
    await execFileAsync('git', ['config', 'core.fsmonitor', hookPath], { cwd });

    const result = await inspectSourceSnapshot({ cwd });

    expect(result).toMatchObject({ status: 'ready', reasonCode: null });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed without executing repository-configured content filters', async () => {
    if (process.platform === 'win32') return;
    const cwd = await makeTempRepo('wukong-source-snapshot-content-filter-');
    const hookDir = await makeTempDir('wukong-source-snapshot-filter-hook-');
    const hookPath = join(hookDir, 'filter.sh');
    const markerPath = `${hookPath}.called`;
    await writeRepoFile(cwd, '.gitattributes', '*.txt filter=evil\n');
    await writeRepoFile(cwd, 'tracked.txt', 'base\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(hookDir, 'filter.sh', '#!/bin/sh\n: > "$0.called"\ncat\n');
    await chmod(hookPath, 0o755);
    await execFileAsync('git', ['config', 'filter.evil.clean', hookPath], { cwd });
    await writeRepoFile(cwd, 'tracked.txt', 'changed\n');

    const result = await inspectSourceSnapshot({ cwd });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
      proposedSnapshot: null,
    });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not follow an ancestor symlink outside the source workspace', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-ancestor-symlink-');
    const outside = await makeTempDir('wukong-source-snapshot-outside-');
    await writeRepoFile(cwd, 'dir/tracked.ts', 'export const value = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await rm(join(cwd, 'dir'), { recursive: true });
    await writeRepoFile(outside, 'tracked.ts', 'export const leaked = "outside";\n');
    await symlink(outside, join(cwd, 'dir'), 'dir');

    const result = await inspectSourceSnapshot({
      cwd,
      requiredGatePaths: ['dir/tracked.ts'],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
    });
    expect(result.proposedSnapshot?.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathProjection: 'dir/tracked.ts',
        reason: 'policy_denied',
        requiredByFrozenGate: true,
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it('excludes oversized and secret-bearing tracked modifications', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-tracked-policy-');
    await writeRepoFile(cwd, 'large.txt', 'small\n');
    await writeRepoFile(cwd, 'config.txt', 'public=true\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'large.txt', 'x'.repeat(128));
    await writeRepoFile(cwd, 'config.txt', 'api_key=secret-value-123456\n');

    const result = await inspectSourceSnapshot({
      cwd,
      requiredGatePaths: ['large.txt', 'config.txt'],
      limits: { maxTrackedFileBytes: 64 },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
    });
    expect(result.proposedSnapshot?.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathProjection: 'large.txt', reason: 'oversize' }),
      expect.objectContaining({
        pathProjection: 'config.txt',
        reason: 'secret_or_credential',
      }),
    ]));
  });

  it('fails closed for POSIX paths that cannot be materialized portably', async () => {
    if (process.platform === 'win32') return;
    const cwd = await makeTempRepo('wukong-source-snapshot-backslash-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'a\\b.ts', 'export const value = "backslash";\n');
    await writeRepoFile(cwd, 'a/b.ts', 'export const value = "slash";\n');

    const result = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['a\\b.ts', 'a/b.ts'],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
      proposedSnapshot: null,
    });
  });

  it('blocks staged secret bytes even when the worktree copy was deleted', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-index-secret-');
    await writeRepoFile(cwd, 'config.txt', 'public=true\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'config.txt', 'api_key=secret-value-123456\n');
    await gitAdd(cwd, 'config.txt');
    await rm(join(cwd, 'config.txt'));

    const result = await inspectSourceSnapshot({ cwd });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'source_snapshot_untrusted',
    });
    expect(result.proposedSnapshot?.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathProjection: 'config.txt',
        reason: 'secret_or_credential',
      }),
    ]));
  });

  it('fails closed for symlinks, oversized files, and paths outside the workspace', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-policy-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'large.txt', 'x'.repeat(64));
    await writeRepoFile(cwd, 'target.txt', 'safe\n');
    await symlink('target.txt', `${cwd}/linked.txt`);

    const result = await inspectSourceSnapshot({
      cwd,
      selectedUntrackedPaths: ['large.txt', 'linked.txt', '../outside.txt'],
      requiredGatePaths: ['large.txt', 'linked.txt', '../outside.txt'],
      limits: { maxUntrackedFileBytes: 16 },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'snapshot_dependency_excluded',
    });
    expect(result.proposedSnapshot?.exclusions.map((entry) => entry.reason).toSorted())
      .toEqual(['oversize', 'policy_denied', 'symlink']);
    expect(result.untrackedCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathProjection: 'large.txt',
        eligibility: 'excluded',
        exclusionReason: 'oversize',
      }),
      expect.objectContaining({
        pathProjection: 'linked.txt',
        eligibility: 'excluded',
        exclusionReason: 'symlink',
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain('/outside.txt');
  });

  it('records executable mode and rejects a tampered snapshot', async () => {
    const cwd = await makeTempRepo('wukong-source-snapshot-mode-');
    await writeRepoFile(cwd, 'tracked.ts', 'export {};\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await writeRepoFile(cwd, 'script.sh', '#!/bin/sh\nexit 0\n');
    await chmod(`${cwd}/script.sh`, 0o755);

    const result = await inspectSourceSnapshot({ cwd, selectedUntrackedPaths: ['script.sh'] });
    const snapshot = result.proposedSnapshot;

    expect(snapshot?.includedUntracked[0]?.mode)
      .toBe(process.platform === 'win32' ? 0o100644 : 0o100755);
    expect(snapshot && validateSourceSnapshot(snapshot)).toBe(true);
    if (snapshot === null) return;
    expect(validateSourceSnapshot({ ...snapshot, branchName: 'tampered' })).toBe(false);
  });

  it('returns a stable non-Git blocker without producing a snapshot', async () => {
    const cwd = await makeTempDir('wukong-source-snapshot-non-git-');

    const result = await inspectSourceSnapshot({ cwd });

    expect(result).toMatchObject({
      status: 'blocked',
      reasonCode: 'isolated_loop_not_git',
      proposedSnapshot: null,
    });
  });
});
