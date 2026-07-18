import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '#/cli/commands';
import { handleGuard, type GuardDeps } from '#/cli/sub/guard';
import { handleJudge, type JudgeDeps } from '#/cli/sub/judge';
import { handleProof, type ProofDeps } from '#/cli/sub/proof';
import { registerReviewCommand } from '#/cli/sub/review';
import { handleScan, type ScanDeps } from '#/cli/sub/scan';
import { handleVerify, type VerifyDeps } from '#/cli/sub/verify';
import type { ScanOptions, VerificationOptions, ProofOptions } from '@wukong/verification';

function writable(): { readonly chunks: string[]; readonly writer: { write(chunk: string): boolean } } {
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

describe('verification command registration', () => {
  it('registers verify, scan, proof, judge, loop, today, and guard as top-level commands', () => {
    const program = createProgram('0.0.0', () => {}, () => {});
    const names = program.commands.map((command) => command.name());

    expect(names).toContain('verify');
    expect(names).toContain('scan');
    expect(names).toContain('proof');
    expect(names).toContain('judge');
    expect(names).toContain('loop');
    expect(names).toContain('today');
    expect(names).toContain('guard');
    const help = program.helpInformation();
    expect(help).not.toMatch(/^\s+verify\b/m);
    expect(help).not.toMatch(/^\s+scan\b/m);
    expect(help).not.toMatch(/^\s+proof\b/m);
    expect(help).toMatch(/^\s+loop\b/m);
  });
});

describe('review command', () => {
  it('records local finding feedback and hides quality rates for small samples', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'wukong-review-feedback-'));
    const stdout = writable();
    const program = new Command();
    program.exitOverride();
    registerReviewCommand(program, {
      cwd: () => '/workspace/example',
      dataDir: () => dataDir,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      stdout: stdout.writer,
    });

    await program.parseAsync(['review', 'feedback', 'auth-refresh', 'false-positive'], { from: 'user' });
    await program.parseAsync(['review', 'stats'], { from: 'user' });

    const contents = await readFile(join(dataDir, 'review', 'feedback.jsonl'), 'utf8');
    expect(contents).toContain('"findingId":"auth-refresh"');
    expect(contents).toContain('"action":"false_positive"');
    expect(contents).not.toContain('/workspace/example');
    expect(stdout.chunks.join('')).toContain('false-positive: 1');
    expect(stdout.chunks.join('')).toContain('hidden until at least 10');
    expect(stdout.chunks.join('')).toContain('Review cycles: 0');
    expect(stdout.chunks.join('')).toContain('Invalid reviewer output: 0');
  });
});

describe('handleVerify', () => {
  it('prints a verification summary and returns failed exit code on failed status', async () => {
    const stdout = writable();
    const stderr = writable();
    const deps: VerifyDeps = {
      cwd: () => '/workspace',
      stdout: stdout.writer,
      stderr: stderr.writer,
      runVerification: async () => ({
        status: 'failed',
        cwd: '/workspace',
        generatedAt: '2026-07-02T00:00:00.000Z',
        changedFiles: [{ path: 'src/a.ts', status: 'M' }],
        gitStatus: ' M src/a.ts',
        diffStat: '1 file changed',
        selectedCommands: ['pnpm test'],
        commandResults: [{
          command: 'pnpm test',
          status: 'failed',
          exitCode: 1,
          durationMs: 12,
          stdout: '',
          stderr: 'failed',
        }],
        risks: [{
          id: 'diff.placeholder_added',
          severity: 'high',
          message: 'Placeholder added.',
          file: 'src/a.ts',
        }],
      }),
    };

    await expect(handleVerify(deps, {})).resolves.toBe(1);
    expect(stdout.chunks.join('')).toContain('Wukong verification');
    expect(stdout.chunks.join('')).toContain('Status: failed');
    expect(stderr.chunks).toEqual([]);
  });

  it('passes options to runVerification', async () => {
    const captured: VerificationOptions[] = [];
    const deps: VerifyDeps = {
      cwd: () => '/workspace',
      stdout: writable().writer,
      stderr: writable().writer,
      runVerification: async (options) => {
        captured.push(options);
        return {
          status: 'passed',
          cwd: options.cwd ?? '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          changedFiles: [],
          gitStatus: '',
          diffStat: '',
          selectedCommands: [],
          commandResults: [],
          risks: [],
        };
      },
    };

    await handleVerify(deps, {
      cwd: '/custom',
      commands: ['pnpm lint', 'pnpm test'],
      includeBuild: true,
      report: '/tmp/evidence.md',
      timeoutSeconds: 120,
      strict: true,
    });

    expect(captured[0]).toMatchObject({
      cwd: '/custom',
      commands: ['pnpm lint', 'pnpm test'],
      includeBuild: true,
      writeReport: true,
      reportPath: '/tmp/evidence.md',
      timeoutMs: 120_000,
      strict: true,
    });
  });

  it('returns 2 and writes to stderr on runVerification failure', async () => {
    const stderr = writable();
    const deps: VerifyDeps = {
      cwd: () => '/workspace',
      stdout: writable().writer,
      stderr: stderr.writer,
      runVerification: async () => {
        throw new Error('verify exploded');
      },
    };

    await expect(handleVerify(deps, { report: false })).resolves.toBe(2);
    expect(stderr.chunks.join('')).toContain('verify exploded');
  });

});

describe('handleScan', () => {
  it('prints JSON when requested', async () => {
    const stdout = writable();
    const deps: ScanDeps = {
      cwd: () => '/workspace',
      stdout: stdout.writer,
      stderr: writable().writer,
      runScan: async () => ({
        status: 'passed',
        cwd: '/workspace',
        generatedAt: '2026-07-02T00:00:00.000Z',
        changedFiles: [],
        gitStatus: '',
        diffStat: '',
        risks: [],
      }),
    };

    await expect(handleScan(deps, { json: true })).resolves.toBe(0);
    expect(JSON.parse(stdout.chunks.join(''))).toMatchObject({ status: 'passed' });
  });

  it('passes report options to runScan', async () => {
    const stdout = writable();
    const captured: ScanOptions[] = [];
    const deps: ScanDeps = {
      cwd: () => '/workspace',
      stdout: stdout.writer,
      stderr: writable().writer,
      runScan: async (options) => {
        captured.push(options);
        return {
          status: 'passed',
          cwd: options.cwd ?? '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          changedFiles: [],
          gitStatus: '',
          diffStat: '',
          risks: [],
          reportPath: options.reportPath,
        };
      },
    };

    await expect(handleScan(deps, { report: '/tmp/report.md' })).resolves.toBe(0);
    expect(captured[0]).toMatchObject({
      cwd: '/workspace',
      writeReport: true,
      reportPath: '/tmp/report.md',
    });
    expect(stdout.chunks.join('')).toContain('Report: /tmp/report.md');
  });

  it('returns 2 and writes to stderr on runScan failure', async () => {
    const stderr = writable();
    const deps: ScanDeps = {
      cwd: () => '/workspace',
      stdout: writable().writer,
      stderr: stderr.writer,
      runScan: async () => {
        throw new Error('scan exploded');
      },
    };

    await expect(handleScan(deps, {})).resolves.toBe(2);
    expect(stderr.chunks.join('')).toContain('scan exploded');
  });

});

describe('handleProof', () => {
  it('prints JSON proof result and returns blocked exit code on blocked status', async () => {
    const stdout = writable();
    const deps: ProofDeps = {
      cwd: () => '/workspace',
      stdout: stdout.writer,
      stderr: writable().writer,
      runProof: async () => ({
        status: 'blocked',
        cwd: '/workspace',
        generatedAt: '2026-07-02T00:00:00.000Z',
        verification: {
          status: 'passed',
          cwd: '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          changedFiles: [{ path: 'src/a.ts', status: 'M' }],
          gitStatus: ' M src/a.ts',
          diffStat: '1 file changed',
          selectedCommands: ['pnpm test'],
          commandResults: [{
            command: 'pnpm test',
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
          cwd: '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          changedFiles: [{ path: 'src/a.ts', status: 'M' }],
          gitStatus: ' M src/a.ts',
          diffStat: '1 file changed',
          risks: [{
            id: 'diff.placeholder_added',
            severity: 'high',
            message: 'Placeholder added.',
            file: 'src/a.ts',
          }],
        },
        summary: 'Merge proof blocked: verification passed, scan failed, 1 changed files.',
        recommendation: 'High-risk changes detected; review before merging.',
        reasonCode: 'risk_high',
        snapshotId: 'snapshot-id',
        workspaceFingerprint: { inputDigest: 'input', configDigest: 'config' },
        blockers: [],
      }),
    };

    await expect(handleProof(deps, { json: true })).resolves.toBe(1);
    const parsed = JSON.parse(stdout.chunks.join(''));
    expect(parsed.status).toBe('blocked');
    expect(parsed.recommendation).toContain('High-risk');
  });

  it('passes no-report to runProof', async () => {
    const captured: ProofOptions[] = [];
    const deps: ProofDeps = {
      cwd: () => '/workspace',
      stdout: writable().writer,
      stderr: writable().writer,
      runProof: async (options) => {
        captured.push(options);
        return {
          status: 'passed',
          cwd: '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          verification: {
            status: 'passed',
            cwd: '/workspace',
            generatedAt: '2026-07-02T00:00:00.000Z',
            changedFiles: [],
            gitStatus: '',
            diffStat: '',
            selectedCommands: [],
            commandResults: [],
            risks: [],
          },
          scan: {
            status: 'passed',
            cwd: '/workspace',
            generatedAt: '2026-07-02T00:00:00.000Z',
            changedFiles: [],
            gitStatus: '',
            diffStat: '',
            risks: [],
          },
          summary: 'All good.',
          recommendation: 'Safe to merge.',
          reasonCode: 'passed',
          snapshotId: 'snapshot-id',
          workspaceFingerprint: { inputDigest: 'input', configDigest: 'config' },
          blockers: [],
        };
      },
    };

    await handleProof(deps, { report: false });
    expect(captured[0]).toMatchObject({ writeReport: false, reportPath: undefined });
  });

  it('returns 2 on runProof failure', async () => {
    const stderr = writable();
    const deps: ProofDeps = {
      cwd: () => '/workspace',
      stdout: writable().writer,
      stderr: stderr.writer,
      runProof: async () => {
        throw new Error('proof exploded');
      },
    };

    await expect(handleProof(deps, {})).resolves.toBe(2);
    expect(stderr.chunks.join('')).toContain('proof exploded');
  });

});

describe('handleJudge', () => {
  it('prints JSON judge result and returns block exit code on block verdict', async () => {
    const stdout = writable();
    const deps: JudgeDeps = {
      cwd: () => '/workspace',
      stdout: stdout.writer,
      stderr: writable().writer,
      runJudge: async () => ({
        verdict: 'block',
        reason: 'High-risk changes detected.',
        mode: 'deterministic',
        proof: {
          status: 'blocked',
          cwd: '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          verification: {
            status: 'passed',
            cwd: '/workspace',
            generatedAt: '2026-07-02T00:00:00.000Z',
            changedFiles: [{ path: 'src/a.ts', status: 'M' }],
            gitStatus: ' M src/a.ts',
            diffStat: '1 file changed',
            selectedCommands: ['pnpm test'],
            commandResults: [{
              command: 'pnpm test',
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
            cwd: '/workspace',
            generatedAt: '2026-07-02T00:00:00.000Z',
            changedFiles: [{ path: 'src/a.ts', status: 'M' }],
            gitStatus: ' M src/a.ts',
            diffStat: '1 file changed',
            risks: [{
              id: 'diff.placeholder_added',
              severity: 'high',
              message: 'Placeholder added.',
              file: 'src/a.ts',
            }],
          },
          summary: 'Merge proof blocked.',
          recommendation: 'High-risk changes detected; review before merging.',
          reasonCode: 'risk_high',
          snapshotId: 'snapshot-id',
          workspaceFingerprint: { inputDigest: 'input', configDigest: 'config' },
          blockers: [],
        },
      }),
    };

    await expect(handleJudge(deps, { json: true })).resolves.toBe(1);
    const parsed = JSON.parse(stdout.chunks.join(''));
    expect(parsed.verdict).toBe('block');
    expect(parsed.mode).toBe('deterministic');
    expect(parsed.reason).toContain('High-risk');
  });

  it('returns 0 on pass verdict', async () => {
    const stdout = writable();
    const deps: JudgeDeps = {
      cwd: () => '/workspace',
      stdout: stdout.writer,
      stderr: writable().writer,
      runJudge: async () => ({
        verdict: 'pass',
        reason: 'No risks found.',
        mode: 'deterministic',
        proof: {
          status: 'passed',
          cwd: '/workspace',
          generatedAt: '2026-07-02T00:00:00.000Z',
          verification: {
            status: 'passed',
            cwd: '/workspace',
            generatedAt: '2026-07-02T00:00:00.000Z',
            changedFiles: [],
            gitStatus: '',
            diffStat: '',
            selectedCommands: [],
            commandResults: [],
            risks: [],
          },
          scan: {
            status: 'passed',
            cwd: '/workspace',
            generatedAt: '2026-07-02T00:00:00.000Z',
            changedFiles: [],
            gitStatus: '',
            diffStat: '',
            risks: [],
          },
          summary: 'All good.',
          recommendation: 'Safe to merge.',
          reasonCode: 'passed',
          snapshotId: 'snapshot-id',
          workspaceFingerprint: { inputDigest: 'input', configDigest: 'config' },
          blockers: [],
        },
      }),
    };

    await expect(handleJudge(deps, {})).resolves.toBe(0);
    expect(stdout.chunks.join('')).toContain('Verdict: pass');
  });

  it('returns 2 on runJudge failure', async () => {
    const stderr = writable();
    const deps: JudgeDeps = {
      cwd: () => '/workspace',
      stdout: writable().writer,
      stderr: stderr.writer,
      runJudge: async () => {
        throw new Error('judge exploded');
      },
    };

    await expect(handleJudge(deps, {})).resolves.toBe(2);
    expect(stderr.chunks.join('')).toContain('judge exploded');
  });
});

describe('handleGuard', () => {
  it('prints blocked command messages to stderr and returns the command exit code', async () => {
    const stdout = writable();
    const stderr = writable();
    const deps: GuardDeps = {
      stdout: stdout.writer,
      stderr: stderr.writer,
      getGuardStatus: async () => ({
        enabled: false,
        configPath: '/tmp/config.json',
        eventsPath: '/tmp/events.jsonl',
      }),
      getGuardStats: async () => ({ total: 0, blocked: 0, allowed: 0 }),
      setGuardEnabled: async (enabled) => ({
        enabled,
        configPath: '/tmp/config.json',
        eventsPath: '/tmp/events.jsonl',
      }),
      runGuardedCommand: async () => ({
        exitCode: 1,
        blocked: true,
        message: 'Blocked high-risk command.',
      }),
    };

    await expect(handleGuard(deps, { command: ['rm', '-rf', './tmp'] })).resolves.toBe(1);
    expect(stderr.chunks.join('')).toContain('Blocked high-risk command.');
    expect(stdout.chunks).toEqual([]);
  });
});
