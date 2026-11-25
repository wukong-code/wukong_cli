import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { GitInspection, ProofResult } from '@wukong/verification';
import { Command } from 'commander';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { createProgram, formatAllCommandsHelp } from '#/cli/commands';
import {
  parseClaudeStopHookStdin,
  runClaudeStopHook,
} from '#/cli/lib/claude-stop-hook';
import {
  CODEX_AGENTS_END,
  CODEX_AGENTS_START,
  CURSOR_RULE_MARKER,
  buildClaudeStopHookCommand,
  inspectIntegrationsStatus,
  installIntegrations,
  removeIntegrations,
} from '#/cli/lib/integrate';
import {
  handleIntegrateStatus,
  registerIntegrateCommand,
  type IntegrateCommandDeps,
} from '#/cli/sub/integrate';

function writable(): {
  readonly chunks: string[];
  readonly writer: { write(chunk: string): boolean };
} {
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

function makeGitInspection(cwd: string, overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    cwd,
    isRepo: true,
    changedFiles: [{ path: 'src/index.ts', status: 'M' }],
    statusText: ' M src/index.ts',
    diffStat: '1 file changed',
    diffText: 'diff --git a/src/index.ts b/src/index.ts',
    ...overrides,
  };
}

function makePassingProof(cwd: string): ProofResult {
  return {
    status: 'passed',
    cwd,
    generatedAt: '2026-11-26T00:00:00.000Z',
    verification: {
      status: 'passed',
      cwd,
      generatedAt: '2026-11-26T00:00:00.000Z',
      changedFiles: [{ path: 'src/index.ts', status: 'M' }],
      gitStatus: ' M src/index.ts',
      diffStat: '1 file changed',
      selectedCommands: ['pnpm test'],
      commandResults: [
        {
          command: 'pnpm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 20,
          stdout: 'ok',
          stderr: '',
        },
      ],
      risks: [],
    },
    scan: {
      status: 'passed',
      cwd,
      generatedAt: '2026-11-26T00:00:00.000Z',
      changedFiles: [{ path: 'src/index.ts', status: 'M' }],
      gitStatus: ' M src/index.ts',
      diffStat: '1 file changed',
      risks: [],
    },
    summary: 'All checks passed.',
    recommendation: 'Safe to merge.',
    reasonCode: 'passed',
    snapshotId: 'snap-int-1234',
    workspaceFingerprint: { inputDigest: 'in-1', configDigest: 'cfg-1', headSha: 'abc12345' },
    blockers: [],
  };
}

async function withTempDirs<T>(
  fn: (dirs: { readonly workspaceDir: string; readonly homeDir: string }) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'wukong-integrate-ws-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'wukong-integrate-home-'));
  try {
    return await fn({ workspaceDir, homeDir });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

function makeStreamWith(text: string): NodeJS.ReadableStream {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

describe('wukong integrate command registration and help', () => {
  it('registers integrate under Advanced Commands without expanding core CLI help', async () => {
    const program = createProgram('1.2.3', () => {}, () => {});
    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toContain('integrate');

    const defaultHelp = program.helpInformation();
    expect(defaultHelp).not.toMatch(/^\s+integrate\b/mu);

    const allHelp = formatAllCommandsHelp(program);
    expect(allHelp).toContain('Advanced Commands:');
    expect(allHelp).toMatch(/^\s+integrate\s+Configure, verify, or remove Wukong integrations/mu);

    const out: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeOut: (chunk) => out.push(chunk),
      writeErr: () => {},
    });
    await program.parseAsync(['node', 'wukong', 'help', 'integrate']);
    const subHelp = out.join('');
    for (const sub of ['claude', 'cursor', 'codex', 'all', 'status', 'remove']) {
      expect(subHelp).toContain(sub);
    }
    expect(subHelp).not.toMatch(/^\s+hook\b/mu);
  });

  it('validates invalid mode, reviewer, and status/remove targets', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const stderr = writable();
      const stdout = writable();
      const program = new Command();
      program.exitOverride();
      registerIntegrateCommand(program, {
        cwd: () => workspaceDir,
        homeDir: () => homeDir,
        stdin: makeStreamWith(''),
        stdout: stdout.writer,
        stderr: stderr.writer,
        inspectGit: async () => makeGitInspection(workspaceDir),
      });

      const prevExitCode = process.exitCode;
      try {
        process.exitCode = undefined;
        await program.parseAsync(['integrate', 'claude', '--mode', 'bogus'], { from: 'user' });
        expect(process.exitCode).toBe(1);
        expect(stderr.chunks.join('')).toContain('--mode must be one of');

        stderr.chunks.length = 0;
        process.exitCode = undefined;
        await program.parseAsync(['integrate', 'all', '--reviewer', 'unknown'], { from: 'user' });
        expect(process.exitCode).toBe(1);
        expect(stderr.chunks.join('')).toContain('--reviewer must be one of');

        stderr.chunks.length = 0;
        process.exitCode = undefined;
        await program.parseAsync(['integrate', 'status', 'vscode'], { from: 'user' });
        expect(process.exitCode).toBe(1);
        expect(stderr.chunks.join('')).toContain('target must be one of');

        stderr.chunks.length = 0;
        process.exitCode = undefined;
        await program.parseAsync(['integrate', 'remove', 'windsurf'], { from: 'user' });
        expect(process.exitCode).toBe(1);
        expect(stderr.chunks.join('')).toContain('target must be one of');
      } finally {
        process.exitCode = prevExitCode;
      }
    });
  });
});

describe('claude integration', () => {
  it('installs Stop Hook idempotently, preserves existing settings/hooks, updates flags, and cleans up safely', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      const settingsPath = join(workspaceDir, '.claude', 'settings.json');
      await mkdir(join(workspaceDir, '.claude'), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify(
          {
            model: 'sonnet',
            hooks: {
              PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
              Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      // Dry-run leaves settings untouched
      const dryRun = await installIntegrations(workspaceDir, 'claude', { dryRun: true });
      expect(dryRun[0]?.status).toBe('ok');
      expect(dryRun[0]?.dryRun).toBe(true);
      const afterDryRun = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        hooks: { Stop: unknown[] };
      };
      expect(afterDryRun.hooks.Stop).toHaveLength(1);

      // First real install
      const firstInstall = await installIntegrations(workspaceDir, 'claude');
      expect(firstInstall[0]?.status).toBe('ok');
      expect(firstInstall[0]?.files[0]?.action).toBe('updated');
      expect(firstInstall[0]?.notes.join(' ')).toContain('claude mcp add wukong');
      // Never writes project-root .mcp.json (would self-recurse inside Wukong)
      expect(existsSync(join(workspaceDir, '.mcp.json'))).toBe(false);

      const installedJson = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        model: string;
        hooks: {
          PreToolUse: unknown[];
          Stop: Array<{ hooks: Array<{ type: string; command: string }> }>;
        };
      };
      expect(installedJson.model).toBe('sonnet');
      expect(installedJson.hooks.PreToolUse).toHaveLength(1);
      expect(installedJson.hooks.Stop).toHaveLength(2);
      expect(installedJson.hooks.Stop[0]?.hooks[0]?.command).toBe('echo user-stop');
      expect(installedJson.hooks.Stop[1]?.hooks[0]?.command).toBe(buildClaudeStopHookCommand());

      // Second install is idempotent
      const secondInstall = await installIntegrations(workspaceDir, 'claude');
      expect(secondInstall[0]?.status).toBe('unchanged');
      expect(secondInstall[0]?.files[0]?.action).toBe('unchanged');

      // Status configured
      const statusBeforeUpdate = await inspectIntegrationsStatus(workspaceDir, 'claude');
      expect(statusBeforeUpdate[0]?.status).toBe('configured');

      // Updating hook options updates command in-place without duplicating Stop groups
      const updatedInstall = await installIntegrations(workspaceDir, 'claude', {
        mode: 'check',
        reviewer: 'codex',
        strict: true,
      });
      expect(updatedInstall[0]?.status).toBe('ok');
      expect(updatedInstall[0]?.files[0]?.action).toBe('updated');
      const updatedJson = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> };
      };
      expect(updatedJson.hooks.Stop).toHaveLength(2);
      expect(updatedJson.hooks.Stop[1]?.hooks[0]?.command).toBe(
        'wukong integrate hook claude-stop --mode check --reviewer codex --strict',
      );

      // Remove removes ONLY Wukong's hook and preserves user keys & Stop hook
      const removed = await removeIntegrations(workspaceDir, 'claude');
      expect(removed[0]?.status).toBe('ok');
      expect(removed[0]?.files[0]?.action).toBe('updated');
      const afterRemove = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        model: string;
        hooks: { PreToolUse: unknown[]; Stop: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(afterRemove.model).toBe('sonnet');
      expect(afterRemove.hooks.PreToolUse).toHaveLength(1);
      expect(afterRemove.hooks.Stop).toHaveLength(1);
      expect(afterRemove.hooks.Stop[0]?.hooks[0]?.command).toBe('echo user-stop');
    });
  });

  it('removes empty .claude/settings.json on clean uninstall and reports invalid JSON cleanly', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      await installIntegrations(workspaceDir, 'claude');
      const settingsPath = join(workspaceDir, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);

      const removed = await removeIntegrations(workspaceDir, 'claude');
      expect(removed[0]?.status).toBe('ok');
      expect(removed[0]?.files[0]?.action).toBe('removed');
      expect(existsSync(settingsPath)).toBe(false);

      const cleanStatus = await inspectIntegrationsStatus(workspaceDir, 'claude');
      expect(cleanStatus[0]?.status).toBe('not_configured');

      await mkdir(join(workspaceDir, '.claude'), { recursive: true });
      await writeFile(settingsPath, '{ not valid json', 'utf8');
      const invalidStatus = await inspectIntegrationsStatus(workspaceDir, 'claude');
      expect(invalidStatus[0]?.status).toBe('invalid');
    });
  });
});

describe('cursor integration', () => {
  it('installs MCP + MDC rule preserving user servers, protects unmanaged files unless --force, and reports partial/invalid status', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      const mcpPath = join(workspaceDir, '.cursor', 'mcp.json');
      const rulePath = join(workspaceDir, '.cursor', 'rules', 'wukong-gate.mdc');
      await mkdir(join(workspaceDir, '.cursor'), { recursive: true });
      await writeFile(
        mcpPath,
        `${JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }, null, 2)}\n`,
        'utf8',
      );

      const installed = await installIntegrations(workspaceDir, 'cursor');
      expect(installed[0]?.status).toBe('ok');
      expect(installed[0]?.files.map((f) => f.action)).toEqual(['updated', 'created']);

      const mcpJson = JSON.parse(await readFile(mcpPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcpJson.mcpServers['docs']).toEqual({ url: 'https://example.com/mcp' });
      expect(mcpJson.mcpServers['wukong']).toEqual({ command: 'wukong', args: ['mcp'] });

      const ruleText = await readFile(rulePath, 'utf8');
      expect(ruleText).toContain('alwaysApply: true');
      expect(ruleText).toContain(CURSOR_RULE_MARKER);

      const second = await installIntegrations(workspaceDir, 'cursor');
      expect(second[0]?.status).toBe('unchanged');

      // Delete rule file -> status is partial
      await rm(rulePath);
      const partial = await inspectIntegrationsStatus(workspaceDir, 'cursor');
      expect(partial[0]?.status).toBe('partial');

      // Write custom unmanaged rule -> install refuses without --force
      await writeFile(rulePath, '# custom user rule\n', 'utf8');
      const blocked = await installIntegrations(workspaceDir, 'cursor');
      expect(blocked[0]?.status).toBe('error');
      expect(blocked[0]?.error).toContain('--force');
      expect(await readFile(rulePath, 'utf8')).toBe('# custom user rule\n');

      // Overwrite with --force succeeds
      const forced = await installIntegrations(workspaceDir, 'cursor', { force: true });
      expect(forced[0]?.status).toBe('ok');
      expect(await readFile(rulePath, 'utf8')).toContain(CURSOR_RULE_MARKER);

      // Remove cleans only wukong entries and preserves other servers
      const removed = await removeIntegrations(workspaceDir, 'cursor');
      expect(removed[0]?.status).toBe('ok');
      expect(existsSync(rulePath)).toBe(false);
      const remainingMcp = JSON.parse(await readFile(mcpPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(remainingMcp.mcpServers['docs']).toEqual({ url: 'https://example.com/mcp' });
      expect(remainingMcp.mcpServers['wukong']).toBeUndefined();

      // Malformed JSON -> invalid
      await writeFile(mcpPath, '{ broken', 'utf8');
      const invalid = await inspectIntegrationsStatus(workspaceDir, 'cursor');
      expect(invalid[0]?.status).toBe('invalid');
    });
  });
});

describe('codex integration', () => {
  it('installs TOML + AGENTS.md preserving comments and user sections, checks validity, and strips cleanly on remove', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      const tomlPath = join(workspaceDir, '.codex', 'config.toml');
      const agentsPath = join(workspaceDir, 'AGENTS.md');
      await mkdir(join(workspaceDir, '.codex'), { recursive: true });
      await writeFile(
        tomlPath,
        '# User Codex comment\nmodel = "gpt-5.4"\nsandbox_mode = "workspace-write"\n',
        'utf8',
      );
      await writeFile(agentsPath, '# Project Agents Guide\n\n- Keep tests green.\n', 'utf8');

      const installed = await installIntegrations(workspaceDir, 'codex');
      expect(installed[0]?.status).toBe('ok');
      expect(installed[0]?.files.map((f) => f.action)).toEqual(['updated', 'updated']);

      const tomlRaw = await readFile(tomlPath, 'utf8');
      expect(tomlRaw).toContain('# User Codex comment');
      const parsedToml = parseToml(tomlRaw) as {
        model: string;
        mcp_servers: { wukong: { command: string; args: string[]; enabled: boolean } };
      };
      expect(parsedToml.model).toBe('gpt-5.4');
      expect(parsedToml.mcp_servers.wukong).toEqual({
        command: 'wukong',
        args: ['mcp'],
        enabled: true,
      });

      const agentsRaw = await readFile(agentsPath, 'utf8');
      expect(agentsRaw).toContain('# Project Agents Guide');
      expect(agentsRaw).toContain('- Keep tests green.');
      expect(agentsRaw).toContain(CODEX_AGENTS_START);
      expect(agentsRaw).toContain(CODEX_AGENTS_END);

      // Idempotent second run
      const second = await installIntegrations(workspaceDir, 'codex');
      expect(second[0]?.status).toBe('unchanged');

      // Remove restores clean user config and AGENTS.md
      const removed = await removeIntegrations(workspaceDir, 'codex');
      expect(removed[0]?.status).toBe('ok');
      const tomlAfter = await readFile(tomlPath, 'utf8');
      expect(tomlAfter).toContain('# User Codex comment');
      expect(tomlAfter).not.toContain('mcp_servers.wukong');
      expect((parseToml(tomlAfter) as Record<string, unknown>)['model']).toBe('gpt-5.4');

      const agentsAfter = await readFile(agentsPath, 'utf8');
      expect(agentsAfter).toBe('# Project Agents Guide\n\n- Keep tests green.\n');
      expect(agentsAfter).not.toContain(CODEX_AGENTS_START);
    });
  });

  it('rejects unmanaged conflicting [mcp_servers.wukong] without --force and detects invalid TOML', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      const tomlPath = join(workspaceDir, '.codex', 'config.toml');
      await mkdir(join(workspaceDir, '.codex'), { recursive: true });
      await writeFile(
        tomlPath,
        '[mcp_servers.wukong]\ncommand = "custom-wukong"\nargs = ["serve"]\n',
        'utf8',
      );

      const blocked = await installIntegrations(workspaceDir, 'codex');
      expect(blocked[0]?.status).toBe('error');
      expect(blocked[0]?.error).toContain('--force');

      const forced = await installIntegrations(workspaceDir, 'codex', { force: true });
      expect(forced[0]?.status).toBe('ok');
      const parsed = parseToml(await readFile(tomlPath, 'utf8')) as {
        mcp_servers: { wukong: { command: string; args: string[]; enabled: boolean } };
      };
      expect(parsed.mcp_servers.wukong).toEqual({
        command: 'wukong',
        args: ['mcp'],
        enabled: true,
      });

      await writeFile(tomlPath, 'broken = [unclosed\n', 'utf8');
      const invalidStatus = await inspectIntegrationsStatus(workspaceDir, 'codex');
      expect(invalidStatus[0]?.status).toBe('invalid');
    });
  });
});

describe('all targets lifecycle and status CLI exit code', () => {
  it('installs all targets, reports exit 0 for healthy/unconfigured and exit 1 for partial/invalid', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const deps: IntegrateCommandDeps = {
        cwd: () => workspaceDir,
        homeDir: () => homeDir,
        stdin: makeStreamWith(''),
        stdout: writable().writer,
        stderr: writable().writer,
        inspectGit: async () => makeGitInspection(workspaceDir),
      };

      await expect(handleIntegrateStatus(deps, 'all', { json: true })).resolves.toBe(0);

      const installed = await installIntegrations(workspaceDir, 'all');
      expect(installed.map((item) => item.target)).toEqual(['claude', 'cursor', 'codex']);
      expect(installed.every((item) => item.status === 'ok')).toBe(true);

      const outBuf = writable();
      await expect(
        handleIntegrateStatus({ ...deps, stdout: outBuf.writer }, 'all', { json: true }),
      ).resolves.toBe(0);
      const statusJson = JSON.parse(outBuf.chunks.join('')) as {
        ok: boolean;
        targets: Array<{ target: string; status: string }>;
      };
      expect(statusJson.ok).toBe(true);
      expect(statusJson.targets.map((t) => `${t.target}:${t.status}`)).toEqual([
        'claude:configured',
        'cursor:configured',
        'codex:configured',
      ]);

      // Remove one file of codex -> partial -> status returns exit code 1
      await rm(join(workspaceDir, 'AGENTS.md'));
      await expect(handleIntegrateStatus(deps, 'all')).resolves.toBe(1);

      const removed = await removeIntegrations(workspaceDir, 'all');
      expect(removed.every((item) => item.status === 'ok')).toBe(true);
      await expect(handleIntegrateStatus(deps, 'all')).resolves.toBe(0);
    });
  });
});

describe('claude stop hook runtime', () => {
  it('parses valid, empty, and malformed stdin payloads safely', () => {
    expect(parseClaudeStopHookStdin('')).toEqual({});
    expect(parseClaudeStopHookStdin('{bad json')).toEqual({});
    expect(parseClaudeStopHookStdin('[1, 2]')).toEqual({});
    expect(
      parseClaudeStopHookStdin(
        JSON.stringify({
          stop_hook_active: true,
          cwd: ' /tmp/project ',
          session_id: 'sess-1',
          hook_event_name: 'Stop',
        }),
      ),
    ).toEqual({
      stop_hook_active: true,
      cwd: '/tmp/project',
      session_id: 'sess-1',
      hook_event_name: 'Stop',
    });
  });

  it('allows immediate stop when stop_hook_active is true or workspace git tree is clean', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const stdout1 = writable();
      const runProofSpy = vi.fn();
      await expect(
        runClaudeStopHook({
          cwd: () => workspaceDir,
          homeDir: () => homeDir,
          stdin: makeStreamWith(JSON.stringify({ stop_hook_active: true, cwd: workspaceDir })),
          stdout: stdout1.writer,
          stderr: writable().writer,
          inspectGit: async () => makeGitInspection(workspaceDir),
          gateDeps: { runProof: runProofSpy },
        }),
      ).resolves.toBe(0);
      expect(stdout1.chunks).toEqual([]);
      expect(runProofSpy).not.toHaveBeenCalled();

      const stdout2 = writable();
      await expect(
        runClaudeStopHook({
          cwd: () => workspaceDir,
          homeDir: () => homeDir,
          stdin: makeStreamWith('{}'),
          stdout: stdout2.writer,
          stderr: writable().writer,
          inspectGit: async () =>
            makeGitInspection(workspaceDir, { changedFiles: [], statusText: '', diffStat: '' }),
          gateDeps: { runProof: runProofSpy },
        }),
      ).resolves.toBe(0);
      expect(stdout2.chunks).toEqual([]);
      expect(runProofSpy).not.toHaveBeenCalled();
    });
  });

  it('allows stop when gate returns PASS and emits structured block decision when gate returns NEEDS_WORK or ERROR', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const hookCwdDir = join(workspaceDir, 'subpkg');
      await mkdir(hookCwdDir, { recursive: true });

      const passStdout = writable();
      let observedCwd: string | undefined;
      await expect(
        runClaudeStopHook({
          cwd: () => workspaceDir,
          homeDir: () => homeDir,
          stdin: makeStreamWith(JSON.stringify({ cwd: hookCwdDir })),
          stdout: passStdout.writer,
          stderr: writable().writer,
          inspectGit: async (dir) => makeGitInspection(dir ?? hookCwdDir),
          gateDeps: {
            now: () => new Date('2026-11-26T00:00:00.000Z'),
            selectCommands: async () => [{ command: 'pnpm test', source: 'explicit' }],
            runProof: async (opts) => {
              observedCwd = opts?.cwd;
              return makePassingProof(opts?.cwd ?? hookCwdDir);
            },
            createSnapshot: async (opts) => ({
              id: 'snap-int-1234',
              cwd: opts?.cwd ?? hookCwdDir,
              headSha: 'abc12345',
              inputDigest: 'in-1',
              configDigest: 'cfg-1',
              planDigest: 'plan-1',
              git: makeGitInspection(opts?.cwd ?? hookCwdDir),
            }),
            inspectGit: async (dir) => makeGitInspection(dir ?? hookCwdDir),
            runReviewer: async () => ({
              modelAlias: 'sonnet',
              providerId: 'cli:claude',
              text: JSON.stringify({
                schemaVersion: 1,
                status: 'PASS',
                summary: 'Looks good.',
                findings: [],
                uncoveredItems: [],
              }),
            }),
          },
        }),
      ).resolves.toBe(0);
      expect(observedCwd).toBe(hookCwdDir);
      expect(passStdout.chunks).toEqual([]);

      // NEEDS_WORK emits JSON { decision: 'block', reason } with findings and sanitized paths
      const blockStdout = writable();
      await expect(
        runClaudeStopHook({
          cwd: () => workspaceDir,
          homeDir: () => homeDir,
          stdin: makeStreamWith(''),
          stdout: blockStdout.writer,
          stderr: writable().writer,
          inspectGit: async (dir) => makeGitInspection(dir ?? workspaceDir),
          gateDeps: {
            now: () => new Date('2026-11-26T00:00:00.000Z'),
            selectCommands: async () => [{ command: 'pnpm test', source: 'explicit' }],
            runProof: async () => ({
              ...makePassingProof(workspaceDir),
              status: 'blocked',
              verification: {
                ...makePassingProof(workspaceDir).verification,
                status: 'failed',
                commandResults: [
                  {
                    command: 'API_KEY=sk-secret-1234567890 pnpm test',
                    status: 'failed',
                    exitCode: 1,
                    durationMs: 15,
                    stdout: '',
                    stderr: '1 test failed',
                  },
                ],
              },
              reasonCode: 'verification_failed',
            }),
            inspectGit: async (dir) => makeGitInspection(dir ?? workspaceDir),
            runReviewer: async () => {
              throw new Error('reviewer should not run on deterministic block');
            },
          },
        }),
      ).resolves.toBe(0);

      const blockJson = JSON.parse(blockStdout.chunks.join('')) as {
        decision: string;
        reason: string;
      };
      expect(blockJson.decision).toBe('block');
      expect(blockJson.reason).toContain('NEEDS_WORK');
      expect(blockJson.reason).toContain('checks_failed');
      expect(blockJson.reason).toContain('[REDACTED]');
      expect(blockJson.reason).not.toContain('sk-secret-1234567890');
      expect(blockJson.reason).not.toContain(homeDir);
      expect(blockJson.reason).toContain('Run ID:');

      // ERROR verdict (e.g. reviewer error) also blocks with clear explanation
      const errorStdout = writable();
      await expect(
        runClaudeStopHook({
          cwd: () => workspaceDir,
          homeDir: () => homeDir,
          stdin: makeStreamWith('invalid-json'),
          stdout: errorStdout.writer,
          stderr: writable().writer,
          inspectGit: async (dir) => makeGitInspection(dir ?? workspaceDir),
          gateDeps: {
            now: () => new Date('2026-11-26T00:00:00.000Z'),
            selectCommands: async () => [{ command: 'pnpm test', source: 'explicit' }],
            runProof: async () => makePassingProof(workspaceDir),
            createSnapshot: async () => ({
              id: 'snap-int-1234',
              cwd: workspaceDir,
              headSha: 'abc12345',
              inputDigest: 'in-1',
              configDigest: 'cfg-1',
              planDigest: 'plan-1',
              git: makeGitInspection(workspaceDir),
            }),
            inspectGit: async (dir) => makeGitInspection(dir ?? workspaceDir),
            runReviewer: async () => {
              throw new Error('Reviewer timed out.');
            },
          },
        }),
      ).resolves.toBe(0);

      const errorJson = JSON.parse(errorStdout.chunks.join('')) as {
        decision: string;
        reason: string;
      };
      expect(errorJson.decision).toBe('block');
      expect(errorJson.reason).toContain('ERROR');
      expect(errorJson.reason).toContain('Reviewer timed out.');
    });
  });

  it('supports check mode with --always through CLI integrate hook claude-stop', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const stdout = writable();
      const stderr = writable();
      const program = new Command();
      program.exitOverride();
      registerIntegrateCommand(program, {
        cwd: () => workspaceDir,
        homeDir: () => homeDir,
        stdin: makeStreamWith('{}'),
        stdout: stdout.writer,
        stderr: stderr.writer,
        // Clean working tree would normally skip unless --always is passed
        inspectGit: async () =>
          makeGitInspection(workspaceDir, { changedFiles: [], statusText: '', diffStat: '' }),
        checkDeps: {
          runVerification: async () => ({
            status: 'failed',
            cwd: workspaceDir,
            generatedAt: '2026-11-26T00:00:00.000Z',
            changedFiles: [],
            gitStatus: '',
            diffStat: '',
            selectedCommands: ['API_KEY=secret123456 pnpm test'],
            commandResults: [
              {
                command: 'API_KEY=secret123456 pnpm test',
                status: 'failed',
                exitCode: 1,
                durationMs: 12,
                stdout: '',
                stderr: 'fail',
              },
            ],
            risks: [
              {
                id: 'diff.debug_output_added',
                severity: 'high',
                message: `Leak in ${homeDir}/tmp`,
                file: 'src/a.ts',
                line: 7,
              },
            ],
          }),
        },
      });

      await program.parseAsync(['integrate', 'hook', 'claude-stop', '--mode', 'check', '--always'], {
        from: 'user',
      });
      expect(stderr.chunks).toEqual([]);

      const parsed = JSON.parse(stdout.chunks.join('')) as {
        decision: string;
        reason: string;
      };
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('[REDACTED]');
      expect(parsed.reason).not.toContain('secret123456');
      expect(parsed.reason).not.toContain(homeDir);
      expect(parsed.reason).toContain('src/a.ts:7');
    });
  });
});
