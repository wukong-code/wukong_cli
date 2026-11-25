import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CliReviewerError,
  ErrorCodes,
  type WukongConfig,
} from '@wukong/wukong-sdk';
import {
  WorkspaceChangedError,
  resolveWorkspaceIdentity,
  type GitInspection,
  type ProofResult,
} from '@wukong/verification';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readGateRun, saveGateRun } from '#/cli/lib/gate-run-store';
import {
  createDefaultGateReviewerExecutor,
  handleGate,
  registerGateCommand,
  type GateDeps,
} from '#/cli/sub/gate';

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

function makeProof(cwd: string, overrides: Partial<ProofResult> = {}): ProofResult {
  return {
    status: 'passed',
    cwd,
    generatedAt: '2026-11-24T00:00:00.000Z',
    verification: {
      status: 'passed',
      cwd,
      generatedAt: '2026-11-24T00:00:00.000Z',
      changedFiles: [{ path: 'src/app.ts', status: 'M' }],
      gitStatus: ' M src/app.ts',
      diffStat: '1 file changed',
      selectedCommands: ['pnpm test'],
      commandResults: [
        {
          command: 'pnpm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 35,
          stdout: 'STDOUT_SECRET_NEVER_EXPOSE',
          stderr: 'STDERR_SECRET_NEVER_EXPOSE',
        },
      ],
      risks: [],
    },
    scan: {
      status: 'passed',
      cwd,
      generatedAt: '2026-11-24T00:00:00.000Z',
      changedFiles: [{ path: 'src/app.ts', status: 'M' }],
      gitStatus: ' M src/app.ts',
      diffStat: '1 file changed',
      risks: [],
    },
    summary: 'verification passed',
    recommendation: 'Safe to merge.',
    reasonCode: 'passed',
    snapshotId: 'snap-stable-1',
    workspaceFingerprint: {
      headSha: 'abc123def4567890',
      inputDigest: 'in-1',
      configDigest: 'cfg-1',
    },
    blockers: [],
    ...overrides,
  };
}

function makeGit(cwd: string, overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    cwd,
    isRepo: true,
    root: cwd,
    statusText: ' M src/app.ts',
    diffText: 'diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n+const DIFF_BODY_SECRET = true;',
    diffStat: 'src/app.ts | 1 +',
    changedFiles: [{ path: 'src/app.ts', status: 'M' }],
    ...overrides,
  };
}

async function makeDeps(options: {
  cwd?: string;
  homeDir?: string;
  proof?: ProofResult;
  runProofError?: Error;
  git?: GitInspection;
  afterSnapshotId?: string;
  runReviewer?: GateDeps['runReviewer'];
  stdout?: ReturnType<typeof writable>;
  stderr?: ReturnType<typeof writable>;
} = {}): Promise<{ readonly deps: GateDeps; readonly cwd: string; readonly homeDir: string }> {
  const cwd = options.cwd ?? await makeTempDir('wukong-gate-cwd-');
  const homeDir = options.homeDir ?? await makeTempDir('wukong-gate-home-');
  const proof = options.proof ?? makeProof(cwd);
  const git = options.git ?? makeGit(cwd);
  const deps: GateDeps = {
    cwd: () => cwd,
    homeDir: () => homeDir,
    stdout: (options.stdout ?? writable()).writer,
    stderr: (options.stderr ?? writable()).writer,
    runProof: vi.fn(async () => {
      if (options.runProofError !== undefined) throw options.runProofError;
      return proof;
    }) as unknown as GateDeps['runProof'],
    createSnapshot: vi.fn(async () => ({
      id: options.afterSnapshotId ?? proof.snapshotId,
      cwd,
      headSha: proof.workspaceFingerprint.headSha,
      inputDigest: 'in-1',
      configDigest: 'cfg-1',
      planDigest: 'plan-1',
      git,
    })) as unknown as GateDeps['createSnapshot'],
    inspectGit: vi.fn(async () => git) as unknown as GateDeps['inspectGit'],
    selectCommands: vi.fn(async () => [
      { command: 'pnpm test', source: 'package-script' as const },
    ]) as unknown as GateDeps['selectCommands'],
    resolveWorkspaceIdentity,
    runReviewer: options.runReviewer ?? vi.fn(async () => ({
      modelAlias: 'default',
      providerId: 'openai',
      text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Looks solid.","findings":[],"uncoveredItems":[]}',
    })),
    saveRun: saveGateRun,
    now: () => new Date('2026-11-24T12:00:00.000Z'),
  };
  return { deps, cwd, homeDir };
}

describe('handleGate', () => {
  it('runs deterministic proof + isolated reviewer, returns PASS (0), and persists sanitized 0o600 record without dirtying cwd', async () => {
    const stdout = writable();
    const { deps, cwd, homeDir } = await makeDeps({ stdout });

    const code = await handleGate(deps, { objective: 'Harden auth handler' });

    expect(code).toBe(0);
    expect(deps.runReviewer).toHaveBeenCalledTimes(1);
    const out = stdout.chunks.join('');
    expect(out).toContain('Verdict: PASS (passed)');
    expect(out).toContain('Reviewer: passed (default)');

    expect(existsSync(join(cwd, '.wukong'))).toBe(false);
    expect(existsSync(join(cwd, 'wukong-proof-report.md'))).toBe(false);

    const savedFiles = await readdir(join(homeDir, 'runs', 'gate'));
    expect(savedFiles).toHaveLength(1);
    const savedPath = join(homeDir, 'runs', 'gate', savedFiles[0]!);
    if (process.platform !== 'win32') {
      const fileStat = await stat(savedPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
    const stored = await readGateRun(savedFiles[0]!.replace(/\.json$/u, ''), homeDir);
    expect(stored?.status).toBe('PASS');
    expect(stored?.source).toBe('gate');
  });

  it('skips LLM reviewer when deterministic checks fail, zero checks exist, or high-severity risks exist', async () => {
    const baseCwd = await makeTempDir('wukong-gate-det-');
    const baseProof = makeProof(baseCwd);

    const cases: Array<{ name: string; proof: ProofResult; expectedCode: string }> = [
      {
        name: 'failed check',
        proof: {
          ...baseProof,
          status: 'blocked',
          verification: {
            ...baseProof.verification,
            status: 'failed',
            commandResults: [{
              command: 'pnpm test',
              status: 'failed',
              exitCode: 1,
              durationMs: 10,
              stdout: '',
              stderr: 'failed',
            }],
          },
        },
        expectedCode: 'checks_failed',
      },
      {
        name: 'zero checks',
        proof: {
          ...baseProof,
          status: 'blocked',
          verification: {
            ...baseProof.verification,
            status: 'failed',
            selectedCommands: [],
            commandResults: [],
          },
        },
        expectedCode: 'no_executable_checks',
      },
      {
        name: 'high risk',
        proof: {
          ...baseProof,
          scan: {
            ...baseProof.scan,
            status: 'failed',
            risks: [{ id: 'file.secret_like_changed', severity: 'high', message: 'Secret edited' }],
          },
        },
        expectedCode: 'risks_blocked',
      },
    ];

    for (const testCase of cases) {
      const stdout = writable();
      const { deps } = await makeDeps({ cwd: baseCwd, proof: testCase.proof, stdout });
      const code = await handleGate(deps, { json: true });
      expect(code, testCase.name).toBe(1);
      expect(deps.runReviewer, testCase.name).not.toHaveBeenCalled();
      const json = JSON.parse(stdout.chunks.join('')) as { status: string; reasonCode: string; reviewer: { status: string } };
      expect(json.status, testCase.name).toBe('NEEDS_WORK');
      expect(json.reasonCode, testCase.name).toBe(testCase.expectedCode);
      expect(json.reviewer.status, testCase.name).toBe('not_run');
    }
  });

  it('returns NEEDS_WORK (1) with actionable findings when reviewer rejects the change', async () => {
    const stdout = writable();
    const { deps } = await makeDeps({
      stdout,
      runReviewer: async () => ({
        modelAlias: 'default',
        providerId: 'anthropic',
        text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"NEEDS_WORK","summary":"Missing input validation","findings":[{"id":"val-1","severity":"blocking","message":"Reject empty payload","file":"src/app.ts","line":14,"nextAction":"Validate payload before saving."}],"uncoveredItems":[]}',
      }),
    });

    const code = await handleGate(deps, {});
    expect(code).toBe(1);
    const out = stdout.chunks.join('');
    expect(out).toContain('Verdict: NEEDS_WORK (review_needs_work)');
    expect(out).toContain('Validate payload before saving.');
  });

  it('returns ERROR (2) and never PASS when reviewer throws, emits invalid JSON, or workspace changes mid-review', async () => {
    const errStdout = writable();
    const { deps: depsErr } = await makeDeps({
      stdout: errStdout,
      runReviewer: async () => {
        throw new Error('Provider unreachable');
      },
    });
    expect(await handleGate(depsErr, {})).toBe(2);
    expect(errStdout.chunks.join('')).toContain('Verdict: ERROR');

    const invalidStdout = writable();
    const { deps: depsInvalid } = await makeDeps({
      stdout: invalidStdout,
      runReviewer: async () => ({
        modelAlias: 'default',
        providerId: 'openai',
        text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"contradiction","findings":[{"id":"b1","severity":"blocking","message":"broken","nextAction":"fix"}],"uncoveredItems":[]}',
      }),
    });
    expect(await handleGate(depsInvalid, { json: true })).toBe(2);
    expect(JSON.parse(invalidStdout.chunks.join('')).status).toBe('ERROR');

    const staleStdout = writable();
    const { deps: depsStale } = await makeDeps({
      stdout: staleStdout,
      afterSnapshotId: 'snap-changed-during-review',
    });
    expect(await handleGate(depsStale, { json: true })).toBe(2);
    expect(JSON.parse(staleStdout.chunks.join('')).reasonCode).toBe('workspace_changed');

    const changedStdout = writable();
    const { deps: depsChanged } = await makeDeps({
      stdout: changedStdout,
      runProofError: new WorkspaceChangedError(),
    });
    expect(await handleGate(depsChanged, { json: true })).toBe(2);
    expect(JSON.parse(changedStdout.chunks.join('')).status).toBe('ERROR');
  });

  it('renders and optionally saves sanitized --summary output without leaking secrets, diff text, stdout, or home paths', async () => {
    const cwd = await makeTempDir('wukong-gate-summary-');
    const homeDir = await makeTempDir('wukong-gate-home-secret-');
    const stdout = writable();
    const proof = makeProof(cwd, {
      verification: {
        ...makeProof(cwd).verification,
        selectedCommands: ['OPENAI_API_KEY=sk-secret-test-value pnpm test'],
        commandResults: [{
          command: 'OPENAI_API_KEY=sk-secret-test-value pnpm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 12,
          stdout: 'STDOUT_SECRET_NEVER_EXPOSE',
          stderr: 'STDERR_SECRET_NEVER_EXPOSE',
        }],
      },
    });
    const { deps } = await makeDeps({
      cwd,
      homeDir,
      proof,
      stdout,
      runReviewer: async () => ({
        modelAlias: 'default',
        providerId: 'openai',
        text: `GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Verified ${homeDir}/repo with https://user:pass@api.example.test?token=query-secret","findings":[],"uncoveredItems":[]}`,
      }),
    });

    const savePath = 'artifacts/proof-card.md';
    const code = await handleGate(deps, {
      objective: 'Ship check sk-secret-test-value',
      summary: true,
      saveSummary: savePath,
    });
    expect(code).toBe(0);

    const card = await readFile(join(cwd, savePath), 'utf8');
    const out = stdout.chunks.join('');
    expect(out).toBe(card);
    expect(card).toContain('## Wukong Delivery Proof Card');
    expect(card).toContain('### Uncovered Items');

    for (const secret of [
      'sk-secret-test-value',
      'user:pass',
      'query-secret',
      'STDOUT_SECRET_NEVER_EXPOSE',
      'STDERR_SECRET_NEVER_EXPOSE',
      'DIFF_BODY_SECRET',
      homeDir,
      cwd,
    ]) {
      expect(card).not.toContain(secret);
      expect(out).not.toContain(secret);
    }
  });

  it('validates CLI timeout and --reviewer arguments cleanly', async () => {
    const stderr = writable();
    const program = new Command();
    program.exitOverride();
    registerGateCommand(program, { stderr: stderr.writer });
    process.exitCode = undefined;

    await program.parseAsync(['gate', '--timeout', '0'], { from: 'user' });
    expect(stderr.chunks.join('')).toContain('--timeout must be a positive integer');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const stderrReviewer = writable();
    const programReviewer = new Command();
    programReviewer.exitOverride();
    registerGateCommand(programReviewer, { stderr: stderrReviewer.writer });
    await programReviewer.parseAsync(['gate', '--reviewer', 'unknown-cli'], { from: 'user' });
    expect(stderrReviewer.chunks.join('')).toContain(
      '--reviewer must be one of: auto, provider, claude, codex, gemini',
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('routes --reviewer claude cleanly and surfaces cli_reviewer errors as ERROR (2)', async () => {
    const cwd = await makeTempDir('wukong-gate-cli-rev-');
    const homeDir = await makeTempDir('wukong-gate-cli-home-');
    const stdout = writable();
    const runReviewer = vi.fn(async () => ({
      modelAlias: 'claude',
      providerId: 'cli:claude',
      text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"CLI review passed.","findings":[],"uncoveredItems":[]}',
    }));
    const { deps } = await makeDeps({ cwd, homeDir, stdout, runReviewer });
    const program = new Command();
    program.exitOverride();
    registerGateCommand(program, deps);

    await program.parseAsync(['gate', '--reviewer', 'Claude', '--summary'], { from: 'user' });
    expect(process.exitCode).toBeUndefined();
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining({ reviewer: 'claude' }));
    expect(stdout.chunks.join('')).toContain('via `cli:claude`');

    const humanStdout = writable();
    const { deps: humanDeps } = await makeDeps({ cwd, homeDir, stdout: humanStdout, runReviewer });
    expect(await handleGate(humanDeps, { reviewer: 'claude' })).toBe(0);
    expect(humanStdout.chunks.join('')).toContain('Reviewer: passed (claude via cli:claude)');

    const errStdout = writable();
    const { deps: errDeps } = await makeDeps({
      cwd,
      homeDir,
      stdout: errStdout,
      runReviewer: async () => {
        throw new CliReviewerError('cli_reviewer_auth_failed', 'Please sign in to claude CLI.');
      },
    });
    expect(await handleGate(errDeps, { reviewer: 'claude', json: true })).toBe(2);
    const parsedErr = JSON.parse(errStdout.chunks.join('')) as {
      status: string;
      reasonCode: string;
      reviewer: { providerId?: string; errorCode?: string };
    };
    expect(parsedErr.status).toBe('ERROR');
    expect(parsedErr.reasonCode).toBe('cli_reviewer_auth_failed');
    expect(parsedErr.reviewer.providerId).toBe('cli:claude');
    expect(parsedErr.reviewer.errorCode).toBe('cli_reviewer_auth_failed');
  });

  it('selects configured provider first in auto mode and falls back to installed local CLI only when unconfigured', async () => {
    const isolatedMock = vi.fn(async () => ({
      modelAlias: 'default',
      providerId: 'openai',
      text: 'ok',
      finishReason: 'completed',
    }));
    const cliMock = vi.fn(async () => ({
      modelAlias: 'gemini',
      providerId: 'cli:gemini',
      text: 'ok',
      finishReason: 'completed',
    }));

    const unconfiguredConfig: WukongConfig = {
      providers: {},
      models: {},
    };
    const configuredConfig: WukongConfig = {
      providers: { openai: { type: 'openai', apiKey: 'YOUR_API_KEY' } },
      models: { default: { provider: 'openai', model: 'gpt-test', maxContextSize: 128_000 } },
      defaultModel: 'default',
    };

    const execAutoFallback = createDefaultGateReviewerExecutor({
      homeDir: () => undefined,
      getConfig: async () => unconfiguredConfig,
      runIsolated: isolatedMock,
      detectCli: () => ({ backend: 'gemini', binary: 'gemini', installed: true, resolvedPath: '/bin/gemini' }),
      runCli: cliMock,
    });
    await execAutoFallback({ reviewer: 'auto', systemPrompt: 'S', userPrompt: 'U' });
    expect(cliMock).toHaveBeenCalledWith(expect.objectContaining({ backend: 'gemini' }));
    expect(isolatedMock).not.toHaveBeenCalled();

    const execConfigured = createDefaultGateReviewerExecutor({
      homeDir: () => undefined,
      getConfig: async () => configuredConfig,
      runIsolated: isolatedMock,
      detectCli: () => ({ backend: 'gemini', binary: 'gemini', installed: true, resolvedPath: '/bin/gemini' }),
      runCli: cliMock,
    });
    await execConfigured({ reviewer: 'auto', systemPrompt: 'S', userPrompt: 'U' });
    expect(isolatedMock).toHaveBeenCalledTimes(1);

    const execMissingBoth = createDefaultGateReviewerExecutor({
      homeDir: () => undefined,
      getConfig: async () => unconfiguredConfig,
      runIsolated: isolatedMock,
      detectCli: () => undefined,
      runCli: cliMock,
    });
    await expect(
      execMissingBoth({ reviewer: 'auto', systemPrompt: 'S', userPrompt: 'U' }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
  });
});
