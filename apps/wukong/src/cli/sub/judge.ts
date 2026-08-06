import { runJudge, type JudgeOptions, type JudgeResult } from '@wukong/verification';
import { Option, type Command } from 'commander';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface JudgeCliOptions {
  readonly cwd?: string;
  readonly strict?: boolean;
  readonly json?: boolean;
}

export interface JudgeDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runJudge: (options: JudgeOptions) => Promise<JudgeResult>;
}

export async function handleJudge(deps: JudgeDeps, options: JudgeCliOptions): Promise<number> {
  try {
    const result = await deps.runJudge({
      cwd: options.cwd ?? deps.cwd(),
      strict: options.strict,
    });

    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatJudge(result));
    return result.verdict === 'block' ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong judge failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerJudgeCommand(parent: Command, deps?: Partial<JudgeDeps>): void {
  parent
    .command('judge')
    .description(
      "Check whether the current workspace passes Wukong's local merge gate (deterministic; no model calls).",
    )
    .addOption(new Option('--assume-broken').hideHelp())
    .option('--strict', 'Block on any risk, including medium and low.')
    .option('--json', 'Print the structured judge result as JSON.')
    .action(async (raw: RawJudgeOptions) => {
      const code = await handleJudge(resolveDeps(deps), {
        json: raw.json === true,
        strict: raw.strict === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawJudgeOptions {
  readonly strict?: boolean;
  readonly json?: boolean;
}

function resolveDeps(deps: Partial<JudgeDeps> | undefined): JudgeDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    runJudge: deps?.runJudge ?? runJudge,
  };
}

function formatJudge(result: JudgeResult): string {
  const totalChecks = result.proof.verification.commandResults.length;
  const passedChecks = result.proof.verification.commandResults.filter(
    (command) => command.status === 'passed',
  ).length;
  return [
    'Wukong judge',
    '',
    `Verdict: ${result.verdict}`,
    `Mode: ${result.mode}`,
    `Verification: ${totalChecks === 0 ? 'not run' : result.proof.verification.status}`,
    `Proof bundle: ${result.proof.status}${totalChecks === 0 ? ' (risk scan only)' : ''}`,
    `Checks: ${String(passedChecks)}/${String(totalChecks)} passed`,
    `Changed files: ${String(result.proof.verification.changedFiles.length)}`,
    '',
    'Reason:',
    `  ${result.reason}`,
    '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
