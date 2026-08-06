import type { GoalSnapshot } from '@wukong/wukong-sdk';

import { loopNextAction, parseLoopTerminalReason } from '#/utils/loop-result';

interface GoalCompletionStats {
  readonly terminalReason?: string | undefined;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly gateAttempts?: number | undefined;
  readonly loopResult?: GoalSnapshot['loopResult'];
  readonly loopRunId?: string | undefined;
  readonly loopTerminal?: GoalSnapshot['loopTerminal'];
}

type LoopResult = NonNullable<GoalSnapshot['loopResult']>;
type LoopResultStats = Pick<
  GoalCompletionStats,
  'tokensUsed' | 'wallClockMs' | 'gateAttempts' | 'loopRunId' | 'loopTerminal'
>;

export interface LoopResultBlockerPresentation {
  readonly label: string;
  readonly summary: string;
  readonly nextAction: string;
}

/**
 * One semantic projection shared by the live terminal card, `/loop status`,
 * and replay. Keeping continuation and Next here prevents each surface from
 * inventing a different recovery path from the same durable result.
 */
export interface LoopResultPresentation {
  readonly outcome: LoopResult['status'];
  readonly reason: string;
  readonly writer: string;
  readonly gate: string;
  readonly time: string;
  readonly workspace: string;
  readonly checks: string;
  readonly evidence: string;
  readonly blockerCount: number;
  readonly blockers: readonly LoopResultBlockerPresentation[];
  readonly additionalBlockerCount: number;
  readonly unverified: string;
  readonly continuationMode?: NonNullable<GoalSnapshot['loopTerminal']>['continuationPolicy']['mode'];
  readonly next: string;
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
  if (goal.loopResult !== undefined) return buildLoopResultCard(goal.loopResult, goal);
  const loop = parseLoopTerminalReason(goal.terminalReason);
  const head = loop?.status === 'PASS'
    ? `✓ Loop PASS — ${loop.summary}`
    : `✓ Goal complete${goal.terminalReason ? ` — ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

export function buildLoopResultCard(
  result: LoopResult,
  stats?: LoopResultStats,
): string {
  const presentation = buildLoopResultPresentation(result, stats);
  const blockerLines = presentation.blockers.flatMap((blocker) => [
    `${blocker.label.padEnd(12)}${blocker.summary}`,
    `  Fix       ${blocker.nextAction}`,
  ]);
  if (presentation.additionalBlockerCount > 0) {
    blockerLines.push(
      `  More      ${String(presentation.additionalBlockerCount)} additional blocker(s); run \`/loop status\` for details.`,
    );
  }
  return [
    `Outcome     ${presentation.outcome}`,
    `Reason      ${presentation.reason}`,
    `Writer      ${presentation.writer}`,
    `Gate        ${presentation.gate}`,
    `Time        ${presentation.time}`,
    `Workspace   ${presentation.workspace}`,
    `Checks      ${presentation.checks}`,
    `Evidence    ${presentation.evidence}`,
    `Blockers    ${String(presentation.blockerCount)}`,
    ...blockerLines,
    `Unverified  ${presentation.unverified}`,
    ...(presentation.continuationMode === undefined
      ? []
      : [`Continue    ${presentation.continuationMode}`]),
    `Next        ${presentation.next}`,
  ].join('\n');
}

export function buildLoopResultPresentation(
  result: LoopResult,
  stats?: LoopResultStats,
): LoopResultPresentation {
  const loopTerminal = stats?.loopTerminal;
  const continuationMode = stats !== undefined
    && loopTerminal !== undefined
    && loopTerminal.runId === stats.loopRunId
    ? loopTerminal.continuationPolicy.mode
    : undefined;
  const next = result.status === 'PASS'
    ? 'Review the diff, then explicitly keep or revert the workspace changes.'
    : result.reasonCode === 'provider_outcome_unknown'
      ? loopNextAction(result.reasonCode)
      : continuationMode === 'same-contract'
        ? 'Address every blocker, then run `/loop resume` under the same frozen Finish Line.'
        : continuationMode === 'restore-or-revise'
          ? 'Restore the approved workspace/contract, or start `/loop revise` with explicit approval.'
          : continuationMode === 'revised-loop'
            ? 'Start `/loop revise` and explicitly approve the new Finish Line and Gate.'
            : continuationMode === 'blocked'
              ? 'This run cannot resume; cancel it or start an explicitly revised/new Loop.'
              : result.blockers[0]?.nextAction ?? loopNextAction(result.reasonCode);
  const evidence = result.evidence ?? {
    verification: result.checks.length > 0 ? 'fresh' as const : 'not_run' as const,
    reviewer: 'not_run' as const,
  };
  const passedChecks = result.checks.filter((check) => check.status === 'passed').length;
  const changedFiles = result.changedFiles ?? [];
  const changedSummary = changedFiles.length === 0
    ? 'none recorded'
    : `${String(changedFiles.length)} file(s): ${changedFiles
        .slice(0, 5)
        .map((file) => `${file.status} ${file.path}`)
        .join(', ')}${changedFiles.length > 5 ? ', …' : ''}`;
  const blockers = result.blockers.slice(0, 3).map((blocker, index) => ({
    label: `Blocker ${String(index + 1)}`,
    summary: `${blocker.summary}${blocker.file === undefined ? '' : ` (${blocker.file}${blocker.line === undefined ? '' : `:${String(blocker.line)}`})`}`,
    nextAction: blocker.nextAction,
  }));
  return {
    outcome: result.status,
    reason: result.summary,
    writer: `${String(result.iterations)} iteration(s)`,
    gate: stats?.gateAttempts === undefined
      ? 'attempts unavailable'
      : `${String(stats.gateAttempts)} attempt(s)`,
    time: `${stats === undefined ? 'unknown' : formatElapsed(stats.wallClockMs)} · Writer tokens ${stats === undefined ? 'unknown' : formatTokens(stats.tokensUsed)} · Reviewer tokens unavailable · Cost unavailable`,
    workspace: changedSummary,
    checks: evidence.verification === 'not_run'
      ? 'not run'
      : `${String(passedChecks)}/${String(result.checks.length)} passed`,
    evidence: `verification ${evidence.verification}; reviewer ${evidence.reviewer}`,
    blockerCount: result.blockers.length,
    blockers,
    additionalBlockerCount: Math.max(0, result.blockers.length - blockers.length),
    unverified: evidence.verification === 'not_run'
      ? 'No verification evidence was recorded.'
      : 'Nothing beyond the recorded checks and reviewer evidence.',
    ...(continuationMode === undefined ? {} : { continuationMode }),
    next,
  };
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
