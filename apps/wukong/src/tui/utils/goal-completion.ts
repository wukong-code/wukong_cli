import type { GoalSnapshot } from '@wukong/wukong-sdk';

import { loopNextAction, parseLoopTerminalReason } from '#/utils/loop-result';

interface GoalCompletionStats {
  readonly terminalReason?: string | undefined;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly loopResult?: GoalSnapshot['loopResult'];
}

/**
 * Deterministic goal-completion text rendered by the TUI when the model marks a
 * goal `complete`. It is built from the final snapshot, so the figures
 * (turns / tokens / time) are exact and do not depend on model prose.
 */
export function buildGoalCompletionMessage(goal: GoalSnapshot): string {
  return buildGoalCompletionMessageFromStats(goal);
}

export function buildGoalCompletionMessageFromStats(goal: GoalCompletionStats): string {
  if (goal.loopResult !== undefined) return buildLoopResultCard(goal.loopResult);
  const loop = parseLoopTerminalReason(goal.terminalReason);
  const head = loop?.status === 'PASS'
    ? `✓ Loop PASS — ${loop.summary}`
    : `✓ Goal complete${goal.terminalReason ? ` — ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

export function buildLoopResultCard(result: NonNullable<GoalSnapshot['loopResult']>): string {
  const blocker = result.blockers[0];
  const next = blocker?.nextAction
    ?? (result.status === 'PASS'
      ? 'Ready to ship.'
      : loopNextAction(result.reasonCode));
  return [
    `Gate        ${result.status}`,
    `Iterations  ${String(result.iterations)}`,
    `Blocker     ${blocker?.summary ?? (result.status === 'PASS' ? 'None' : result.summary)}`,
    `Next        ${next}`,
  ].join('\n');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
