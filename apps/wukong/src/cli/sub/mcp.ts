import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Command } from 'commander';

import { createWukongMcpServer, redirectConsoleToStderr } from '#/cli/lib/mcp-server';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface McpCliOptions {
  readonly cwd?: string;
}

export interface McpServerRunOptions {
  readonly defaultCwd: string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: WritableLike;
}

export interface McpCommandDeps {
  readonly cwd: () => string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: WritableLike;
  readonly runServer: (options: McpServerRunOptions) => Promise<void>;
}

/**
 * Run the built-in Wukong MCP server over stdio until the transport closes,
 * stdin reaches EOF, or a termination signal arrives.
 */
export async function runStdioMcpServer(options: McpServerRunOptions): Promise<void> {
  const restoreConsole = redirectConsoleToStderr(options.stderr);
  const server = createWukongMcpServer({
    defaultCwd: () => options.defaultCwd,
  });
  const transport = new StdioServerTransport(
    options.stdin as Readable,
    options.stdout as Writable,
  );
  const attachSignals = options.stdin === process.stdin;

  let cleanup: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolveClosed) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveClosed();
    };

    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      prevOnClose?.();
      finish();
    };

    const onEnd = (): void => finish();
    const onSig = (): void => finish();

    options.stdin.once('end', onEnd);
    options.stdin.once('close', onEnd);
    if (attachSignals) {
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
    }

    cleanup = () => {
      options.stdin.off('end', onEnd);
      options.stdin.off('close', onEnd);
      if (attachSignals) {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      }
    };
  });

  try {
    await server.connect(transport);
    await closedPromise;
  } finally {
    cleanup?.();
    await server.close().catch(() => {});
    restoreConsole();
  }
}

export async function handleMcp(
  deps: McpCommandDeps,
  options: McpCliOptions,
): Promise<number> {
  const defaultCwd = resolve(options.cwd ?? deps.cwd());
  if (options.cwd !== undefined) {
    try {
      const info = await stat(defaultCwd);
      if (!info.isDirectory()) {
        deps.stderr.write('error: --cwd must be an existing directory.\n');
        return 1;
      }
    } catch {
      deps.stderr.write('error: --cwd must be an existing directory.\n');
      return 1;
    }
  }

  try {
    await deps.runServer({
      defaultCwd,
      stdin: deps.stdin,
      stdout: deps.stdout,
      stderr: deps.stderr,
    });
    return 0;
  } catch (error) {
    deps.stderr.write(`wukong mcp failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

export function registerMcpCommand(parent: Command, deps?: Partial<McpCommandDeps>): void {
  parent
    .command('mcp')
    .description(
      'Run the built-in local MCP server over stdio (wukong_check, wukong_gate, wukong_summary).',
    )
    .option('--cwd <dir>', 'Default workspace directory when a tool call omits cwd.')
    .action(async (raw: { cwd?: string }) => {
      const code = await handleMcp(resolveMcpDeps(deps), { cwd: raw.cwd });
      if (code !== 0) process.exitCode = code;
    });
}

function resolveMcpDeps(overrides: Partial<McpCommandDeps> = {}): McpCommandDeps {
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdin: overrides.stdin ?? process.stdin,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    runServer: overrides.runServer ?? runStdioMcpServer,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
