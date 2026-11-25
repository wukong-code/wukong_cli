import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  redactCommand,
  renderDeliveryProofCard,
  type GateRunRecord,
} from '@wukong/verification';
import { resolveWukongHome, sanitizeCliReviewerText } from '@wukong/wukong-sdk';
import { z } from 'zod';

import {
  handleCheck,
  resolveCheckDeps,
  type CheckDeps,
  type CheckResult,
} from '#/cli/sub/check';
import {
  GATE_REVIEWER_BACKENDS,
  handleGate,
  resolveGateDeps,
  type GateDeps,
} from '#/cli/sub/gate';
import {
  handleSummary,
  resolveSummaryDeps,
  type SummaryDeps,
  type SummaryResult,
} from '#/cli/sub/summary';
import { getVersion } from '#/cli/version';

export const WUKONG_MCP_SERVER_NAME = 'wukong-code';

export const WUKONG_MCP_TOOL_NAMES = [
  'wukong_check',
  'wukong_gate',
  'wukong_summary',
] as const;

export interface WukongMcpServerOptions {
  readonly defaultCwd?: () => string;
  readonly homeDir?: () => string | undefined;
  readonly version?: string;
  readonly checkDeps?: Partial<CheckDeps>;
  readonly gateDeps?: Partial<GateDeps>;
  readonly summaryDeps?: Partial<SummaryDeps>;
}

export interface McpCheckCommandSummary {
  readonly command: string;
  readonly status: CheckResult['commandResults'][number]['status'];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputExcerpt?: string;
}

export interface McpCheckPayload {
  readonly status: CheckResult['status'];
  readonly reviewer: 'not_run';
  readonly fullGatePass: false;
  readonly changedFiles: CheckResult['changedFiles'];
  readonly checks: readonly McpCheckCommandSummary[];
  readonly risks: readonly {
    readonly id: string;
    readonly severity: CheckResult['risks'][number]['severity'];
    readonly message: string;
    readonly file?: string;
    readonly line?: number;
  }[];
  readonly nextStep: string;
}

export type McpGatePayload = GateRunRecord & {
  readonly summaryMarkdown?: string;
};

export interface McpSummaryPayload {
  readonly runId: string;
  readonly status: GateRunRecord['status'];
  readonly stale: boolean;
  readonly record: GateRunRecord;
  readonly markdown: string;
}

interface WritableLike {
  write(chunk: string): boolean;
}

interface SavedConsole {
  readonly log: (...args: unknown[]) => void;
  readonly info: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
  readonly debug: (...args: unknown[]) => void;
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Redirect stdout-targeting console methods (`log`, `info`, `warn`, `debug`)
 * to `stderr` so MCP JSON-RPC traffic on `stdout` cannot be corrupted.
 */
export function redirectConsoleToStderr(stderr: WritableLike = process.stderr): () => void {
  const saved: SavedConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
  };

  const writeStderr = (...args: unknown[]): void => {
    stderr.write(`${args.map(formatConsoleArg).join(' ')}\n`);
  };

  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;
  console.debug = writeStderr;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    console.log = saved.log;
    console.info = saved.info;
    console.warn = saved.warn;
    console.debug = saved.debug;
  };
}

function sanitizeMcpText(raw: string, homeDir?: string, maxChars: number = 1500): string {
  let output = raw;
  const normalizedHome = homeDir?.trim().replace(/[\\/]+$/u, '');
  if (normalizedHome !== undefined && normalizedHome.length > 0) {
    output = output.replaceAll(normalizedHome, '~');
  }
  return sanitizeCliReviewerText(output, maxChars);
}

function sanitizeCommandExcerpt(
  stderr: string,
  stdout: string,
  homeDir?: string,
): string | undefined {
  const parts = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const joined = parts.join('\n');
  const tail = joined.length > 3000 ? joined.slice(-3000) : joined;
  return sanitizeMcpText(tail, homeDir, 1500);
}

async function resolveValidatedWorkspaceDir(
  inputCwd: string | undefined,
  defaultCwd: string,
  homeDir: string | undefined,
): Promise<
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly message: string }
> {
  const target = resolve(inputCwd ?? defaultCwd);
  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      return {
        ok: false,
        message: sanitizeMcpText(
          `Workspace directory does not exist or is not a directory: ${target}`,
          homeDir,
        ),
      };
    }
    return { ok: true, cwd: target };
  } catch {
    return {
      ok: false,
      message: sanitizeMcpText(
        `Workspace directory does not exist or is not a directory: ${target}`,
        homeDir,
      ),
    };
  }
}

function createBufferedWriter(): {
  readonly writer: WritableLike;
  text(): string;
} {
  const chunks: string[] = [];
  return {
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

function toolError(message: string, homeDir?: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: sanitizeMcpText(message, homeDir),
      },
    ],
  };
}

/**
 * Create a local MCP server exposing Wukong deterministic checks, delivery gate,
 * and sanitized proof card summary tools.
 */
export function createWukongMcpServer(options: WukongMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: WUKONG_MCP_SERVER_NAME,
    version: options.version ?? getVersion(),
  });
  const getDefaultCwd = options.defaultCwd ?? (() => process.cwd());
  const getHomeDir = options.homeDir ?? (() => resolveWukongHome());

  server.registerTool(
    'wukong_check',
    {
      title: 'Wukong Deterministic Check',
      description:
        'Run offline deterministic project checks and risk scan (zero model calls). Always reports reviewer: "not_run" and fullGatePass: false; deterministic checks never substitute for a full wukong_gate PASS.',
      annotations: {
        title: 'Wukong Deterministic Check',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        cwd: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Workspace directory to check. Defaults to the MCP server working directory.'),
        commands: z
          .array(z.string().trim().min(1))
          .optional()
          .describe('Explicit check commands to run instead of auto-discovered checks.'),
        includeBuild: z
          .boolean()
          .optional()
          .describe('Include package build script when auto-detecting checks.'),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Per-command timeout in seconds.'),
        strict: z
          .boolean()
          .optional()
          .describe('Treat any risk (including medium and low) as a failed check.'),
      },
    },
    async (args) => {
      const homeDir = getHomeDir();
      const target = await resolveValidatedWorkspaceDir(args.cwd, getDefaultCwd(), homeDir);
      if (!target.ok) {
        return toolError(target.message, homeDir);
      }

      const stdoutBuf = createBufferedWriter();
      const stderrBuf = createBufferedWriter();
      let captured: CheckResult | undefined;

      const resolvedDeps = resolveCheckDeps({
        ...options.checkDeps,
        cwd: () => target.cwd,
        stdout: stdoutBuf.writer,
        stderr: stderrBuf.writer,
        onResult: (result) => {
          captured = result;
          options.checkDeps?.onResult?.(result);
        },
      });

      const exitCode = await handleCheck(resolvedDeps, {
        cwd: target.cwd,
        commands: args.commands,
        includeBuild: args.includeBuild === true,
        timeoutSeconds: args.timeoutSeconds,
        strict: args.strict === true,
        json: true,
      });

      if (exitCode === 2 || captured === undefined) {
        return toolError(
          stderrBuf.text().trim() || 'wukong_check failed unexpectedly.',
          homeDir,
        );
      }

      const payload: McpCheckPayload = {
        status: captured.status,
        reviewer: captured.reviewer,
        fullGatePass: captured.fullGatePass,
        changedFiles: captured.changedFiles.map((file) => ({
          ...file,
          path: sanitizeMcpText(file.path, homeDir, 300),
        })),
        checks: captured.commandResults.map((command) => {
          const excerpt =
            command.status === 'passed'
              ? undefined
              : sanitizeCommandExcerpt(command.stderr, command.stdout, homeDir);
          return {
            command: sanitizeMcpText(redactCommand(command.command), homeDir, 500),
            status: command.status,
            exitCode: command.exitCode,
            durationMs: command.durationMs,
            ...(excerpt === undefined ? {} : { outputExcerpt: excerpt }),
          };
        }),
        risks: captured.risks.map((risk) => ({
          id: risk.id,
          severity: risk.severity,
          message: sanitizeMcpText(risk.message, homeDir, 500),
          ...(risk.file === undefined ? {} : { file: sanitizeMcpText(risk.file, homeDir, 300) }),
          ...(risk.line === undefined ? {} : { line: risk.line }),
        })),
        nextStep: sanitizeMcpText(captured.nextStep, homeDir, 500),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'wukong_gate',
    {
      title: 'Wukong Delivery Gate',
      description:
        'Run standalone deterministic verification, risk scan, and fresh-context independent review (PASS / NEEDS_WORK / ERROR). Deterministic failures cannot be overridden by AI review. Persists a sanitized run record for wukong_summary.',
      annotations: {
        title: 'Wukong Delivery Gate',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        cwd: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Workspace directory to verify. Defaults to the MCP server working directory.'),
        objective: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional task objective for independent review.'),
        reviewer: z
          .enum(GATE_REVIEWER_BACKENDS)
          .optional()
          .describe('Reviewer backend: auto, provider, claude, codex, or gemini. Defaults to auto.'),
        model: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional reviewer model alias override.'),
        commands: z
          .array(z.string().trim().min(1))
          .optional()
          .describe('Explicit check commands to run instead of auto-discovered checks.'),
        includeBuild: z
          .boolean()
          .optional()
          .describe('Include package build script when auto-detecting checks.'),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Per-command timeout in seconds.'),
        reviewTimeoutSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Independent reviewer timeout in seconds.'),
        strict: z
          .boolean()
          .optional()
          .describe('Block on any risk, including medium and low.'),
        includeSummary: z
          .boolean()
          .optional()
          .describe('Include a sanitized PR-ready Markdown Delivery Proof Card in summaryMarkdown.'),
      },
    },
    async (args) => {
      const homeDir = getHomeDir();
      const target = await resolveValidatedWorkspaceDir(args.cwd, getDefaultCwd(), homeDir);
      if (!target.ok) {
        return toolError(target.message, homeDir);
      }

      const stdoutBuf = createBufferedWriter();
      const stderrBuf = createBufferedWriter();
      let captured: GateRunRecord | undefined;

      const resolvedDeps = resolveGateDeps({
        ...options.gateDeps,
        cwd: () => target.cwd,
        homeDir: getHomeDir,
        stdout: stdoutBuf.writer,
        stderr: stderrBuf.writer,
        onResult: (record) => {
          captured = record;
          options.gateDeps?.onResult?.(record);
        },
      });

      await handleGate(resolvedDeps, {
        cwd: target.cwd,
        objective: args.objective,
        reviewer: args.reviewer,
        model: args.model,
        commands: args.commands,
        includeBuild: args.includeBuild === true,
        timeoutSeconds: args.timeoutSeconds,
        reviewTimeoutSeconds: args.reviewTimeoutSeconds,
        strict: args.strict === true,
        json: true,
      });

      if (captured === undefined) {
        return toolError(
          stderrBuf.text().trim() || 'wukong_gate failed before producing a verdict.',
          homeDir,
        );
      }

      const payload: McpGatePayload = {
        ...captured,
        ...(args.includeSummary === true
          ? { summaryMarkdown: renderDeliveryProofCard(captured, { homeDir }) }
          : {}),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'wukong_summary',
    {
      title: 'Wukong Delivery Proof Card',
      description:
        'Render a sanitized, PR-ready Markdown Delivery Proof Card from the latest (or specified) gate or loop run for the workspace. Read-only.',
      annotations: {
        title: 'Wukong Delivery Proof Card',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        cwd: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Workspace directory to summarize. Defaults to the MCP server working directory.'),
        runId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional gate or loop run ID. Defaults to the most recent run for this workspace.'),
      },
    },
    async (args) => {
      const homeDir = getHomeDir();
      const target = await resolveValidatedWorkspaceDir(args.cwd, getDefaultCwd(), homeDir);
      if (!target.ok) {
        return toolError(target.message, homeDir);
      }

      const stdoutBuf = createBufferedWriter();
      const stderrBuf = createBufferedWriter();
      let captured: SummaryResult | undefined;

      const resolvedDeps = resolveSummaryDeps({
        ...options.summaryDeps,
        cwd: () => target.cwd,
        homeDir: getHomeDir,
        stdout: stdoutBuf.writer,
        stderr: stderrBuf.writer,
        onResult: (result) => {
          captured = result;
          options.summaryDeps?.onResult?.(result);
        },
      });

      const exitCode = await handleSummary(resolvedDeps, {
        cwd: target.cwd,
        runId: args.runId,
        json: true,
      });

      if (exitCode !== 0 || captured === undefined) {
        return toolError(
          stderrBuf.text().trim() || 'No gate or loop runs found for this workspace. Run wukong_gate first.',
          homeDir,
        );
      }

      const payload: McpSummaryPayload = {
        runId: captured.record.runId,
        status: captured.record.status,
        stale: captured.stale,
        record: captured.record,
        markdown: captured.markdown,
      };

      return {
        content: [
          {
            type: 'text',
            text: captured.markdown,
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
