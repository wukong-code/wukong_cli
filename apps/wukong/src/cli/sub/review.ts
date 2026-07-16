import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';
import {
  displayReviewFeedbackAction,
  formatReviewStats,
  getReviewStats,
  initializeReviewPolicy,
  recordReviewFeedback,
} from '#/utils/review-feedback';

export interface ReviewCommandDeps {
  readonly cwd: () => string;
  readonly dataDir: () => string;
  readonly now: () => Date;
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

const DEFAULT_DEPS: ReviewCommandDeps = {
  cwd: () => process.cwd(),
  dataDir: getDataDir,
  now: () => new Date(),
  stdout: process.stdout,
};

export function registerReviewCommand(
  parent: Command,
  overrides?: Partial<ReviewCommandDeps>,
): void {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const review = parent.command('review').description('Manage local Loop review policy and feedback.');

  review
    .command('init')
    .description('Create .wukong/review-policy.md in the current project.')
    .option('--force', 'Replace an existing review policy.', false)
    .action(async (options: { force: boolean }) => {
      const path = await initializeReviewPolicy({ cwd: deps.cwd(), force: options.force });
      deps.stdout.write(`Created ${path}\n`);
    });

  review
    .command('feedback')
    .description('Record local feedback for a review finding.')
    .argument('<finding-id>', 'Finding ID from the Loop review result.')
    .argument('<action>', 'accept, false-positive, fixed, or unclear.')
    .option('--reason <reason>', 'Optional local reason. It is not uploaded.')
    .action(async (findingId: string, rawAction: string, options: { reason?: string }) => {
      const action = await recordReviewFeedback({
        cwd: deps.cwd(),
        dataDir: deps.dataDir(),
        findingId,
        action: rawAction,
        reason: options.reason,
        now: deps.now(),
      });
      deps.stdout.write(`Recorded ${displayReviewFeedbackAction(action)} feedback for ${findingId}.\n`);
    });

  review
    .command('stats')
    .description('Show local review feedback counts.')
    .action(async () => {
      deps.stdout.write(`${formatReviewStats(await getReviewStats(deps.dataDir()))}\n`);
    });
}
