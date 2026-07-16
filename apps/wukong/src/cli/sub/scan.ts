import { runScan, renderScanReport, type ScanOptions, type ScanResult } from '@wukong/verification';
import type { Command } from 'commander';

import { uploadReport } from '#/cli/lib/report-upload';
import { localDateString, recordStatEvent } from '#/utils/stats';
import type { ScanStatEvent } from '#/utils/stats';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ScanCliOptions {
  readonly cwd?: string;
  readonly report?: string | boolean;
  readonly json?: boolean;
  readonly upload?: boolean;
  readonly public?: boolean;
}

export interface ScanDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runScan: (options: ScanOptions) => Promise<ScanResult>;
  readonly onResult?: (result: ScanResult) => void;
}

export async function handleScan(deps: ScanDeps, options: ScanCliOptions): Promise<number> {
  if (options.public === true && options.upload !== true) {
    deps.stderr.write('wukong scan: --public requires --upload.\n');
    return 2;
  }

  try {
    const result = await deps.runScan({
      cwd: options.cwd ?? deps.cwd(),
      writeReport: options.report !== undefined && options.report !== false,
      reportPath: typeof options.report === 'string' ? options.report : undefined,
    });
    deps.onResult?.(result);
    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatScan(result));

    if (options.upload === true) {
      const markdown = result.report ?? renderScanReport(result);
      const outcome = await uploadReport(
        { kind: 'scan', result, markdown },
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
    deps.stderr.write(`wukong scan failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerScanCommand(parent: Command, deps?: Partial<ScanDeps>): void {
  parent
    .command('scan', { hidden: true })
    .description('Advanced diagnostic: run the risk rules used by Loop.')
    .option('--diff', 'Scan git diff risks. This is the default P0 behavior.')
    .option('--secrets', 'Include secret-looking file risk checks. This is enabled by default in P0.')
    .option('--report [path]', 'Write a markdown scan report. Defaults to wukong-scan-report.md when no path is given.')
    .option('--json', 'Print the structured scan result as JSON.')
    .option('--upload', 'Upload the redacted report to wukong.today (requires login).')
    .option('--public', 'Create a public share link when used with --upload.')
    .action(async (raw: RawScanOptions) => {
      const resolved = resolveDeps(deps);
      const code = await handleScan(
        {
          ...resolved,
          onResult: (result) => {
            const event: ScanStatEvent = {
              type: 'scan',
              timestamp: new Date().toISOString(),
              date: localDateString(),
              cwd: resolved.cwd(),
              status: result.status === 'failed' ? 'failed' : 'passed',
            };
            recordStatEvent(event);
          },
        },
        {
          report: raw.report === true ? 'wukong-scan-report.md' : raw.report,
          json: raw.json === true,
          upload: raw.upload === true,
          public: raw.public === true,
        },
      );
      if (code !== 0) process.exitCode = code;
    });
}

interface RawScanOptions {
  readonly report?: string | boolean;
  readonly json?: boolean;
  readonly upload?: boolean;
  readonly public?: boolean;
}

function resolveDeps(deps: Partial<ScanDeps> | undefined): ScanDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    runScan: deps?.runScan ?? runScan,
  };
}

function formatScan(result: ScanResult): string {
  return [
    'Wukong risk scan',
    '',
    `Status: ${result.status}`,
    `Changed files: ${String(result.changedFiles.length)}`,
    'Risks:',
    ...formatRisks(result),
    ...(result.reportPath === undefined ? [] : [`Report: ${result.reportPath}`]),
    '',
  ].join('\n');
}

function formatRisks(result: ScanResult): string[] {
  if (result.risks.length === 0) return ['  none'];
  return result.risks.map((risk) => {
    const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
    return `  ${risk.severity.padEnd(7)} ${risk.message}${location}`;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
