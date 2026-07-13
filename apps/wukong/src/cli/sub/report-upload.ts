/**
 * `wukong report upload` — upload an existing local report file to wukong.today.
 */

import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';

import { getCliAccessToken } from '#/cli/lib/report-upload';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ReportUploadCliOptions {
  readonly path?: string;
  readonly type?: 'verify' | 'scan' | 'proof';
  readonly public?: boolean;
}

export interface ReportUploadDeps {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly readFile: (path: string) => Promise<string>;
  readonly getAccessToken: () => Promise<string | null>;
  readonly upload: (payload: unknown) => Promise<{ ok: boolean; id?: string; shareUrl?: string; reason?: string }>;
}

function detectReportType(markdown: string): 'verify' | 'scan' | 'proof' {
  if (markdown.includes('Merge Proof Report')) return 'proof';
  if (markdown.includes('Risk Scan Report')) return 'scan';
  return 'verify';
}

export async function handleReportUpload(
  deps: ReportUploadDeps,
  options: ReportUploadCliOptions,
): Promise<number> {
  const token = await deps.getAccessToken();
  if (token === null) {
    deps.stderr.write('Upload failed: not logged in. Run `wukong login` first.\n');
    return 1;
  }

  const filePath = options.path;
  if (filePath === undefined) {
    deps.stderr.write('Upload failed: report path is required.\n');
    return 2;
  }

  let markdown: string;
  try {
    markdown = await deps.readFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr.write(`Upload failed: could not read ${filePath}: ${message}\n`);
    return 2;
  }

  const type = options.type ?? detectReportType(markdown);

  // We do not re-run verification/scan here; we upload the markdown as-is after
  // light redaction. For richer metadata the caller should use `wukong verify --upload`.
  const payload = {
    type,
    status: 'passed' as const,
    workspace_cwd: process.cwd().split('/').pop() ?? process.cwd(),
    changed_files_count: 0,
    commands_run: 0,
    failed_commands: 0,
    risks_found: 0,
    high_risks: 0,
    medium_risks: 0,
    low_risks: 0,
    report_markdown: markdown,
    visibility: options.public === true ? 'public' : 'private',
  };

  const outcome = await deps.upload(payload);
  if (outcome.ok) {
    deps.stdout.write(`${outcome.shareUrl ? `Uploaded: ${outcome.shareUrl}` : `Uploaded privately: ${outcome.id}`}\n`);
    return 0;
  }
  deps.stderr.write(`Upload failed: ${outcome.reason ?? 'unknown error'}\n`);
  return 1;
}

export function registerReportUploadCommand(parent: Command): void {
  const report = parent.command('report').description('Manage Wukong reports.');

  report
    .command('upload <path>')
    .description('Upload a local report markdown file to wukong.today.')
    .option('--type <type>', "Report type: 'verify', 'scan', or 'proof'.")
    .option('--public', 'Create a public share link.')
    .action(async (path: string, raw: { type?: 'verify' | 'scan' | 'proof'; public?: boolean }) => {
      const code = await handleReportUpload(
        {
          stdout: process.stdout,
          stderr: process.stderr,
          readFile: (p) => readFile(p, 'utf8'),
          getAccessToken: getCliAccessToken,
          upload: async (payload: unknown) => {
            const token = await getCliAccessToken();
            if (token === null) {
              return { ok: false, reason: 'not logged in' };
            }
            const response = await fetch(`${process.env['WUKONG_API_URL'] ?? 'https://wukong.today'}/api/reports/upload`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              let message = `HTTP ${response.status}`;
              try {
                const body = (await response.json()) as { error?: { message?: string } };
                if (body.error?.message) message = body.error.message;
              } catch {
                // ignore
              }
              return { ok: false, reason: message };
            }
            const body = (await response.json()) as {
              success?: boolean;
              data?: { id?: string; shareUrl?: string };
            };
            return { ok: true, id: body.data?.id, shareUrl: body.data?.shareUrl };
          },
        },
        { path, type: raw.type, public: raw.public === true },
      );
      if (code !== 0) process.exitCode = code;
    });
}
