import { resolve } from 'node:path';

import {
  inspectGit,
  redactCommand,
  type GateRunRecord,
} from '@wukong/verification';
import { sanitizeCliReviewerText } from '@wukong/wukong-sdk';

import type { IntegrateHookMode } from '#/cli/lib/integrate';
import {
  handleCheck,
  resolveCheckDeps,
  type CheckDeps,
  type CheckResult,
} from '#/cli/sub/check';
import {
  handleGate,
  resolveGateDeps,
  type GateDeps,
  type GateReviewerBackend,
} from '#/cli/sub/gate';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ClaudeStopHookInput {
  readonly stop_hook_active?: boolean;
  readonly cwd?: string;
  readonly session_id?: string;
  readonly hook_event_name?: string;
}

export interface ClaudeStopHookBlockOutput {
  readonly decision: 'block';
  readonly reason: string;
}

export interface ClaudeStopHookOptions {
  readonly cwd?: string;
  readonly mode?: IntegrateHookMode;
  readonly reviewer?: GateReviewerBackend;
  readonly strict?: boolean;
  readonly always?: boolean;
}

export interface ClaudeStopHookDeps {
  readonly cwd: () => string;
  readonly homeDir: () => string | undefined;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly inspectGit: typeof inspectGit;
  readonly checkDeps?: Partial<CheckDeps>;
  readonly gateDeps?: Partial<GateDeps>;
}

const MAX_HOOK_STDIN_BYTES = 256 * 1024;
const MAX_FINDINGS_IN_REASON = 10;

export function parseClaudeStopHookStdin(raw: string): ClaudeStopHookInput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const cwd = typeof obj['cwd'] === 'string' && obj['cwd'].trim().length > 0
    ? obj['cwd'].trim()
    : undefined;

  return {
    ...(typeof obj['stop_hook_active'] === 'boolean'
      ? { stop_hook_active: obj['stop_hook_active'] }
      : {}),
    ...(cwd === undefined ? {} : { cwd }),
    ...(typeof obj['session_id'] === 'string' ? { session_id: obj['session_id'] } : {}),
    ...(typeof obj['hook_event_name'] === 'string'
      ? { hook_event_name: obj['hook_event_name'] }
      : {}),
  };
}

export async function readStreamText(stdin: NodeJS.ReadableStream): Promise<string> {
  if ((stdin as { readonly isTTY?: boolean }).isTTY === true) {
    return '';
  }

  return new Promise<string>((resolveText) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      resolveText(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (totalBytes >= MAX_HOOK_STDIN_BYTES) {
        return;
      }
      const remaining = MAX_HOOK_STDIN_BYTES - totalBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      chunks.push(slice);
      totalBytes += slice.length;
    };

    const onEnd = (): void => finish();
    const onError = (): void => finish();

    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
  });
}

export function formatGateBlockReason(record: GateRunRecord): string {
  const lines: string[] = [
    `Wukong gate returned ${record.status} (${record.reasonCode}): ${record.summary}`,
  ];

  const failedChecks = record.checks.filter((check) => check.status !== 'passed');
  if (failedChecks.length > 0) {
    lines.push('', 'Failed checks:');
    for (const check of failedChecks) {
      lines.push(
        `- ${check.command} (${check.status}, exit ${String(check.exitCode ?? 'null')})`,
      );
    }
  }

  if (record.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of record.risks) {
      const location = formatLocation(risk.file, risk.line);
      lines.push(`- [${risk.severity}] ${risk.message}${location}`);
    }
  }

  if (record.findings.length > 0) {
    lines.push('', 'Reviewer findings:');
    for (const finding of record.findings.slice(0, MAX_FINDINGS_IN_REASON)) {
      const location = formatLocation(finding.file, finding.line);
      lines.push(
        `- [${finding.severity}] ${finding.message}${location} — Next: ${finding.nextAction}`,
      );
    }
  }

  if (record.reviewer.status === 'error') {
    const detail =
      record.reviewer.errorMessage ?? record.reviewer.errorCode ?? 'error';
    lines.push('', `Reviewer error: ${detail}`);
  }

  if (record.nextSteps.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of record.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push('', `Run ID: ${record.runId}`);
  return lines.join('\n');
}

export function formatCheckBlockReason(
  result: CheckResult,
  homeDir?: string,
): string {
  const lines: string[] = [
    `Wukong check returned ${result.status} (deterministic checks blocked completion):`,
  ];

  const failedChecks = result.commandResults.filter(
    (command) => command.status !== 'passed',
  );
  if (failedChecks.length > 0) {
    lines.push('', 'Failed checks:');
    for (const command of failedChecks) {
      const safeCommand = sanitizeHookText(redactCommand(command.command), homeDir, 400);
      lines.push(
        `- ${safeCommand} (${command.status}, exit ${String(command.exitCode ?? 'null')})`,
      );
    }
  }

  if (result.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of result.risks) {
      const safeFile =
        risk.file === undefined ? undefined : sanitizeHookText(risk.file, homeDir, 300);
      const location = formatLocation(safeFile, risk.line);
      const safeMessage = sanitizeHookText(risk.message, homeDir, 400);
      lines.push(`- [${risk.severity}] ${safeMessage}${location}`);
    }
  }

  lines.push('', `Next: ${sanitizeHookText(result.nextStep, homeDir, 400)}`);
  return lines.join('\n');
}

export async function runClaudeStopHook(
  deps: ClaudeStopHookDeps,
  options: ClaudeStopHookOptions = {},
): Promise<number> {
  const rawStdin = await readStreamText(deps.stdin);
  const payload = parseClaudeStopHookStdin(rawStdin);
  if (payload.stop_hook_active === true) {
    return 0;
  }

  const homeDir = deps.homeDir();
  const targetCwd = resolve(payload.cwd ?? options.cwd ?? deps.cwd());

  if (options.always !== true) {
    try {
      const git = await deps.inspectGit(targetCwd);
      if (git.isRepo && git.changedFiles.length === 0) {
        return 0;
      }
    } catch {
      // Fall through so handleCheck/handleGate surfaces directory or workspace failures.
    }
  }

  const bufOut = createBufferedWriter();
  const bufErr = createBufferedWriter();
  const mode = options.mode ?? 'gate';

  if (mode === 'check') {
    let capturedCheck: CheckResult | undefined;
    const checkDeps = resolveCheckDeps({
      ...deps.checkDeps,
      cwd: () => targetCwd,
      stdout: bufOut.writer,
      stderr: bufErr.writer,
      onResult: (result) => {
        capturedCheck = result;
        deps.checkDeps?.onResult?.(result);
      },
    });

    await handleCheck(checkDeps, {
      cwd: targetCwd,
      strict: options.strict === true,
      json: true,
    });

    if (capturedCheck !== undefined && capturedCheck.status !== 'failed') {
      return 0;
    }

    const reason =
      capturedCheck === undefined
        ? sanitizeHookText(
            bufErr.text().trim() || 'Wukong check failed unexpectedly.',
            homeDir,
            1500,
          )
        : formatCheckBlockReason(capturedCheck, homeDir);

    emitBlockDecision(deps.stdout, reason);
    return 0;
  }

  let capturedGate: GateRunRecord | undefined;
  const gateDeps = resolveGateDeps({
    ...deps.gateDeps,
    cwd: () => targetCwd,
    homeDir: deps.homeDir,
    stdout: bufOut.writer,
    stderr: bufErr.writer,
    onResult: (record) => {
      capturedGate = record;
      deps.gateDeps?.onResult?.(record);
    },
  });

  await handleGate(gateDeps, {
    cwd: targetCwd,
    reviewer: options.reviewer,
    strict: options.strict === true,
    json: true,
  });

  if (capturedGate !== undefined && capturedGate.status === 'PASS') {
    return 0;
  }

  const reason =
    capturedGate === undefined
      ? sanitizeHookText(
          bufErr.text().trim() || 'Wukong gate failed before producing a verdict.',
          homeDir,
          1500,
        )
      : formatGateBlockReason(capturedGate);

  emitBlockDecision(deps.stdout, reason);
  return 0;
}

function emitBlockDecision(stdout: WritableLike, reason: string): void {
  const output: ClaudeStopHookBlockOutput = {
    decision: 'block',
    reason,
  };
  stdout.write(`${JSON.stringify(output)}\n`);
}

function formatLocation(file: string | undefined, line: number | undefined): string {
  if (file === undefined) return '';
  return ` (${file}${line === undefined ? '' : `:${String(line)}`})`;
}

function sanitizeHookText(
  raw: string,
  homeDir: string | undefined,
  maxChars: number = 1500,
): string {
  let output = raw;
  const normalizedHome = homeDir?.trim().replace(/[\\/]+$/u, '');
  if (normalizedHome !== undefined && normalizedHome.length > 0) {
    output = output.replaceAll(normalizedHome, '~');
  }
  return sanitizeCliReviewerText(output, maxChars);
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
