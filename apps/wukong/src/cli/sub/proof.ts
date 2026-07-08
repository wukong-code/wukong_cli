import { runProof, type ProofOptions, type ProofResult } from '@wukong/verification';
import type { Command } from 'commander';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProofCliOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly report?: string | false;
  readonly json?: boolean;
  readonly strict?: boolean;
}

export interface ProofDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runProof: (options: ProofOptions) => Promise<ProofResult>;
}

export async function handleProof(deps: ProofDeps, options: ProofCliOptions): Promise<number> {
  try {
    const result = await deps.runProof({
      cwd: options.cwd ?? deps.cwd(),
      strict: options.strict,
      writeReport: options.report === false ? false : true,
      reportPath: typeof options.report === 'string' ? options.report : undefined,
    });

    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatProof(result));
    return result.status === 'blocked' ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong proof failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerProofCommand(parent: Command, deps?: Partial<ProofDeps>): void {
  parent
    .command('proof')
    .description('Run verification and scan, then generate a Merge Proof Report.')
    .option('--command <command>', 'Run an explicit verification command. Can be repeated.', collect, [])
    .option('--report <path>', 'Write the merge proof report to this path.')
    .option('--no-report', 'Do not write a markdown merge proof report.')
    .option('--json', 'Print the structured proof result as JSON.')
    .option('--strict', 'Treat any risk as a blocked proof.')
    .action(async (raw: RawProofOptions) => {
    const code = await handleProof(resolveDeps(deps), {
      commands: raw.command,
      report: raw.report,
      json: raw.json === true,
      strict: raw.strict === true,
    });

      if (code !== 0) process.exitCode = code;
    });
}

interface RawProofOptions {
  readonly command?: string[];
  readonly report?: string | false;
  readonly json?: boolean;
  readonly strict?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveDeps(deps: Partial<ProofDeps> | undefined): ProofDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    runProof: deps?.runProof ?? runProof,
  };
}

function formatProof(result: ProofResult): string {
  return [
    'Wukong merge proof',
    '',
    `Status: ${result.status}`,
    `Verification: ${result.verification.status}`,
    `Scan: ${result.scan.status}`,
    `Changed files: ${String(result.verification.changedFiles.length)}`,
    '',
    'Recommendation:',
    `  ${result.recommendation}`,
    ...(result.reportPath === undefined ? [] : ['', `Report: ${result.reportPath}`]),
    '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
