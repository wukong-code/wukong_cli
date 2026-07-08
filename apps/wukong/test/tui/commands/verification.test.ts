import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';

const mocks = vi.hoisted(() => ({
  runVerification: vi.fn(),
  runScan: vi.fn(),
  runProof: vi.fn(),
  runJudge: vi.fn(),
  getGuardStatus: vi.fn(),
  getGuardStats: vi.fn(),
}));

vi.mock('@wukong/verification', () => mocks);

const {
  handleGuardSlashCommand,
  handleReportSlashCommand,
  handleScanSlashCommand,
  handleVerifySlashCommand,
  handleProofSlashCommand,
  handleJudgeSlashCommand,
} = await import('#/tui/commands/verification');

const tempDirs: string[] = [];

interface TestHost {
  readonly showError: ReturnType<typeof vi.fn>;
  readonly showStatus: ReturnType<typeof vi.fn>;
  readonly showProgressSpinner: ReturnType<typeof vi.fn>;
  readonly state: {
    readonly appState: { readonly workDir: string };
    readonly transcriptContainer: { readonly addChild: ReturnType<typeof vi.fn> };
    readonly ui: { readonly requestRender: ReturnType<typeof vi.fn> };
  };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wukong-tui-verification-'));
  tempDirs.push(dir);
  return dir;
}

function makeHost(workDir = makeTempDir()): TestHost {
  return {
    state: {
      appState: { workDir },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    showError: vi.fn(),
    showStatus: vi.fn(),
    showProgressSpinner: vi.fn(() => ({ stop: vi.fn() })),
  } as unknown as TestHost;
}

function latestPanelText(host: TestHost): string {
  const panel = host.state.transcriptContainer.addChild.mock.calls.at(-1)?.[0] as
    | { render: (width: number) => readonly string[] }
    | undefined;
  return panel?.render(120).join('\n') ?? '';
}

function asSlashHost(host: TestHost): SlashCommandHost {
  return host as unknown as SlashCommandHost;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verification slash commands', () => {
  it('runs /verify and renders the verification panel', async () => {
    const host = makeHost('/repo');
    mocks.runVerification.mockResolvedValue({
      status: 'passed',
      cwd: '/repo',
      generatedAt: '2026-07-03T00:00:00.000Z',
      changedFiles: [],
      gitStatus: '',
      diffStat: '',
      selectedCommands: [{ name: 'test', command: 'npm test' }],
      commandResults: [
        {
          command: 'npm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 12,
          stdout: '',
          stderr: '',
        },
      ],
      risks: [],
      reportPath: '/repo/wukong-verification-report.md',
    });

    await handleVerifySlashCommand(asSlashHost(host), '');

    expect(mocks.runVerification).toHaveBeenCalledWith({ cwd: '/repo', writeReport: true });
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledOnce();
    expect(latestPanelText(host)).toContain('Status: passed');
    expect(latestPanelText(host)).toContain('npm test');
    expect(host.state.ui.requestRender).toHaveBeenCalledOnce();
  });

  it('runs /scan and renders risk output', async () => {
    const host = makeHost('/repo');
    mocks.runScan.mockResolvedValue({
      status: 'warning',
      cwd: '/repo',
      generatedAt: '2026-07-03T00:00:00.000Z',
      changedFiles: [{ path: 'src/app.ts', status: 'modified' }],
      gitStatus: ' M src/app.ts',
      diffStat: 'src/app.ts | 1 +',
      risks: [
        {
          id: 'risk.placeholder',
          severity: 'high',
          message: 'Placeholder text in changed code.',
          file: 'src/app.ts',
          line: 1,
        },
      ],
      reportPath: '/repo/wukong-scan-report.md',
    });

    await handleScanSlashCommand(asSlashHost(host));

    expect(mocks.runScan).toHaveBeenCalledWith({ cwd: '/repo', writeReport: true });
    expect(latestPanelText(host)).toContain('Status: warning');
    expect(latestPanelText(host)).toContain('Placeholder text in changed code.');
  });

  it('shows /guard status and local event counts', async () => {
    const host = makeHost('/repo');
    mocks.getGuardStatus.mockResolvedValue({ enabled: true, configPath: '/repo/.wukong/guard/config.json' });
    mocks.getGuardStats.mockResolvedValue({ total: 3, blocked: 2, allowed: 1 });

    await handleGuardSlashCommand(asSlashHost(host), 'status');

    expect(host.showStatus).toHaveBeenCalledWith('Guard enabled · 3 events · 2 blocked · 1 allowed');
  });

  it('runs /proof and renders the merge proof panel', async () => {
    const host = makeHost('/repo');
    mocks.runProof.mockResolvedValue({
      status: 'blocked',
      cwd: '/repo',
      generatedAt: '2026-07-03T00:00:00.000Z',
      verification: {
        status: 'passed',
        cwd: '/repo',
        generatedAt: '2026-07-03T00:00:00.000Z',
        changedFiles: [{ path: 'src/app.ts', status: 'modified' }],
        gitStatus: ' M src/app.ts',
        diffStat: 'src/app.ts | 1 +',
        selectedCommands: ['npm test'],
        commandResults: [{
          command: 'npm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 12,
          stdout: '',
          stderr: '',
        }],
        risks: [],
      },
      scan: {
        status: 'failed',
        cwd: '/repo',
        generatedAt: '2026-07-03T00:00:00.000Z',
        changedFiles: [{ path: 'src/app.ts', status: 'modified' }],
        gitStatus: ' M src/app.ts',
        diffStat: 'src/app.ts | 1 +',
        risks: [{
          id: 'diff.placeholder_added',
          severity: 'high',
          message: 'Placeholder text in changed code.',
          file: 'src/app.ts',
          line: 1,
        }],
      },
      summary: 'Merge proof blocked: verification passed, scan failed, 1 changed files.',
      recommendation: 'High-risk changes detected; review before merging.',
      reportPath: '/repo/wukong-proof-report.md',
    });

    await handleProofSlashCommand(asSlashHost(host));

    expect(mocks.runProof).toHaveBeenCalledWith({ cwd: '/repo', writeReport: true });
    expect(latestPanelText(host)).toContain('Status: blocked');
    expect(latestPanelText(host)).toContain('High-risk changes detected');
    expect(latestPanelText(host)).toContain('Placeholder text in changed code.');
  });

  it('runs /judge and renders the judge panel', async () => {
    const host = makeHost('/repo');
    mocks.runJudge.mockResolvedValue({
      verdict: 'block',
      reason: 'High-risk changes detected.',
      mode: 'deterministic',
      proof: {
        status: 'blocked',
        cwd: '/repo',
        generatedAt: '2026-07-03T00:00:00.000Z',
        verification: {
          status: 'passed',
          cwd: '/repo',
          generatedAt: '2026-07-03T00:00:00.000Z',
          changedFiles: [{ path: 'src/app.ts', status: 'modified' }],
          gitStatus: ' M src/app.ts',
          diffStat: 'src/app.ts | 1 +',
          selectedCommands: ['npm test'],
          commandResults: [{
            command: 'npm test',
            status: 'passed',
            exitCode: 0,
            durationMs: 12,
            stdout: '',
            stderr: '',
          }],
          risks: [],
        },
        scan: {
          status: 'failed',
          cwd: '/repo',
          generatedAt: '2026-07-03T00:00:00.000Z',
          changedFiles: [{ path: 'src/app.ts', status: 'modified' }],
          gitStatus: ' M src/app.ts',
          diffStat: 'src/app.ts | 1 +',
          risks: [{
            id: 'diff.placeholder_added',
            severity: 'high',
            message: 'Placeholder text in changed code.',
            file: 'src/app.ts',
            line: 1,
          }],
        },
        summary: 'Merge proof blocked.',
        recommendation: 'High-risk changes detected; review before merging.',
      },
    });

    await handleJudgeSlashCommand(asSlashHost(host));

    expect(mocks.runJudge).toHaveBeenCalledWith({ cwd: '/repo' });
    expect(latestPanelText(host)).toContain('Verdict: block');
    expect(latestPanelText(host)).toContain('High-risk changes detected.');
  });
});
