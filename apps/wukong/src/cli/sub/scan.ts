import {
  runScan,
  type ScanOptions,
  type ScanResult,
} from '@wukong/verification';
import type { Command } from 'commander';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ScanCliOptions {
  readonly cwd?: string;
  readonly report?: string | boolean;
  readonly json?: boolean;
}

export interface ScanDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runScan: (options: ScanOptions) => Promise<ScanResult>;
}

export async function handleScan(deps: ScanDeps, options: ScanCliOptions): Promise<number> {
  try {
    const result = await deps.runScan({
      cwd: options.cwd ?? deps.cwd(),
      writeReport: options.report !== undefined && options.report !== false,
      reportPath: typeof options.report === 'string' ? options.report : undefined,
    });
    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatScan(result));
    return result.status === 'failed' ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong scan failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerScanCommand(parent: Command, deps?: Partial<ScanDeps>): void {
  parent
    .command('scan')
    .description('Scan the current workspace for delivery risks without running project commands.')
    .option('--diff', 'Scan git diff risks. This is the default P0 behavior.')
    .option('--secrets', 'Include secret-looking file risk checks. This is enabled by default in P0.')
    .option('--report [path]', 'Write a markdown scan report. Defaults to wukong-scan-report.md when no path is given.')
    .option('--json', 'Print the structured scan result as JSON.')
    .action(async (raw: RawScanOptions) => {
      const code = await handleScan(resolveDeps(deps), {
        report: raw.report === true ? 'wukong-scan-report.md' : raw.report,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawScanOptions {
  readonly report?: string | boolean;
  readonly json?: boolean;
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
