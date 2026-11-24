import {
  runVerification,
  type VerificationOptions,
  type VerificationResult,
} from '@wukong/verification';
import type { Command } from 'commander';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface CheckCliOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly includeBuild?: boolean;
  readonly report?: string | boolean;
  readonly timeoutSeconds?: number;
  readonly json?: boolean;
  readonly strict?: boolean;
}

export interface CheckDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runVerification: (options: VerificationOptions) => Promise<VerificationResult>;
  readonly onResult?: (result: CheckResult) => void;
}

export interface CheckResult {
  readonly status: 'passed' | 'warning' | 'failed';
  readonly reviewer: 'not_run';
  readonly fullGatePass: false;
  readonly changedFiles: VerificationResult['changedFiles'];
  readonly commandResults: VerificationResult['commandResults'];
  readonly risks: VerificationResult['risks'];
  readonly reportPath?: string;
  readonly nextStep: string;
}

export async function handleCheck(deps: CheckDeps, options: CheckCliOptions): Promise<number> {
  try {
    const verification = await deps.runVerification({
      cwd: options.cwd ?? deps.cwd(),
      commands: options.commands,
      includeBuild: options.includeBuild,
      strict: options.strict,
      timeoutMs: options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000,
      writeReport: options.report !== undefined && options.report !== false,
      reportPath: typeof options.report === 'string'
        ? options.report
        : options.report === true
          ? 'wukong-check-report.md'
          : undefined,
    });

    const hasCommandFailure = verification.commandResults.some((command) => command.status !== 'passed');
    const hasNoChecks = verification.commandResults.length === 0;
    const hasHighRisk = verification.risks.some((risk) => risk.severity === 'high');
    const hasAnyRisk = verification.risks.length > 0;

    const status: CheckResult['status'] =
      hasCommandFailure
      || hasNoChecks
      || hasHighRisk
      || (options.strict === true && hasAnyRisk)
        ? 'failed'
        : hasAnyRisk
          ? 'warning'
          : 'passed';

    const result: CheckResult = {
      status,
      reviewer: 'not_run',
      fullGatePass: false,
      changedFiles: verification.changedFiles,
      commandResults: verification.commandResults,
      risks: verification.risks,
      reportPath: verification.reportPath,
      nextStep: status === 'failed'
        ? 'Fix the failing checks or risks, then re-run `wukong check`.'
        : 'Run `wukong gate` for independent AI review and delivery verdict.',
    };

    deps.onResult?.(result);
    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatCheck(result));
    return status === 'failed' ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong check failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerCheckCommand(parent: Command, deps?: Partial<CheckDeps>): void {
  parent
    .command('check')
    .description('Run deterministic project checks and risk scan offline (no AI review).')
    .option('--build', 'Include the package build script when auto-detecting commands.')
    .option('--command <command>', 'Run an explicit check command. Can be repeated.', collect, [])
    .option('--report [path]', 'Write a markdown verification report. Defaults to wukong-check-report.md when no path is given.')
    .option('--timeout <seconds>', 'Per-command timeout in seconds.')
    .option('--json', 'Print the structured check result as JSON.')
    .option('--strict', 'Treat any risk as a failed check.')
    .action(async (raw: RawCheckOptions) => {
      const resolved = resolveDeps(deps);
      let timeoutSeconds: number | undefined;
      if (raw.timeout !== undefined) {
        timeoutSeconds = parsePositiveInteger(raw.timeout);
        if (timeoutSeconds === undefined) {
          resolved.stderr.write('error: --timeout must be a positive integer.\n');
          process.exitCode = 1;
          return;
        }
      }

      const code = await handleCheck(resolved, {
        commands: raw.command,
        includeBuild: raw.build === true,
        report: raw.report === true ? 'wukong-check-report.md' : raw.report,
        timeoutSeconds,
        json: raw.json === true,
        strict: raw.strict === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawCheckOptions {
  readonly build?: boolean;
  readonly command?: string[];
  readonly report?: string | boolean;
  readonly timeout?: string;
  readonly json?: boolean;
  readonly strict?: boolean;
}

function resolveDeps(deps: Partial<CheckDeps> | undefined): CheckDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    runVerification: deps?.runVerification ?? runVerification,
    onResult: deps?.onResult,
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatCheck(result: CheckResult): string {
  const lines = [
    'Wukong check',
    '',
    `Status: ${result.status}`,
    `Reviewer: ${result.reviewer}`,
    `Changed files: ${String(result.changedFiles.length)}`,
    'Commands:',
    ...formatCommands(result.commandResults),
    'Risks:',
    ...formatRisks(result.risks),
  ];

  if (result.reportPath !== undefined) {
    lines.push(`Report: ${result.reportPath}`);
  }
  if (result.status !== 'failed') {
    lines.push('Note: Deterministic checks only — not a full Gate PASS. Run `wukong gate` for independent review.');
  } else {
    lines.push(`Next: ${result.nextStep}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatCommands(results: CheckResult['commandResults']): string[] {
  if (results.length === 0) return ['  none'];
  return results.map((command) => `  ${command.status.padEnd(11)} ${command.command}`);
}

function formatRisks(risks: CheckResult['risks']): string[] {
  if (risks.length === 0) return ['  none'];
  return risks.map((risk) => {
    const location = risk.file === undefined
      ? ''
      : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
    return `  ${risk.severity.padEnd(7)} ${risk.message}${location}`;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
