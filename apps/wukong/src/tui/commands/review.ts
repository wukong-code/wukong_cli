import { getDataDir } from '#/utils/paths';
import {
  displayReviewFeedbackAction,
  formatReviewStats,
  getReviewStats,
  initializeReviewPolicy,
  recordReviewFeedback,
} from '#/utils/review-feedback';

import type { SlashCommandHost } from './dispatch';

export async function handleReviewSlashCommand(
  host: SlashCommandHost,
  rawArgs: string,
): Promise<void> {
  const args = rawArgs.trim();
  if (args === 'init' || args === 'init --force') {
    const path = await initializeReviewPolicy({
      cwd: host.state.appState.workDir,
      force: args.endsWith('--force'),
    });
    host.showStatus(`Created ${path}`, 'success');
    return;
  }
  if (args === 'stats') {
    host.showStatus(formatReviewStats(await getReviewStats(getDataDir())));
    return;
  }
  const feedback = args.match(/^feedback\s+(\S+)\s+(\S+)(?:\s+--reason\s+(.+))?$/);
  if (feedback?.[1] !== undefined && feedback[2] !== undefined) {
    const action = await recordReviewFeedback({
      cwd: host.state.appState.workDir,
      dataDir: getDataDir(),
      findingId: feedback[1],
      action: feedback[2],
      reason: feedback[3],
    });
    host.showStatus(
      `Recorded ${displayReviewFeedbackAction(action)} feedback for ${feedback[1]}.`,
      'success',
    );
    return;
  }
  host.showError(
    'Usage: /review init [--force] | /review feedback <finding-id> <accept|false-positive|fixed|unclear> [--reason <text>] | /review stats',
  );
}
