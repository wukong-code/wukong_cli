import { runShellCommand } from './process';
import type { VerificationCommand, VerificationCommandResult } from './types';

const DEFAULT_TIMEOUT_MS = 180_000;

export async function runVerificationCommands(
  commands: readonly VerificationCommand[],
  options: { readonly cwd: string; readonly timeoutMs?: number },
): Promise<VerificationCommandResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    const result = await runShellCommand(command.command, { cwd: options.cwd, timeoutMs });
    const durationMs = Date.now() - started;
    results.push({
      command: command.command,
      status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return results;
}
