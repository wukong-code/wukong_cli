import { runShellCommand } from './process';
import type { VerificationCommand, VerificationCommandResult } from './types';

const DEFAULT_TIMEOUT_MS = 180_000;

export async function runVerificationCommands(
  commands: readonly VerificationCommand[],
  options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<VerificationCommandResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const result = await runShellCommand(command.command, {
      cwd: options.cwd,
      timeoutMs,
      signal: options.signal,
    });
    const durationMs = Date.now() - started;
    results.push({
      command: command.command,
      status: commandStatus(result),
      exitCode: result.exitCode,
      durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return results;
}

function commandStatus(result: {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): VerificationCommandResult['status'] {
  if (result.timedOut) return 'timed_out';
  if (result.exitCode === 0) return 'passed';
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    result.exitCode === 127 ||
    /(?:command not found|not recognized as an internal or external command|no module named)\b/iu.test(
      output,
    )
  ) {
    return 'unavailable';
  }
  return 'failed';
}
