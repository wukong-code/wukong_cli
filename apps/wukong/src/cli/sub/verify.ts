import {
  runVerification,
  renderVerificationReport,
  type VerificationOptions,
  type VerificationResult,
} from '@wukong/verification';
import type { Command } from 'commander';

import { uploadReport } from '#/cli/lib/report-upload';
import { localDateString, recordStatEvent } from '#/utils/stats';
import type { VerifyStatEvent } from '#/utils/stats';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface VerifyCliOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly includeBuild?: boolean;
  readonly report?: string | false;
  readonly timeoutSeconds?: number;
  readonly json?: boolean;
  readonly strict?: boolean;
  readonly upload?: boolean;
  readonly public?: boolean;
}

export interface VerifyDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runVerification: (options: VerificationOptions) => Promise<VerificationResult>;
  readonly onResult?: (result: VerificationResult) => void;
}

export async function handleVerify(deps: VerifyDeps, options: VerifyCliOptions): Promise<number> {
  if (options.public === true && options.upload !== true) {
    deps.stderr.write('wukong verify: --public requires --upload.\n');
    return 2;
  }

  try {
    const result = await deps.runVerification({
      cwd: options.cwd ?? deps.cwd(),
      commands: options.commands,
      includeBuild: options.includeBuild,
      strict: options.strict,
      timeoutMs: options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000,
      writeReport: options.report !== false,
      reportPath: typeof options.report === 'string' ? options.report : undefined,
    });
    deps.onResult?.(result);

    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatVerify(result));

    if (options.upload === true) {
      const markdown = result.report ?? renderVerificationReport(result);
      const outcome = await uploadReport(
        { kind: 'verify', result, markdown },
        { visibility: options.public === true ? 'public' : 'private' },
      );
      if (outcome.ok) {
        deps.stdout.write(`\n${outcome.shareUrl ? `Uploaded: ${outcome.shareUrl}` : `Uploaded privately: ${outcome.id}`}\n`);
      } else {
        deps.stderr.write(`\nUpload skipped: ${outcome.reason}\n`);
      }
    }

    return result.status === 'failed' ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong verify failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerVerifyCommand(parent: Command, deps?: Partial<VerifyDeps>): void {
  parent
    .command('verify')
    .description('Run deterministic verification checks and generate an evidence report.')
    .option('--build', 'Include the package build script when auto-detecting commands.')
    .option('--command <command>', 'Run an explicit verification command. Can be repeated.', collect, [])
    .option('--report <path>', 'Write the evidence report to this path.')
    .option('--no-report', 'Do not write a markdown evidence report.')
    .option('--timeout <seconds>', 'Per-command timeout in seconds.', parsePositiveInteger)
    .option('--json', 'Print the structured verification result as JSON.')
    .option('--strict', 'Treat any risk as a failed verification.')
    .option('--upload', 'Upload the redacted report to wukong.today (requires login).')
    .option('--public', 'Create a public share link when used with --upload.')
    .action(async (raw: RawVerifyOptions) => {
      const resolved = resolveDeps(deps);
      const code = await handleVerify(
        {
          ...resolved,
          onResult: (result) => {
            const cwd = resolved.cwd();
            const event: VerifyStatEvent = {
              type: 'verify',
              timestamp: new Date().toISOString(),
              date: localDateString(),
              cwd,
              status: result.status === 'failed' ? 'failed' : 'passed',
            };
            recordStatEvent(event);
          },
        },
        {
          commands: raw.command,
          includeBuild: raw.build === true,
          report: raw.report,
          timeoutSeconds: raw.timeout,
          json: raw.json === true,
          strict: raw.strict === true,
          upload: raw.upload === true,
          public: raw.public === true,
        },
      );
      if (code !== 0) process.exitCode = code;
    });
}

interface RawVerifyOptions {
  readonly build?: boolean;
  readonly command?: string[];
  readonly report?: string | false;
  readonly timeout?: number;
  readonly json?: boolean;
  readonly strict?: boolean;
  readonly upload?: boolean;
  readonly public?: boolean;
}

function resolveDeps(deps: Partial<VerifyDeps> | undefined): VerifyDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    runVerification: deps?.runVerification ?? runVerification,
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--timeout must be a positive integer');
  }
  return parsed;
}

function formatVerify(result: VerificationResult): string {
  return [
    'Wukong verification',
    '',
    `Status: ${result.status}`,
    `Changed files: ${String(result.changedFiles.length)}`,
    'Commands:',
    ...formatCommands(result),
    'Risks:',
    ...formatRisks(result),
    ...(result.reportPath === undefined ? [] : [`Report: ${result.reportPath}`]),
    '',
  ].join('\n');
}

function formatCommands(result: VerificationResult): string[] {
  if (result.commandResults.length === 0) return ['  none'];
  return result.commandResults.map((command) => `  ${command.status.padEnd(9)} ${command.command}`);
}

function formatRisks(result: VerificationResult): string[] {
  if (result.risks.length === 0) return ['  none'];
  return result.risks.map((risk) => {
    const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
    return `  ${risk.severity.padEnd(7)} ${risk.message}${location}`;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
