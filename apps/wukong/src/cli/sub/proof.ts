import { runProof, type ProofOptions, type ProofResult } from '@wukong/verification';
import type { Command } from 'commander';

import { getCliAccessToken, uploadReport } from '#/cli/lib/report-upload';
import { localDateString, recordStatEvent } from '#/utils/stats';
import type { ProofStatEvent } from '#/utils/stats';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProofCliOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly report?: string | false;
  readonly json?: boolean;
  readonly strict?: boolean;
  readonly upload?: boolean;
  readonly public?: boolean;
}

export interface ProofDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runProof: (options: ProofOptions) => Promise<ProofResult>;
  readonly onResult?: (result: ProofResult) => void;
  readonly getAccessToken?: () => Promise<string | null>;
}

export async function handleProof(deps: ProofDeps, options: ProofCliOptions): Promise<number> {
  if (options.public === true && options.upload !== true) {
    deps.stderr.write('wukong proof: --public requires --upload.\n');
    return 2;
  }

  try {
    const result = await deps.runProof({
      cwd: options.cwd ?? deps.cwd(),
      strict: options.strict,
      writeReport: options.report !== false,
      reportPath: typeof options.report === 'string' ? options.report : undefined,
    });

    deps.onResult?.(result);
    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatProof(result));

    if (options.upload === true) {
      const markdown = result.report ?? '';
      const outcome = await uploadReport(
        { kind: 'proof', result, markdown },
        { visibility: options.public === true ? 'public' : 'private' },
      );
      if (outcome.ok) {
        deps.stdout.write(`\n${outcome.shareUrl ? `Uploaded: ${outcome.shareUrl}` : `Uploaded privately: ${outcome.id}`}\n`);
      } else {
        deps.stderr.write(`\nUpload skipped: ${outcome.reason}\n`);
      }
    } else if (options.json !== true) {
      const token = await (deps.getAccessToken ?? getCliAccessToken)().catch(() => null);
      deps.stdout.write(formatHostedProofCta(token !== null));
    }

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
    .option('--upload', 'Upload the redacted report to wukong.today (requires login).')
    .option('--public', 'Create a public share link when used with --upload.')
    .action(async (raw: RawProofOptions) => {
      const resolved = resolveDeps(deps);
      const code = await handleProof(
        {
          ...resolved,
          onResult: (result) => {
            const event: ProofStatEvent = {
              type: 'proof',
              timestamp: new Date().toISOString(),
              date: localDateString(),
              cwd: resolved.cwd(),
              status: result.status === 'blocked' ? 'blocked' : 'pass',
              summary: result.summary,
            };
            recordStatEvent(event);
          },
        },
        {
          commands: raw.command,
          report: raw.report,
          json: raw.json === true,
          strict: raw.strict === true,
          upload: raw.upload === true,
          public: raw.public === true,
        },
      );

      if (code !== 0) process.exitCode = code;
    });
}

interface RawProofOptions {
  readonly command?: string[];
  readonly report?: string | false;
  readonly json?: boolean;
  readonly strict?: boolean;
  readonly upload?: boolean;
  readonly public?: boolean;
}

function formatHostedProofCta(isLoggedIn: boolean): string {
  if (isLoggedIn) {
    return [
      '',
      'Hosted history: wukong proof --upload',
      'Public share:  wukong proof --upload --public',
      '',
    ].join('\n');
  }
  return [
    '',
    'Need hosted history? Run `wukong login`, then `wukong proof --upload`.',
    '',
  ].join('\n');
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
    getAccessToken: deps?.getAccessToken ?? getCliAccessToken,
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
