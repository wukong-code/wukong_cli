/**
 * Builds the line content for the `/goal` status box. The lines are rendered
 * inside a {@link UsagePanelComponent} (the same bordered box as `/usage`), so
 * this module only owns the goal-specific layout:
 *
 *   ▌ <objective> (blockquote left-trail, wrapped)
 *   ▌ ✓ <completion criterion>
 *
 *   Status     complete — <reason>        (terminal goals only)
 *   Running    4m 12s
 *   Turns      7
 *   Tokens     128.4k
 *   Stop       after 20 turns (7/20)      (or a dim "no stop condition" note)
 */

import {
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import type { GoalSnapshot, GoalStatus } from '@wukong/wukong-sdk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { durableLoopResultFromGoal, parseLoopTerminalReason } from '#/utils/loop-result';
import { formatTokenCount } from '#/utils/usage/usage-format';
import { buildLoopResultPresentation } from '../../utils/goal-completion';
import { formatGoalElapsed } from './goal-format';
import { UsagePanelComponent } from './usage-panel';

const WRAP_WIDTH = 72;
const MAX_OBJECTIVE_LINES = 6;
const MAX_CRITERION_LINES = 3;
const LABEL_WIDTH = 11;

function renderLifecycleLine(label: string, width: number): string[] {
  if (width <= 0) return [''];

  const marker = currentTheme.boldFg('primary', STATUS_BULLET);
  const text = new Text(currentTheme.boldFg('primary', label), 0, 0);
  const contentWidth = Math.max(1, width - visibleWidth(STATUS_BULLET));
  return [
    '',
    ...text
      .render(contentWidth)
      .map((line, index) => (index === 0 ? marker : MESSAGE_INDENT) + line.trimEnd()),
  ];
}

/**
 * The "Goal set" confirmation shown after `/goal <objective>`. The objective is
 * rendered as the following user prompt, so this message only marks the state
 * change in the transcript.
 */
export class GoalSetMessageComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return renderLifecycleLine('Goal set', width);
  }
}

export class UpcomingGoalAddedMessageComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return renderLifecycleLine(
      'Upcoming goal added. It will start after the current goal is complete.',
      width,
    );
  }
}

export class GoalCompletionMessageComponent implements Component {
  constructor(private readonly message: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    const [headline = '', ...details] = this.message.trim().split(/\r?\n/);
    if (headline.length === 0) return [];

    const bullet = currentTheme.boldFg('success', STATUS_BULLET);
    const bulletWidth = visibleWidth(STATUS_BULLET);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: string[] = [''];

    const headlineText = new Text(currentTheme.boldFg('success', headline), 0, 0);
    const headlineLines = headlineText.render(contentWidth);
    for (let i = 0; i < headlineLines.length; i += 1) {
      lines.push((i === 0 ? bullet : MESSAGE_INDENT) + headlineLines[i]);
    }

    const detailText = details.join('\n').trim();
    if (detailText.length > 0) {
      const detailLines = new Text(currentTheme.fg('textDim', detailText), 0, 0).render(
        contentWidth,
      );
      for (const line of detailLines) {
        lines.push(MESSAGE_INDENT + line);
      }
    }

    return lines;
  }
}

export class GoalStatusMessageComponent implements Component {
  constructor(private readonly goal: GoalSnapshot) {}

  invalidate(): void {}

  render(width: number): string[] {
    const panelContentWidth = Math.max(1, width - 6);
    const panel = new UsagePanelComponent(
      () => buildGoalReportLines(this.goal, panelContentWidth),
      'primary',
      goalPanelTitle(this.goal),
    );
    return ['', ...panel.render(width)];
  }
}

/** Box title, e.g. ` Goal · active `. */
export function goalPanelTitle(goal: GoalSnapshot): string {
  if (goal.providerOutcomeUnknown !== undefined) return ' Loop · ERROR ';
  const loop = parseLoopTerminalReason(goal.terminalReason);
  if (loop !== null) return ` Loop · ${loop.status} `;
  return ` Goal · ${goal.status} `;
}

export function buildGoalReportLines(goal: GoalSnapshot, wrapWidth: number = WRAP_WIDTH): string[] {
  const statusColor = statusToken(goal.status);
  const bar = (s: string) => currentTheme.fg(statusColor, s);
  const value = (s: string) => currentTheme.fg('text', s);
  const muted = (s: string) => currentTheme.fg('textDim', s);
  // `complete` is the terminal outcome (the completion card); everything else
  // (active / paused / blocked) is a persisted, resumable goal that still shows
  // its stop condition. A reason is worth surfacing for stopped / complete states.
  const isComplete = goal.status === 'complete';
  const durableResult = durableLoopResultFromGoal(goal);
  const loop = parseLoopTerminalReason(goal.terminalReason);
  const reason = loop?.summary ?? goal.terminalReason;
  const showReason =
    durableResult === undefined
    && ((goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete);
  const lines: string[] = [];

  // Condition as a blockquote left-trail. Reserve the visible "▌ " prefix before
  // wrapping so the panel doesn't clip rows that exactly fit the panel interior.
  const blockquoteWrapWidth = Math.max(1, wrapWidth - visibleWidth('▌ '));
  for (const line of wrap(goal.objective, blockquoteWrapWidth, MAX_OBJECTIVE_LINES)) {
    lines.push(`${bar('▌')} ${value(line)}`);
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(`✓ ${goal.completionCriterion}`, blockquoteWrapWidth, MAX_CRITERION_LINES)) {
      lines.push(`${bar('▌')} ${muted(line)}`);
    }
  }
  lines.push('');

  const row = (label: string, val: string): string => `${muted(label.padEnd(LABEL_WIDTH))}${val}`;
  const wrappedRow = (
    label: string,
    text: string,
    colorize: (input: string) => string = value,
    maxLines: number = 4,
  ): void => {
    const chunks = wrap(text, Math.max(1, wrapWidth - LABEL_WIDTH), maxLines);
    lines.push(row(label, colorize(chunks[0] ?? '')));
    for (const chunk of chunks.slice(1)) {
      lines.push(row('', colorize(chunk)));
    }
  };

  if (showReason) {
    lines.push(
      row(
        'Status',
        currentTheme.fg(statusColor, loop?.status ?? goal.status) +
          (reason !== undefined ? muted(` — ${reason}`) : ''),
      ),
    );
  }
  lines.push(row('Running', value(formatGoalElapsed(goal.wallClockMs))));
  lines.push(row('Turns', value(`${goal.turnsUsed}`)));
  lines.push(row('Writer tokens', value(formatTokenCount(goal.tokensUsed))));
  if (goal.stopCondition !== undefined) {
    const providerUsage = goal.providerUsage;
    if (providerUsage === undefined) {
      lines.push(row('Provider calls', muted('usage unavailable')));
    } else {
      lines.push(row(
        'Writer calls',
        value(formatCallUsage(providerUsage.writerCalls, providerUsage.writerCallLimit)),
      ));
      lines.push(row(
        'Reviewer calls',
        value(formatCallUsage(providerUsage.reviewerCalls, providerUsage.reviewerCallLimit)),
      ));
    }
    if (goal.budget.tokenBudget !== null) {
      lines.push(row(
        'Token budget',
        value(
          `${formatTokenCount(goal.budget.remainingTokens ?? 0)} remaining of ${formatTokenCount(goal.budget.tokenBudget)}`,
        ),
      ));
    }
  }
  if (goal.stopCondition !== undefined) {
    lines.push(row('Iteration', value(`${goal.iteration}${goal.maxIterations !== undefined ? `/${String(goal.maxIterations)}` : ''}`)));
    lines.push(row('Gate tries', value(goal.gateAttempts === undefined ? 'unknown' : String(goal.gateAttempts))));
  }
  if (goal.reviewModel !== undefined) {
    lines.push(row('Reviewer', value(goal.reviewModel)));
  }
  if (goal.loopContract?.schemaVersion === 2 || goal.loopContract?.schemaVersion === 3) {
    const gatePlan = goal.loopContract.schemaVersion === 2
      ? goal.loopContract.gatePlan
      : goal.loopContract.gatePlan.legacySnapshot;
    const criteriaSuffix = goal.loopContract.schemaVersion === 3
      ? ` · ${String(goal.loopContract.verificationCriteria.selected.length)} evidence criteria`
      : '';
    lines.push(row(
      'Finish line',
      value(
        `${String(goal.loopContract.constraints.length)} constraints · `
        + `${String(gatePlan.requiredChecks.length)} checks${criteriaSuffix}`,
      ),
    ));
    if (goal.loopRunId !== undefined) {
      lines.push(row('Run', value(goal.loopRunId.slice(0, 12))));
    }
    if (goal.loopChainIterations !== undefined) {
      lines.push(row('Chain total', value(String(goal.loopChainIterations))));
    }
  }
  if (durableResult !== undefined) {
    const presentation = buildLoopResultPresentation(durableResult, goal);
    lines.push(row('Outcome', value(presentation.outcome)));
    wrappedRow('Reason', presentation.reason);
    lines.push(row('Checks', value(presentation.checks)));
    lines.push(row('Evidence', value(presentation.evidence)));
    wrappedRow('Workspace', presentation.workspace);
    lines.push(row('Blockers', value(String(presentation.blockerCount))));
    for (const blocker of presentation.blockers) {
      wrappedRow(blocker.label, blocker.summary, muted);
      wrappedRow('Fix', blocker.nextAction, muted);
    }
    if (presentation.additionalBlockerCount > 0) {
      wrappedRow(
        'More',
        `${String(presentation.additionalBlockerCount)} additional blocker(s); inspect the durable transcript for details.`,
        muted,
      );
    }
    wrappedRow('Unverified', presentation.unverified, muted);
    if (presentation.continuationMode !== undefined) {
      lines.push(row('Continue', value(presentation.continuationMode)));
    }
    wrappedRow('Next', presentation.next);
  } else if (goal.loopResult !== undefined) {
    const passedChecks = goal.loopResult.checks.filter((check) => check.status === 'passed').length;
    lines.push(row('Last gate', value(goal.loopResult.status)));
    lines.push(row(
      'Checks',
      value(goal.loopResult.evidence?.verification === 'not_run'
        ? 'not run'
        : `${String(passedChecks)}/${String(goal.loopResult.checks.length)} passed`),
    ));
    lines.push(row(
      'Evidence',
      value(
        `verify ${goal.loopResult.evidence?.verification ?? 'unknown'} · `
        + `review ${goal.loopResult.evidence?.reviewer ?? 'unknown'}`,
      ),
    ));
    if (goal.loopResult.changedFiles !== undefined) {
      lines.push(row('Changes', value(`${String(goal.loopResult.changedFiles.length)} files`)));
    }
  }
  if (goal.providerOutcomeUnknown !== undefined) {
    lines.push(row('Provider', currentTheme.fg('error', 'UNKNOWN — request may have been accepted or billed')));
    lines.push(row('Request', value(goal.providerOutcomeUnknown.requestId)));
    lines.push(row('Idempotency', value(goal.providerOutcomeUnknown.idempotencyKey)));
    lines.push(row('Resume', currentTheme.fg('error', 'disabled — blind retry is unsafe')));
    if (durableResult === undefined) {
      wrappedRow(
        'Next',
        'Check provider logs/billing; cancel and start a new Loop only after confirming a new request is safe.',
        muted,
      );
    }
  }
  const findings = durableResult?.findings ?? [];
  if (findings.length > 0) {
    const blocking = findings.filter((finding) => finding.severity === 'blocking');
    const nonBlocking = findings.length - blocking.length;
    lines.push(
      row(
        'Review',
        value(
          `${String(blocking.length)} blocking${nonBlocking > 0 ? ` · ${String(nonBlocking)} non-blocking` : ''}`,
        ),
      ),
    );
    for (const finding of blocking.slice(0, 3)) {
      const location = finding.file === undefined
        ? ''
        : ` (${finding.file}${finding.line === undefined ? '' : `:${String(finding.line)}`})`;
      lines.push(muted(`  ${finding.id}: ${finding.summary}${location}`));
    }
    lines.push(muted('  Feedback: wukong review feedback <finding-id> <action>'));
  }
  if (!isComplete) {
    const stop = formatStopRow(goal);
    lines.push(
      stop !== null
        ? row('Stop', value(stop))
        : muted('No stop condition — runs until evaluated complete.'),
    );
  }
  return lines;
}

function formatCallUsage(used: number, limit: number | null): string {
  return limit === null ? `${String(used)} (uncapped)` : `${String(used)}/${String(limit)}`;
}

/** The configured hard stop(s), or null when the goal is unbounded. */
function formatStopRow(goal: GoalSnapshot): string | null {
  const { budget } = goal;
  const parts: string[] = [];
  if (goal.stopCondition !== undefined) {
    parts.push(`when ${goal.stopCondition}`);
  }
  if (budget.turnBudget !== null) {
    parts.push(`after ${budget.turnBudget} turns (${goal.turnsUsed}/${budget.turnBudget})`);
  }
  if (budget.tokenBudget !== null) {
    parts.push(`at ${formatTokenCount(budget.tokenBudget)} tokens`);
  }
  if (budget.wallClockBudgetMs !== null) {
    parts.push(`after ${formatGoalElapsed(budget.wallClockBudgetMs)}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function statusToken(status: GoalStatus): ColorToken {
  switch (status) {
    case 'active':
      return 'primary';
    case 'complete':
      return 'success';
    case 'blocked':
      return 'warning';
    case 'paused':
      return 'textDim';
  }
}

/** Word-wrap to `width`, capped at `maxLines` (last line gets an ellipsis when clipped). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines = wrapTextWithAnsi(text.replaceAll(/\s+/g, ' ').trim(), safeWidth);
  if (lines.length === 0) return [''];
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  const lastLine = clipped[maxLines - 1] ?? '';
  clipped[maxLines - 1] = truncateToWidth(`${lastLine}…`, safeWidth, '…');
  return clipped;
}
