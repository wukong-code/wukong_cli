import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ReviewerAttemptOutcome =
  | 'valid_pass'
  | 'valid_needs_work'
  | 'invalid_output'
  | 'error';

export async function recordReviewerAttempt(options: {
  readonly cwd: string;
  readonly outcome: ReviewerAttemptOutcome;
  readonly findingCount?: number;
  readonly blockingCount?: number;
}): Promise<void> {
  if (
    process.env['NODE_ENV'] === 'test'
    && process.env['WUKONG_CODE_HOME'] === undefined
    && process.env['WUKONG_HOME'] === undefined
  ) return;
  const dataDir = process.env['WUKONG_CODE_HOME']
    ?? process.env['WUKONG_HOME']
    ?? join(homedir(), '.wukong');
  const directory = join(dataDir, 'review');
  const event = {
    schemaVersion: 1,
    kind: 'reviewer_attempt',
    outcome: options.outcome,
    findingCount: options.findingCount ?? 0,
    blockingCount: options.blockingCount ?? 0,
    createdAt: new Date().toISOString(),
    projectIdentity: createHash('sha256').update(options.cwd).digest('hex').slice(0, 16),
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, 'runtime.jsonl'), `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Review metrics are local diagnostics and must never block the Loop.
  }
}
