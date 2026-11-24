import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  createWorkspaceSnapshot,
  inspectGit,
  resolveWorkspaceIdentity,
  type GateRunRecord,
} from '@wukong/verification';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { listGateRuns, readGateRun, saveGateRun } from '#/cli/lib/gate-run-store';
import type { LoopRunRecord } from '#/cli/lib/loop-run-store';
import { handleSummary, registerSummaryCommand, type SummaryDeps } from '#/cli/sub/summary';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writable() {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function makeDeps(options: {
  cwd: string;
  homeDir: string;
  stdout?: ReturnType<typeof writable>;
  stderr?: ReturnType<typeof writable>;
  loopRuns?: readonly LoopRunRecord[];
  currentHeadSha?: string;
  currentDirty?: boolean;
}): SummaryDeps {
  return {
    cwd: () => options.cwd,
    homeDir: () => options.homeDir,
    stdout: (options.stdout ?? writable()).writer,
    stderr: (options.stderr ?? writable()).writer,
    resolveWorkspaceIdentity,
    inspectGit: async (dir = options.cwd) => {
      if (options.currentDirty !== undefined) {
        return {
          cwd: dir,
          isRepo: true,
          root: dir,
          statusText: options.currentDirty ? ' M src/a.ts' : '',
          diffText: '',
          diffStat: '',
          changedFiles: options.currentDirty ? [{ path: 'src/a.ts', status: 'M' }] : [],
        };
      }
      return inspectGit(dir);
    },
    createSnapshot: async (input) => {
      if (options.currentHeadSha !== undefined) {
        return {
          id: 'snap',
          cwd: options.cwd,
          headSha: options.currentHeadSha,
          inputDigest: 'in',
          configDigest: 'cfg',
          planDigest: 'plan',
          git: {
            cwd: options.cwd,
            isRepo: true,
            statusText: '',
            diffText: '',
            diffStat: '',
            changedFiles: [],
          },
        };
      }
      return createWorkspaceSnapshot(input);
    },
    readGateRun,
    listGateRuns,
    listLoopRuns: async () => options.loopRuns ?? [],
  };
}

describe('handleSummary', () => {
  it('reads latest gate run for the workspace and previews a sanitized proof card', async () => {
    const cwd = await makeTempDir('wukong-summary-cwd-');
    const homeDir = await makeTempDir('wukong-summary-home-');
    const identity = await resolveWorkspaceIdentity(cwd);

    const older: GateRunRecord = {
      schemaVersion: 1,
      runId: 'gate-old',
      source: 'gate',
      generatedAt: '2026-11-24T01:00:00.000Z',
      workspaceIdentityDigest: identity.workspaceIdentityDigest,
      workspaceName: 'app',
      git: { isRepo: true, headSha: '111111111111', dirty: false, changedFileCount: 0 },
      snapshotId: 'snap-old',
      status: 'NEEDS_WORK',
      reasonCode: 'review_needs_work',
      summary: 'Old failure',
      checks: [],
      risks: [],
      reviewer: { status: 'needs_work', model: 'default', providerId: 'openai', summary: 'Old' },
      findings: [],
      uncoveredItems: [],
      nextSteps: ['Fix it'],
      reviewPolicyLoaded: true,
    };
    const latest: GateRunRecord = {
      ...older,
      runId: 'gate-new',
      generatedAt: '2026-11-24T02:00:00.000Z',
      objective: `Ship fix at ${homeDir}/secret-token=sk-secret-test-value`,
      status: 'PASS',
      reasonCode: 'passed',
      summary: 'All checks passed.',
      checks: [{ command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 20 }],
      reviewer: { status: 'passed', model: 'default', providerId: 'openai', summary: 'Ready.' },
      uncoveredItems: ['Manual deploy verification not run'],
      nextSteps: ['Merge PR'],
    };
    await saveGateRun(older, homeDir);
    await saveGateRun(latest, homeDir);

    const stdout = writable();
    const stderr = writable();
    const code = await handleSummary(
      makeDeps({ cwd, homeDir, stdout, stderr, currentHeadSha: '111111111111', currentDirty: false }),
      {},
    );

    expect(code).toBe(0);
    expect(stderr.chunks).toEqual([]);
    const out = stdout.chunks.join('');
    expect(out).toContain('## Wukong Delivery Proof Card');
    expect(out).toContain('`gate-new`');
    expect(out).toContain('`PASS`');
    expect(out).toContain('Manual deploy verification not run');
    expect(out).not.toContain('sk-secret-test-value');
    expect(out).not.toContain(homeDir);
  });

  it('marks stale runs when HEAD moved or working tree dirtied after the run', async () => {
    const cwd = await makeTempDir('wukong-summary-stale-');
    const homeDir = await makeTempDir('wukong-summary-stale-home-');
    await execFileAsync('git', ['init'], { cwd });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd });
    await writeFile(join(cwd, 'a.txt'), 'v1\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd });
    const head1 = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

    const identity = await resolveWorkspaceIdentity(cwd);
    await saveGateRun(
      {
        schemaVersion: 1,
        runId: 'gate-head1',
        source: 'gate',
        generatedAt: '2026-11-24T03:00:00.000Z',
        workspaceIdentityDigest: identity.workspaceIdentityDigest,
        workspaceName: 'repo',
        git: { isRepo: true, headSha: head1, dirty: false, changedFileCount: 0 },
        snapshotId: 'snap-1',
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Clean HEAD pass',
        checks: [{ command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 15 }],
        risks: [],
        reviewer: { status: 'passed', model: 'default', providerId: 'openai', summary: 'Clean' },
        findings: [],
        uncoveredItems: [],
        nextSteps: ['Merge'],
        reviewPolicyLoaded: true,
      },
      homeDir,
    );

    await writeFile(join(cwd, 'a.txt'), 'v2\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd });
    await execFileAsync('git', ['commit', '-m', 'second'], { cwd });

    const stdout = writable();
    const code = await handleSummary(makeDeps({ cwd, homeDir, stdout }), { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.chunks.join('')) as { stale: boolean; markdown: string };
    expect(parsed.stale).toBe(true);
    expect(parsed.markdown).toContain('**STALE**');
  });

  it('falls back honestly to a loop run when no gate run exists without fabricating checks', async () => {
    const cwd = await makeTempDir('wukong-summary-loop-');
    const homeDir = await makeTempDir('wukong-summary-loop-home-');
    const stdout = writable();

    const loopRuns: LoopRunRecord[] = [
      {
        version: 2,
        runId: 'loop-123',
        goalId: 'goal-123',
        workspace: cwd,
        state: 'terminal',
        startedAt: '2026-11-24T04:00:00.000Z',
        terminal: {
          status: 'cancelled',
          iterations: 2,
          finishedAt: '2026-11-24T04:10:00.000Z',
        },
      },
    ];

    const code = await handleSummary(makeDeps({ cwd, homeDir, stdout, loopRuns }), {});
    expect(code).toBe(0);
    const out = stdout.chunks.join('');
    expect(out).toContain('`loop-123`');
    expect(out).toContain('`NEEDS_WORK`');
    expect(out).toContain('No per-check execution records captured.');
    expect(out).toContain('not stored in the lightweight Loop lifecycle index');
  });

  it('saves via --out, prevents accidental overwrite without --force, and rejects missing/traversal runIds', async () => {
    const cwd = await makeTempDir('wukong-summary-out-');
    const homeDir = await makeTempDir('wukong-summary-out-home-');
    const identity = await resolveWorkspaceIdentity(cwd);
    await saveGateRun(
      {
        schemaVersion: 1,
        runId: 'gate-save-1',
        source: 'gate',
        generatedAt: '2026-11-24T05:00:00.000Z',
        workspaceIdentityDigest: identity.workspaceIdentityDigest,
        workspaceName: 'repo',
        git: { isRepo: false, dirty: false, changedFileCount: 0 },
        snapshotId: 'snap-save',
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Saved',
        checks: [{ command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 5 }],
        risks: [],
        reviewer: { status: 'passed', model: 'default', providerId: 'openai', summary: 'Ok' },
        findings: [],
        uncoveredItems: [],
        nextSteps: ['Done'],
        reviewPolicyLoaded: false,
      },
      homeDir,
    );

    const outPath = 'out/proof.md';
    expect(await handleSummary(makeDeps({ cwd, homeDir }), { runId: 'gate-save-1', out: outPath })).toBe(0);
    expect(await readFile(join(cwd, outPath), 'utf8')).toContain('`gate-save-1`');

    const overwriteErr = writable();
    expect(
      await handleSummary(makeDeps({ cwd, homeDir, stderr: overwriteErr }), { runId: 'gate-save-1', out: outPath }),
    ).toBe(1);
    expect(overwriteErr.chunks.join('')).toContain('Pass --force to overwrite');

    expect(
      await handleSummary(makeDeps({ cwd, homeDir }), { runId: 'gate-save-1', out: outPath, force: true }),
    ).toBe(0);

    const traversalErr = writable();
    expect(
      await handleSummary(makeDeps({ cwd, homeDir, stderr: traversalErr }), { runId: '../../etc/passwd' }),
    ).toBe(1);
    expect(traversalErr.chunks.join('')).toContain('not found');
  });

  it('registers wukong summary command', async () => {
    const cwd = await makeTempDir('wukong-summary-cmd-');
    const homeDir = await makeTempDir('wukong-summary-cmd-home-');
    const stderr = writable();
    const program = new Command();
    program.exitOverride();
    registerSummaryCommand(program, makeDeps({ cwd, homeDir, stderr }));
    process.exitCode = undefined;

    await program.parseAsync(['summary'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stderr.chunks.join('')).toContain('No gate or loop runs found');
    process.exitCode = undefined;
  });
});
