import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ReviewFeedbackAction = 'accepted' | 'false_positive' | 'fixed' | 'unclear';

interface ReviewFeedbackEvent {
  readonly schemaVersion: 1;
  readonly findingId: string;
  readonly action: ReviewFeedbackAction;
  readonly reason?: string;
  readonly createdAt: string;
  readonly projectIdentity: string;
}

interface ReviewerRuntimeEvent {
  readonly schemaVersion: 1;
  readonly kind: 'reviewer_attempt';
  readonly outcome: 'valid_pass' | 'valid_needs_work' | 'invalid_output' | 'error';
}

export interface ReviewStats {
  feedback: number;
  accepted: number;
  falsePositive: number;
  fixed: number;
  unclear: number;
  reviewCycles: number;
  invalidOutput: number;
  reviewerErrors: number;
}

const POLICY_TEMPLATE = `# Wukong Review Policy

## Blocking rules

- Add project-specific defects that must block delivery.

## Important review rules

- Add architecture, compatibility, testing, or operational expectations.

## Known false positives

- Add patterns that reviewers should not flag without stronger evidence.
`;

export async function initializeReviewPolicy(options: {
  readonly cwd: string;
  readonly force?: boolean;
}): Promise<string> {
  const directory = join(options.cwd, '.wukong');
  const path = join(directory, 'review-policy.md');
  await mkdir(directory, { recursive: true });
  await writeFile(path, POLICY_TEMPLATE, {
    encoding: 'utf8',
    flag: options.force === true ? 'w' : 'wx',
  });
  return path;
}

export async function recordReviewFeedback(options: {
  readonly cwd: string;
  readonly dataDir: string;
  readonly findingId: string;
  readonly action: string;
  readonly reason?: string;
  readonly now?: Date;
}): Promise<ReviewFeedbackAction> {
  const action = normalizeFeedbackAction(options.action);
  if (action === null) {
    throw new Error('action must be accept, false-positive, fixed, or unclear.');
  }
  const event: ReviewFeedbackEvent = {
    schemaVersion: 1,
    findingId: options.findingId,
    action,
    reason: options.reason,
    createdAt: (options.now ?? new Date()).toISOString(),
    projectIdentity: projectIdentity(options.cwd),
  };
  const directory = join(options.dataDir, 'review');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, 'feedback.jsonl'), `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return action;
}

export async function getReviewStats(dataDir: string): Promise<ReviewStats> {
  const feedback = await readJsonLines<Partial<ReviewFeedbackEvent>>(
    join(dataDir, 'review', 'feedback.jsonl'),
  );
  const runtime = await readJsonLines<Partial<ReviewerRuntimeEvent>>(
    join(dataDir, 'review', 'runtime.jsonl'),
  );
  const stats: ReviewStats = {
    feedback: 0,
    accepted: 0,
    falsePositive: 0,
    fixed: 0,
    unclear: 0,
    reviewCycles: 0,
    invalidOutput: 0,
    reviewerErrors: 0,
  };
  for (const value of feedback) {
    const action = value.action === undefined ? null : normalizeFeedbackAction(value.action);
    if (
      value.schemaVersion !== 1
      || typeof value.findingId !== 'string'
      || typeof value.createdAt !== 'string'
      || typeof value.projectIdentity !== 'string'
      || action === null
    ) continue;
    stats.feedback += 1;
    if (action === 'accepted') stats.accepted += 1;
    if (action === 'false_positive') stats.falsePositive += 1;
    if (action === 'fixed') stats.fixed += 1;
    if (action === 'unclear') stats.unclear += 1;
  }
  for (const value of runtime) {
    if (value.schemaVersion !== 1 || value.kind !== 'reviewer_attempt') continue;
    if (value.outcome === 'valid_pass' || value.outcome === 'valid_needs_work') {
      stats.reviewCycles += 1;
    } else if (value.outcome === 'invalid_output') {
      stats.invalidOutput += 1;
    } else if (value.outcome === 'error') {
      stats.reviewerErrors += 1;
    }
  }
  return stats;
}

export function formatReviewStats(stats: ReviewStats): string {
  return [
    `Review feedback: ${String(stats.feedback)}`,
    `  accepted:       ${String(stats.accepted)}`,
    `  false-positive: ${String(stats.falsePositive)}`,
    `  fixed:          ${String(stats.fixed)}`,
    `  unclear:        ${String(stats.unclear)}`,
    `Review cycles: ${String(stats.reviewCycles)}`,
    `Invalid reviewer output: ${String(stats.invalidOutput)}`,
    `Reviewer errors: ${String(stats.reviewerErrors)}`,
    stats.feedback < 10
      ? 'Quality rates are hidden until at least 10 findings have feedback.'
      : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function displayReviewFeedbackAction(action: ReviewFeedbackAction): string {
  return action.replace('_', '-');
}

function normalizeFeedbackAction(value: string): ReviewFeedbackAction | null {
  switch (value) {
    case 'accept':
    case 'accepted':
      return 'accepted';
    case 'false-positive':
    case 'false_positive':
    case 'dismiss':
    case 'dismissed':
      return 'false_positive';
    case 'fixed':
      return 'fixed';
    case 'unclear':
      return 'unclear';
    default:
      return null;
  }
}

function projectIdentity(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const values: T[] = [];
  for (const line of contents.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed historical lines; append-only stores remain readable.
    }
  }
  return values;
}
