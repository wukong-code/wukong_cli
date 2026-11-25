import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  GitInspection,
  ProofResult,
  WorkspaceSnapshot,
} from '@wukong/verification';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { createProgram, formatAllCommandsHelp } from '#/cli/commands';
import {
  WUKONG_MCP_TOOL_NAMES,
  createWukongMcpServer,
  redirectConsoleToStderr,
  type WukongMcpServerOptions,
} from '#/cli/lib/mcp-server';
import { handleMcp, registerMcpCommand, runStdioMcpServer } from '#/cli/sub/mcp';

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

function firstTextContent(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return undefined;
  }
  const { content } = result;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : undefined;
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

function makeSnapshot(cwd: string, overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  const git = overrides.git ?? makeGitInspection(cwd);
  return {
    id: 'snap-mcp-1234',
    cwd,
    headSha: 'abc12345',
    inputDigest: 'in-1',
    configDigest: 'cfg-1',
    planDigest: 'plan-1',
    ...overrides,
    git,
  };
}

function makePassingProof(cwd: string): ProofResult {
  return {
    status: 'passed',
    cwd,
    generatedAt: '2026-11-25T00:00:00.000Z',
    verification: {
      status: 'passed',
      cwd,
      generatedAt: '2026-11-25T00:00:00.000Z',
      changedFiles: [{ path: 'src/index.ts', status: 'M' }],
      gitStatus: ' M src/index.ts',
      diffStat: '1 file changed',
      selectedCommands: ['pnpm test'],
      commandResults: [
        {
          command: 'pnpm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 25,
          stdout: 'ok',
          stderr: '',
        },
      ],
      risks: [],
    },
    scan: {
      status: 'passed',
      cwd,
      generatedAt: '2026-11-25T00:00:00.000Z',
      changedFiles: [{ path: 'src/index.ts', status: 'M' }],
      gitStatus: ' M src/index.ts',
      diffStat: '1 file changed',
      risks: [],
    },
    summary: 'All checks passed.',
    recommendation: 'Safe to merge.',
    reasonCode: 'passed',
    snapshotId: 'snap-mcp-1234',
    workspaceFingerprint: { inputDigest: 'in-1', configDigest: 'cfg-1', headSha: 'abc12345' },
    blockers: [],
  };
}

async function withTempDirs<T>(
  fn: (dirs: { readonly workspaceDir: string; readonly homeDir: string }) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'wukong-mcp-ws-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'wukong-mcp-home-'));
  try {
    return await fn({ workspaceDir, homeDir });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function withLinkedClient<T>(
  options: WukongMcpServerOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWukongMcpServer(options);
  const client = new Client({ name: 'wukong-mcp-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

describe('wukong mcp command registration and help', () => {
  it('registers mcp under Advanced Commands without expanding default --help core list', async () => {
    const program = createProgram('1.2.3', () => {}, () => {});
    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toContain('mcp');

    const help = program.helpInformation();
    expect(help).not.toMatch(/^\s+mcp\s+/mu);

    const allHelp = formatAllCommandsHelp(program);
    expect(allHelp).toContain('Advanced Commands:');
    expect(allHelp).toMatch(/^\s+mcp(?:\s+\[options\])?\s+Run the built-in local MCP server over stdio/mu);

    const out: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeOut: (chunk) => out.push(chunk),
      writeErr: () => {},
    });
    await program.parseAsync(['node', 'wukong', 'help', 'mcp']);
    const mcpHelp = out.join('');
    expect(mcpHelp).toContain('--cwd <dir>');
    expect(mcpHelp).toContain('wukong_check');
    expect(mcpHelp).toContain('wukong_gate');
    expect(mcpHelp).toContain('wukong_summary');
  });
});

describe('createWukongMcpServer (InMemoryTransport E2E)', () => {
  it('lists exact tools and expected MCP tool annotations', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      await withLinkedClient(
        {
          defaultCwd: () => workspaceDir,
          homeDir: () => homeDir,
          version: '0.2.2-test',
        },
        async (client) => {
          const { tools } = await client.listTools();
          expect(tools.map((tool) => tool.name)).toEqual([...WUKONG_MCP_TOOL_NAMES]);

          const byName = new Map(tools.map((tool) => [tool.name, tool]));
          expect(byName.get('wukong_check')?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          });
          expect(byName.get('wukong_gate')?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          });
          expect(byName.get('wukong_summary')?.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          });
        },
      );
    });
  });

  it('runs wukong_check cleanly and keeps fullGatePass: false and reviewer: not_run', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      let seenWriteReport: boolean | undefined;
      let seenCwd: string | undefined;

      await withLinkedClient(
        {
          defaultCwd: () => workspaceDir,
          homeDir: () => homeDir,
          checkDeps: {
            runVerification: async (opts) => {
              seenWriteReport = opts.writeReport;
              seenCwd = opts.cwd;
              return {
                status: 'passed',
                cwd: opts.cwd ?? workspaceDir,
                generatedAt: '2026-11-25T00:00:00.000Z',
                changedFiles: [{ path: 'src/app.ts', status: 'M' }],
                gitStatus: ' M src/app.ts',
                diffStat: '1 file changed',
                selectedCommands: ['API_KEY=topsecret123 pnpm test'],
                commandResults: [
                  {
                    command: 'API_KEY=topsecret123 pnpm test',
                    status: 'passed',
                    exitCode: 0,
                    durationMs: 12,
                    stdout: 'ok',
                    stderr: '',
                  },
                ],
                risks: [],
              };
            },
          },
        },
        async (client) => {
          const result = await client.callTool({
            name: 'wukong_check',
            arguments: {},
          });

          expect(seenWriteReport).toBe(false);
          expect(seenCwd).toBe(workspaceDir);
          expect(Boolean(result.isError)).toBe(false);

          const structured = result.structuredContent as {
            status: string;
            reviewer: string;
            fullGatePass: boolean;
            checks: Array<{ command: string; outputExcerpt?: string }>;
          };
          expect(structured.status).toBe('passed');
          expect(structured.reviewer).toBe('not_run');
          expect(structured.fullGatePass).toBe(false);
          expect(structured.checks[0]?.command).not.toContain('topsecret123');
          expect(structured.checks[0]?.command).toContain('[REDACTED]');
          expect(structured.checks[0]?.outputExcerpt).toBeUndefined();
        },
      );
    });
  });

  it('sanitizes failing wukong_check outputExcerpt and risks without setting isError', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      await withLinkedClient(
        {
          defaultCwd: () => workspaceDir,
          homeDir: () => homeDir,
          checkDeps: {
            runVerification: async (opts) => ({
              status: 'failed',
              cwd: opts.cwd ?? workspaceDir,
              generatedAt: '2026-11-25T00:00:00.000Z',
              changedFiles: [],
              gitStatus: '',
              diffStat: '',
              selectedCommands: ['pnpm test'],
              commandResults: [
                {
                  command: 'pnpm test',
                  status: 'failed',
                  exitCode: 1,
                  durationMs: 30,
                  stdout: `Authorization: Bearer token123456789 in ${homeDir}/cache`,
                  stderr: 'Failure with api_key sk-secret-1234567890 at /Users/alice/dev/project/file.ts',
                },
              ],
              risks: [
                {
                  id: 'diff.debug_output_added',
                  severity: 'medium',
                  message: `Debug print referencing ${homeDir}/tmp and /Users/alice/secret.txt`,
                  file: '/Users/alice/dev/project/src/a.ts',
                  line: 4,
                },
              ],
            }),
          },
        },
        async (client) => {
          const result = await client.callTool({
            name: 'wukong_check',
            arguments: { cwd: workspaceDir, strict: true },
          });

          expect(Boolean(result.isError)).toBe(false);
          const structured = result.structuredContent as {
            status: string;
            checks: Array<{ outputExcerpt?: string }>;
            risks: Array<{ message: string; file?: string }>;
          };
          expect(structured.status).toBe('failed');
          const excerpt = structured.checks[0]?.outputExcerpt ?? '';
          expect(excerpt.length).toBeGreaterThan(0);
          expect(excerpt).not.toContain('sk-secret-1234567890');
          expect(excerpt).not.toContain('token123456789');
          expect(excerpt).not.toContain(homeDir);
          expect(excerpt).not.toContain('/Users/alice');

          const riskMsg = structured.risks[0]?.message ?? '';
          expect(riskMsg).not.toContain(homeDir);
          expect(riskMsg).not.toContain('/Users/alice');
          expect(structured.risks[0]?.file).not.toContain('/Users/alice');
        },
      );
    });
  });

  it('runs wukong_gate PASS and reads persisted Delivery Proof Card via wukong_summary', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const reviewerCalls: Array<{ reviewer?: string; objective?: string }> = [];

      await withLinkedClient(
        {
          defaultCwd: () => workspaceDir,
          homeDir: () => homeDir,
          gateDeps: {
            now: () => new Date('2026-11-25T10:00:00.000Z'),
            selectCommands: async () => [{ command: 'pnpm test', source: 'explicit' }],
            runProof: async () => makePassingProof(workspaceDir),
            createSnapshot: async () => makeSnapshot(workspaceDir),
            inspectGit: async () => makeGitInspection(workspaceDir),
            runReviewer: async (input) => {
              reviewerCalls.push({
                reviewer: input.reviewer,
                objective: input.userPrompt,
              });
              return {
                modelAlias: 'sonnet',
                providerId: 'cli:claude',
                text: JSON.stringify({
                  schemaVersion: 1,
                  status: 'PASS',
                  summary: `Verified change safely without exposing ${homeDir}.`,
                  findings: [],
                  uncoveredItems: [],
                }),
              };
            },
          },
          summaryDeps: {
            inspectGit: async () => makeGitInspection(workspaceDir, { diffText: '' }),
            createSnapshot: async () => makeSnapshot(workspaceDir, {
              git: makeGitInspection(workspaceDir, { diffText: '' }),
            }),
          },
        },
        async (client) => {
          const gateResult = await client.callTool({
            name: 'wukong_gate',
            arguments: {
              cwd: workspaceDir,
              objective: 'Add MCP stdio server',
              reviewer: 'claude',
              includeSummary: true,
            },
          });

          expect(Boolean(gateResult.isError)).toBe(false);
          expect(reviewerCalls).toHaveLength(1);
          expect(reviewerCalls[0]?.reviewer).toBe('claude');
          expect(reviewerCalls[0]?.objective).toContain('Add MCP stdio server');

          const gateStructured = gateResult.structuredContent as {
            runId: string;
            status: string;
            reviewer: { status: string; providerId?: string };
            summaryMarkdown?: string;
          };
          expect(gateStructured.status).toBe('PASS');
          expect(gateStructured.reviewer.status).toBe('passed');
          expect(gateStructured.reviewer.providerId).toBe('cli:claude');
          expect(gateStructured.summaryMarkdown).toContain('PASS');
          expect(gateStructured.summaryMarkdown).not.toContain(homeDir);

          const summaryResult = await client.callTool({
            name: 'wukong_summary',
            arguments: { cwd: workspaceDir, runId: gateStructured.runId },
          });

          expect(Boolean(summaryResult.isError)).toBe(false);
          const summaryText = firstTextContent(summaryResult);
          expect(summaryText).toContain(gateStructured.runId);

          const summaryStructured = summaryResult.structuredContent as {
            runId: string;
            status: string;
            stale: boolean;
            markdown: string;
          };
          expect(summaryStructured.runId).toBe(gateStructured.runId);
          expect(summaryStructured.status).toBe('PASS');
          expect(summaryStructured.stale).toBe(false);
          expect(summaryStructured.markdown).toContain('Delivery Proof Card');
        },
      );
    });
  });

  it('blocks wukong_gate deterministically without calling reviewer when proof fails', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      const runReviewer = vi.fn();

      await withLinkedClient(
        {
          defaultCwd: () => workspaceDir,
          homeDir: () => homeDir,
          gateDeps: {
            now: () => new Date('2026-11-25T10:00:00.000Z'),
            selectCommands: async () => [{ command: 'pnpm test', source: 'explicit' }],
            runProof: async () => ({
              ...makePassingProof(workspaceDir),
              status: 'blocked',
              verification: {
                ...makePassingProof(workspaceDir).verification,
                status: 'failed',
                commandResults: [
                  {
                    command: 'pnpm test',
                    status: 'failed',
                    exitCode: 1,
                    durationMs: 10,
                    stdout: '',
                    stderr: 'failed',
                  },
                ],
              },
              reasonCode: 'verification_failed',
            }),
            inspectGit: async () => makeGitInspection(workspaceDir, {
              changedFiles: [],
              statusText: '',
              diffStat: '',
              diffText: '',
            }),
            runReviewer,
          },
        },
        async (client) => {
          const result = await client.callTool({
            name: 'wukong_gate',
            arguments: { cwd: workspaceDir },
          });

          expect(Boolean(result.isError)).toBe(false);
          expect(runReviewer).not.toHaveBeenCalled();

          const structured = result.structuredContent as {
            status: string;
            reviewer: { status: string };
            nextSteps: string[];
          };
          expect(structured.status).toBe('NEEDS_WORK');
          expect(structured.reviewer.status).toBe('not_run');
          expect(structured.nextSteps.length).toBeGreaterThan(0);
        },
      );
    });
  });

  it('returns tool error for wukong_summary when no prior run exists and on invalid cwd', async () => {
    await withTempDirs(async ({ workspaceDir, homeDir }) => {
      await withLinkedClient(
        {
          defaultCwd: () => workspaceDir,
          homeDir: () => homeDir,
        },
        async (client) => {
          const emptySummary = await client.callTool({
            name: 'wukong_summary',
            arguments: { cwd: workspaceDir },
          });
          expect(emptySummary.isError).toBe(true);
          expect(firstTextContent(emptySummary)).toContain('wukong gate');

          const missingDir = join(homeDir, 'does-not-exist-subdir');
          for (const toolName of WUKONG_MCP_TOOL_NAMES) {
            const invalidRes = await client.callTool({
              name: toolName,
              arguments: { cwd: missingDir },
            });
            expect(invalidRes.isError).toBe(true);
            const errorText = firstTextContent(invalidRes);
            expect(errorText).toContain('does not exist');
            expect(errorText).not.toContain(homeDir);
          }
        },
      );
    });
  });
});

describe('stdout protection and runStdioMcpServer', () => {
  it('redirects console.log/info/warn/debug to stderr and restores idempotently', () => {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    const errBuf = writable();

    const restore = redirectConsoleToStderr(errBuf.writer);
    try {
      console.log('log-line');
      console.info('info-line');
      console.warn('warn-line');
      console.debug('debug-line');
    } finally {
      restore();
      restore();
    }

    expect(console.log).toBe(originalLog);
    expect(console.info).toBe(originalInfo);
    expect(console.warn).toBe(originalWarn);
    expect(console.debug).toBe(originalDebug);
    const joined = errBuf.chunks.join('');
    expect(joined).toContain('log-line');
    expect(joined).toContain('info-line');
    expect(joined).toContain('warn-line');
    expect(joined).toContain('debug-line');
  });

  it('serves MCP JSON-RPC initialize and tools/list over stdio while keeping console.log off stdout', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const errBuf = writable();
      const stdoutChunks: string[] = [];
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => {
        stdoutChunks.push(chunk);
      });

      const originalLog = console.log;
      const serverPromise = runStdioMcpServer({
        defaultCwd: workspaceDir,
        stdin,
        stdout,
        stderr: errBuf.writer,
      });

      expect(console.log).not.toBe(originalLog);
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'stdio-test', version: '1.0.0' },
          },
        })}\n`,
      );

      await vi.waitFor(() => {
        expect(stdoutChunks.join('')).toContain('"id":1');
      });

      console.log('rogue log leak check');
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);

      await vi.waitFor(() => {
        expect(stdoutChunks.join('')).toContain('"id":2');
      });

      stdin.end();
      await serverPromise;

      expect(console.log).toBe(originalLog);
      expect(errBuf.chunks.join('')).toContain('rogue log leak check');

      const outText = stdoutChunks.join('');
      expect(outText).not.toContain('rogue log leak check');
      const messages = outText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } });
      const listResponse = messages.find((msg) => msg.id === 2);
      expect(listResponse?.result?.tools?.map((tool) => tool.name)).toEqual([
        ...WUKONG_MCP_TOOL_NAMES,
      ]);
    });
  });

  it('rejects non-existent --cwd and forwards valid --cwd via handleMcp and registerMcpCommand', async () => {
    await withTempDirs(async ({ workspaceDir }) => {
      const missingDir = join(workspaceDir, 'missing');
      const stderr = writable();
      const runServer = vi.fn(async () => {});

      const badCode = await handleMcp(
        {
          cwd: () => workspaceDir,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: stderr.writer,
          runServer,
        },
        { cwd: missingDir },
      );

      expect(badCode).toBe(1);
      expect(stderr.chunks.join('')).toContain('error: --cwd must be an existing directory.');
      expect(runServer).not.toHaveBeenCalled();

      const okCode = await handleMcp(
        {
          cwd: () => '/fallback',
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: writable().writer,
          runServer,
        },
        { cwd: workspaceDir },
      );
      expect(okCode).toBe(0);
      expect(runServer).toHaveBeenCalledWith(
        expect.objectContaining({ defaultCwd: workspaceDir }),
      );

      const cmdErr = writable();
      const cliRunServer = vi.fn(async () => {});
      const program = new Command();
      program.exitOverride();
      registerMcpCommand(program, {
        cwd: () => workspaceDir,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: cmdErr.writer,
        runServer: cliRunServer,
      });

      const prevExitCode = process.exitCode;
      try {
        process.exitCode = undefined;
        await program.parseAsync(['mcp', '--cwd', missingDir], { from: 'user' });
        expect(process.exitCode).toBe(1);
        expect(cmdErr.chunks.join('')).toContain('--cwd must be an existing directory');

        process.exitCode = undefined;
        await program.parseAsync(['mcp', '--cwd', workspaceDir], { from: 'user' });
        expect(process.exitCode).toBeUndefined();
        expect(cliRunServer).toHaveBeenCalledWith(
          expect.objectContaining({ defaultCwd: workspaceDir }),
        );
      } finally {
        process.exitCode = prevExitCode;
      }
    });
  });
});
