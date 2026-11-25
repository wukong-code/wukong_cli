import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CLI_REVIEWER_BACKENDS = ['claude', 'codex', 'gemini'] as const;

export type CliReviewerBackend = (typeof CLI_REVIEWER_BACKENDS)[number];

export type CliReviewerErrorCode =
  | 'cli_reviewer_not_found'
  | 'cli_reviewer_auth_failed'
  | 'cli_reviewer_error';

export interface CliReviewerAvailability {
  readonly backend: CliReviewerBackend;
  readonly binary: string;
  readonly installed: boolean;
  readonly resolvedPath?: string;
}

export interface CliReviewerProbeResult {
  readonly backend: CliReviewerBackend;
  readonly status: 'ok' | 'not-found' | 'timeout' | 'offline';
  readonly latencyMs: number;
  readonly version?: string;
  readonly message: string;
}

export interface CliReviewerInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly outputFilePath?: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CliExecInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxStdoutChars?: number;
  readonly maxStderrChars?: number;
}

export interface CliExecOutput {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type CliExecImpl = (input: CliExecInput) => Promise<CliExecOutput>;

export interface CliReviewCompletionOptions {
  readonly backend: CliReviewerBackend;
  readonly model?: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly execImpl?: CliExecImpl;
}

export interface CliReviewCompletionResult {
  readonly modelAlias: string;
  readonly providerId: string;
  readonly text: string;
  readonly finishReason: string | null;
}

export class CliReviewerError extends Error {
  readonly code: CliReviewerErrorCode;

  constructor(code: CliReviewerErrorCode, message: string) {
    super(message);
    this.name = 'CliReviewerError';
    this.code = code;
  }
}

const DEFAULT_CLI_REVIEW_TIMEOUT_MS = 90_000;
const DEFAULT_CLI_PROBE_TIMEOUT_MS = 5_000;
const MAX_REVIEW_STDOUT_CHARS = 128_000;
const MAX_REVIEW_STDERR_CHARS = 16_000;
const MAX_DETAIL_CHARS = 240;

const AUTH_FAILURE_PATTERN =
  /not logged in|login required|authentication failed|unauthorized|invalid api key|please log in|auth login|setup-token|\b401\b/iu;

const SECRET_SCRUB_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /(https?:\/\/)[^/\s@:]+:[^/\s@]+@/giu, replacement: '$1[REDACTED]@' },
  {
    pattern: /([?&](?:token|key|api_key|apikey|access_token|secret|password)=)[^&#\s'"]+/giu,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /\b(?:sk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{6,}\b/gu,
    replacement: '[REDACTED]',
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{16,}\b/gu, replacement: '[REDACTED]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/giu, replacement: 'Bearer [REDACTED]' },
  {
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{4,}['"]?/giu,
    replacement: '[REDACTED]',
  },
];

export function isCliReviewerBackend(value: string): value is CliReviewerBackend {
  return (CLI_REVIEWER_BACKENDS as readonly string[]).includes(value);
}

/**
 * Parses a standalone CLI reviewer specifier (`claude` or `cli:claude`).
 */
export function parseCliReviewerSpecifier(value: string): CliReviewerBackend | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const candidate = normalized.startsWith('cli:') ? normalized.slice('cli:'.length) : normalized;
  return isCliReviewerBackend(candidate) ? candidate : undefined;
}

/**
 * Resolves an executable binary from PATH without shell expansion or fallback to process.env when env is given.
 */
export function resolveBinaryOnPath(
  binary: string,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const effectiveEnv = env ?? process.env;
  if (binary.includes('/') || binary.includes('\\')) {
    return isExecutableCandidate(binary, platform) ? binary : undefined;
  }

  const rawPath = effectiveEnv['PATH'] ?? effectiveEnv['Path'];
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return undefined;
  }

  const separator = platform === 'win32' ? ';' : ':';
  const dirs = rawPath
    .split(separator)
    .map((entry) => entry.trim().replaceAll(/^"+|"+$/gu, ''))
    .filter((entry) => entry.length > 0);

  const winExtensions = platform === 'win32'
    ? resolveWindowsExtensions(effectiveEnv)
    : [''];

  for (const dir of dirs) {
    for (const ext of winExtensions) {
      const hasExt = platform === 'win32' && /\.[a-z0-9]+$/iu.test(binary);
      const candidate = join(dir, ext.length > 0 && !hasExt ? `${binary}${ext}` : binary);
      if (isExecutableCandidate(candidate, platform)) {
        return candidate;
      }
      if (hasExt) break;
    }
  }

  return undefined;
}

export function detectLocalCliReviewers(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): readonly CliReviewerAvailability[] {
  const env = options?.env;
  const platform = options?.platform ?? process.platform;
  return CLI_REVIEWER_BACKENDS.map((backend) => {
    const resolvedPath = resolveBinaryOnPath(backend, env, platform);
    return {
      backend,
      binary: backend,
      installed: resolvedPath !== undefined,
      ...(resolvedPath === undefined ? {} : { resolvedPath }),
    };
  });
}

export function detectAvailableCliReviewer(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): CliReviewerAvailability | undefined {
  return detectLocalCliReviewers(options).find((entry) => entry.installed);
}

/**
 * Builds an isolated, read-only subprocess invocation for a local CLI reviewer backend.
 */
export function buildCliReviewerInvocation(
  backend: CliReviewerBackend,
  input: {
    readonly binary: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly model?: string;
    readonly outputFilePath?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): CliReviewerInvocation {
  const childEnv: NodeJS.ProcessEnv = { ...(input.env ?? process.env) };
  if (backend === 'claude') {
    // Allow nested invocation when wukong gate runs inside a Claude Code session or Stop hook.
    delete childEnv['CLAUDECODE'];
    delete childEnv['CLAUDE_CODE_ENTRYPOINT'];
  }

  const model = nonEmpty(input.model);

  switch (backend) {
    case 'claude': {
      const args: string[] = [
        '--print',
        '--output-format',
        'text',
        '--no-session-persistence',
        '--tools',
        '',
        '--disable-slash-commands',
        '--strict-mcp-config',
        '--permission-mode',
        'plan',
        '--system-prompt',
        input.systemPrompt,
      ];
      if (model !== undefined) {
        args.push('--model', model);
      }
      return {
        command: input.binary,
        args,
        stdin: input.userPrompt,
        env: childEnv,
      };
    }
    case 'codex': {
      const args: string[] = [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
      ];
      if (input.outputFilePath !== undefined) {
        args.push('-o', input.outputFilePath);
      }
      if (model !== undefined) {
        args.push('--model', model);
      }
      args.push('-');
      return {
        command: input.binary,
        args,
        stdin: `${input.systemPrompt}\n\n${input.userPrompt}`,
        ...(input.outputFilePath === undefined ? {} : { outputFilePath: input.outputFilePath }),
        env: childEnv,
      };
    }
    case 'gemini': {
      const args: string[] = [
        '--prompt',
        'Follow the instructions from stdin and emit the final GATE_VERDICT_JSON line.',
        '--output-format',
        'text',
        '--approval-mode',
        'plan',
      ];
      if (model !== undefined) {
        args.push('--model', model);
      }
      return {
        command: input.binary,
        args,
        stdin: `${input.systemPrompt}\n\n${input.userPrompt}`,
        env: childEnv,
      };
    }
  }
}

/**
 * Runs an isolated, zero-tool single-turn completion using a local coding agent CLI.
 */
export async function runCliReviewCompletion(
  options: CliReviewCompletionOptions,
): Promise<CliReviewCompletionResult> {
  const binary = options.binaryPath ?? resolveBinaryOnPath(options.backend, options.env);
  if (binary === undefined) {
    throw new CliReviewerError(
      'cli_reviewer_not_found',
      `Local CLI reviewer "${options.backend}" was not found on PATH. Install and sign in to ${options.backend}, or configure a provider via \`wukong provider catalog add <id>\`.`,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_REVIEW_TIMEOUT_MS;
  const execImpl = options.execImpl ?? runCliProcess;
  const tempDir = await mkdtemp(join(tmpdir(), 'wukong-cli-reviewer-'));

  try {
    const outputFilePath = options.backend === 'codex'
      ? join(tempDir, 'last-message.txt')
      : undefined;

    const invocation = buildCliReviewerInvocation(options.backend, {
      binary,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      model: options.model,
      outputFilePath,
      env: options.env,
    });

    const result = await execImpl({
      command: invocation.command,
      args: invocation.args,
      cwd: tempDir,
      env: invocation.env,
      stdin: invocation.stdin,
      timeoutMs,
      signal: options.signal,
      maxStdoutChars: MAX_REVIEW_STDOUT_CHARS,
      maxStderrChars: MAX_REVIEW_STDERR_CHARS,
    });

    if (result.timedOut) {
      const error = new Error(
        `Local CLI reviewer (${options.backend}) timed out after ${String(timeoutMs)}ms.`,
      );
      error.name = 'TimeoutError';
      throw error;
    }

    let outputText = result.stdout.trim();
    if (outputFilePath !== undefined) {
      try {
        const fileText = (await readFile(outputFilePath, 'utf8')).trim();
        if (fileText.length > 0) {
          outputText = fileText;
        }
      } catch {
        // Fall back to captured stdout when Codex did not write the -o file.
      }
    }

    if (result.exitCode !== 0) {
      const combined = `${result.stderr}\n${result.stdout}`.trim();
      if (AUTH_FAILURE_PATTERN.test(combined)) {
        throw new CliReviewerError(
          'cli_reviewer_auth_failed',
          `Local CLI reviewer "${options.backend}" is not authenticated. Sign in using the ${options.backend} CLI, then retry \`wukong gate\`.`,
        );
      }
      const detail = sanitizeCliReviewerText(combined);
      const suffix = detail.length > 0 ? `: ${detail}` : '.';
      throw new CliReviewerError(
        'cli_reviewer_error',
        `Local CLI reviewer "${options.backend}" exited with status ${String(result.exitCode ?? 'null')}${suffix}`,
      );
    }

    if (outputText.length === 0) {
      throw new CliReviewerError(
        'cli_reviewer_error',
        `Local CLI reviewer "${options.backend}" returned empty output.`,
      );
    }

    return {
      modelAlias: nonEmpty(options.model) ?? options.backend,
      providerId: `cli:${options.backend}`,
      text: outputText,
      finishReason: 'completed',
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Probes whether a local CLI reviewer binary is installed and responsive.
 */
export async function probeLocalCliReviewer(
  backend: CliReviewerBackend,
  options: {
    readonly timeoutMs?: number;
    readonly offline?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly binaryPath?: string;
    readonly execImpl?: CliExecImpl;
  } = {},
): Promise<CliReviewerProbeResult> {
  const env = options.env ?? process.env;
  if (isOfflineEnv(options.offline, env)) {
    return {
      backend,
      status: 'offline',
      latencyMs: 0,
      message: 'Offline mode enabled; skipped CLI probe.',
    };
  }

  const binary = options.binaryPath ?? resolveBinaryOnPath(backend, env);
  if (binary === undefined) {
    return {
      backend,
      status: 'not-found',
      latencyMs: 0,
      message: `Local CLI "${backend}" was not found on PATH.`,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_PROBE_TIMEOUT_MS;
  const execImpl = options.execImpl ?? runCliProcess;
  const tempDir = await mkdtemp(join(tmpdir(), 'wukong-cli-probe-'));
  const startedAt = Date.now();

  try {
    const result = await execImpl({
      command: binary,
      args: ['--version'],
      cwd: tempDir,
      env: { ...env },
      timeoutMs,
      maxStdoutChars: 4096,
      maxStderrChars: 4096,
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);

    if (result.timedOut) {
      return {
        backend,
        status: 'timeout',
        latencyMs,
        message: `Local CLI "${backend}" timed out after ${String(timeoutMs)}ms.`,
      };
    }

    if (result.exitCode === 0) {
      const versionLine = sanitizeCliReviewerText(
        result.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? '',
        80,
      );
      return {
        backend,
        status: 'ok',
        latencyMs,
        ...(versionLine.length > 0 ? { version: versionLine } : {}),
        message: versionLine.length > 0
          ? `Local CLI available (${versionLine}).`
          : 'Local CLI available.',
      };
    }

    const detail = sanitizeCliReviewerText(result.stderr || result.stdout, 120);
    return {
      backend,
      status: 'not-found',
      latencyMs,
      message: detail.length > 0
        ? `Local CLI "${backend}" check failed: ${detail}`
        : `Local CLI "${backend}" failed with exit code ${String(result.exitCode ?? 'null')}.`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function sanitizeCliReviewerText(raw: string, maxChars: number = MAX_DETAIL_CHARS): string {
  let output = raw;
  for (const { pattern, replacement } of SECRET_SCRUB_PATTERNS) {
    output = output.replaceAll(pattern, replacement);
  }
  output = output.replaceAll(/\/Users\/[^/\s'":,)\]]+/gu, '~');
  output = output.replaceAll(/\/home\/[^/\s'":,)\]]+/gu, '~');
  output = output.replaceAll(/[A-Za-z]:\\Users\\[^\\\s'":,)\]]+/gu, '~');
  const singleLine = output.replaceAll(/\s+/gu, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 3)}...`;
}

function runCliProcess(input: CliExecInput): Promise<CliExecOutput> {
  if (input.signal?.aborted === true) {
    return Promise.reject(createAbortError(input.signal));
  }

  const maxStdout = input.maxStdoutChars ?? MAX_REVIEW_STDOUT_CHARS;
  const maxStderr = input.maxStderrChars ?? MAX_REVIEW_STDERR_CHARS;

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let terminationStarted = false;

    const child = spawn(input.command, [...input.args], {
      cwd: resolve(input.cwd),
      env: input.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    function killSubtree(signal: NodeJS.Signals): void {
      try {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', () => {});
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Process already exited.
        }
      }
    }

    function beginTermination(): void {
      if (terminationStarted) return;
      terminationStarted = true;
      killSubtree('SIGTERM');
      const killTimer = setTimeout(() => {
        killSubtree('SIGKILL');
      }, 1500);
      killTimer.unref?.();
    }

    function clearTimers(): void {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }

    function onAbort(): void {
      if (settled) return;
      settled = true;
      clearTimers();
      beginTermination();
      rejectPromise(createAbortError(input.signal));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, input.timeoutMs);

    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdin?.on('error', () => {});
    child.stdin?.end(input.stdin ?? '', 'utf8');

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'), maxStdout);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'), maxStderr);
    });
    child.on('error', (error) => {
      if (settled) {
        clearTimers();
        return;
      }
      settled = true;
      clearTimers();
      resolvePromise({
        exitCode: 1,
        timedOut,
        stdout,
        stderr: appendBounded(stderr, error.message, maxStderr),
      });
    });
    child.on('close', (code) => {
      if (settled) {
        clearTimers();
        return;
      }
      settled = true;
      clearTimers();
      resolvePromise({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    const reason = signal.reason;
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message);
    err.name = 'AbortError';
    return err;
  }
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function appendBounded(current: string, next: string, limit: number): string {
  const combined = current + next;
  if (combined.length <= limit) return combined;
  return combined.slice(0, limit);
}

function resolveWindowsExtensions(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM';
  const list = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  return list.length > 0 ? list : ['.EXE', '.CMD', '.BAT', '.COM'];
}

function isExecutableCandidate(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function isOfflineEnv(explicitOffline: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return (
    explicitOffline === true
    || env['WUKONG_OFFLINE'] === '1'
    || env['WUKONG_CODE_OFFLINE'] === '1'
    || env['WUKONG_CODE_CATALOG_OFFLINE'] === '1'
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
