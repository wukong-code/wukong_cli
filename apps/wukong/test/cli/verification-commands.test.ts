import { describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import { handleGuard, type GuardDeps } from '#/cli/sub/guard';
import { handleScan, type ScanDeps } from '#/cli/sub/scan';
import { handleVerify, type VerifyDeps } from '#/cli/sub/verify';

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
  it('registers verify, scan, and guard as top-level commands', () => {
    const program = createProgram('0.0.0', () => {}, () => {});
    const names = program.commands.map((command) => command.name());

    expect(names).toContain('verify');
    expect(names).toContain('scan');
    expect(names).toContain('guard');
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
