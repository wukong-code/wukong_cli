import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildGoalReportLines,
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
  GoalStatusMessageComponent,
  UpcomingGoalAddedMessageComponent,
  goalPanelTitle,
} from '#/tui/components/messages/goal-panel';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';
import type { GoalSnapshot } from '@wukong/wukong-sdk';

const previousChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(lines: string[]): string {
  return lines.join('\n').replaceAll(ANSI_SGR, '');
}

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship the goal status box',
    status: 'active',
    turnsUsed: 7,
    tokensUsed: 128_400,
    wallClockMs: 252_000, // 4m12s
    budget: {
      turnBudget: null,
      tokenBudget: null,
      wallClockBudgetMs: null,
    },
    ...overrides,
  } as GoalSnapshot;
}

function lines(g: GoalSnapshot): string {
  return strip(buildGoalReportLines(g));
}

describe('buildGoalReportLines', () => {
  it('renders the objective as a blockquote and key counters for an active goal', () => {
    const out = lines(goal());
    expect(out).toContain('▌ Ship the goal status box');
    expect(out).toContain('Running');
    expect(out).toContain('4m 12s');
    expect(out).toContain('Turns');
    expect(out).toContain('128.4k'); // formatTokenCount
  });

  it('shows live writer/reviewer call usage and token budget for a Loop', () => {
    const out = lines(goal({
      stopCondition: 'proof-pass',
      providerUsage: {
        writerCalls: 3,
        reviewerCalls: 2,
        writerRetries: 1,
        reviewerRetries: 1,
        writerCallLimit: 12,
        reviewerCallLimit: 4,
        remainingWriterCalls: 9,
        remainingReviewerCalls: 2,
      },
      budget: {
        turnBudget: null,
        tokenBudget: 50_000,
        wallClockBudgetMs: null,
        remainingTokens: 37_500,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    }));

    expect(out).toContain('Writer calls');
    expect(out).toContain('3/12');
    expect(out).toContain('Reviewer calls');
    expect(out).toContain('2/4');
    expect(out).toContain('Retries');
    expect(out).toContain('2');
    expect(out).toContain('Token budget');
    expect(out).toContain('37.5k remaining of 50.0k');
    expect(out).not.toContain('Review usage');
  });

  it('shows a no-stop-condition note for an unbounded active goal', () => {
    expect(lines(goal())).toContain('No stop condition — runs until evaluated complete.');
  });

  it('shows a Stop row with progress when a turn budget is set', () => {
    const out = lines(goal({ budget: { turnBudget: 20, tokenBudget: null, wallClockBudgetMs: null } } as Partial<GoalSnapshot>));
    expect(out).toContain('Stop');
    expect(out).toContain('after 20 turns (7/20)');
    expect(out).not.toContain('No stop condition');
  });

  it('includes the completion criterion when present', () => {
    const out = lines(goal({ completionCriterion: 'tests pass' }));
    expect(out).toContain('✓ tests pass');
  });

  it('renders a terminal goal with a Status row and no Stop row', () => {
    const out = lines(goal({ status: 'complete', terminalReason: 'all done' }));
    expect(out).toContain('Status');
    expect(out).toContain('complete — all done');
    expect(out).not.toContain('No stop condition');
    expect(out).not.toMatch(/^Stop/m);
  });

  it('shows the reason for a paused goal when one exists', () => {
    const out = lines(goal({ status: 'paused', terminalReason: 'Paused after provider rate limit' }));
    expect(out).toContain('Status');
    expect(out).toContain('paused — Paused after provider rate limit');
  });

  it('titles the box with the status', () => {
    expect(goalPanelTitle(goal())).toBe(' Goal · active ');
    expect(goalPanelTitle(goal({ status: 'complete' }))).toBe(' Goal · complete ');
  });

  it('shows Loop status and decoded reason for a terminal Loop', () => {
    const terminal = goal({
      status: 'blocked',
      terminalReason: 'loop:NEEDS_WORK:max_iterations:Maximum Loop iterations reached.',
    });

    expect(goalPanelTitle(terminal)).toBe(' Loop · NEEDS_WORK ');
    const out = lines(terminal);
    expect(out).toContain('NEEDS_WORK — Maximum Loop iterations reached.');
    expect(out).not.toContain('loop:NEEDS_WORK');
  });

  it('shows the durable Loop blockers, fixes, continuation, and Next from the shared presentation', () => {
    const out = lines(goal({
      status: 'blocked',
      stopCondition: 'proof-pass',
      iteration: 4,
      maxIterations: 4,
      gateAttempts: 2,
      loopRunId: 'run-current',
      terminalReason: 'loop:NEEDS_WORK:max_iterations:Iteration ceiling reached.',
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-current',
        contractId: 'contract-1',
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        continuationPolicy: {
          mode: 'same-contract',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: ['one', 'two', 'three', 'four'],
        terminalDigest: 'terminal-digest',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        summary: 'Iteration ceiling reached.',
        iterations: 4,
        checks: [],
        evidence: {
          verification: 'fresh',
          reviewer: 'not_run',
          completeness: 'partial',
          fresh: false,
          expectedProducers: ['required-checks', 'fresh-reviewer', 'workspace-freshness'],
          observedProducers: ['required-checks'],
          missingProducers: ['fresh-reviewer', 'workspace-freshness'],
        },
        blockers: [
          { id: 'one', kind: 'check', summary: 'First blocker.', nextAction: 'Fix first.' },
          { id: 'two', kind: 'review', summary: 'Second blocker.', nextAction: 'Fix second.' },
          { id: 'three', kind: 'workspace', summary: 'Third blocker.', nextAction: 'Fix third.' },
          { id: 'four', kind: 'risk', summary: 'Fourth blocker.', nextAction: 'Fix fourth.' },
        ],
      },
    }));

    expect(out).toContain('Outcome    NEEDS_WORK');
    expect(out).toContain('Reason     Iteration ceiling reached.');
    expect(out).toContain(
      'Evidence   completeness partial; fresh no; verification fresh; reviewer not_run; missing fresh-reviewer, workspace-freshness',
    );
    expect(out).toContain('Blockers   4');
    expect(out).toContain('Blocker 1  First blocker.');
    expect(out).toContain('Fix        Fix first.');
    expect(out).toContain('Blocker 2  Second blocker.');
    expect(out).toContain('Blocker 3  Third blocker.');
    expect(out).not.toContain('Fourth blocker.');
    expect(out).toContain('More       1 additional blocker(s)');
    expect(out).toContain('Continue   same-contract');
    expect(out).toContain('Next       Address every blocker');
    expect(out).toContain('/loop resume');
  });

  it('does not present a previous-run Loop result as the current terminal result', () => {
    const out = lines(goal({
      status: 'blocked',
      stopCondition: 'proof-pass',
      loopRunId: 'run-current',
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-current',
        contractId: 'contract-1',
        status: 'ERROR',
        reasonCode: 'runtime_error',
        continuationPolicy: {
          mode: 'blocked',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: [],
        terminalDigest: 'terminal-digest',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        summary: 'Stale previous-run result.',
        iterations: 3,
        checks: [],
        blockers: [{
          id: 'stale',
          kind: 'check',
          summary: 'Stale blocker.',
          nextAction: 'Do not show this as current.',
        }],
      },
    }));

    expect(out).toContain('Last gate  NEEDS_WORK');
    expect(out).not.toContain('Blockers');
    expect(out).not.toContain('Stale blocker.');
    expect(out).not.toContain('Continue');
    expect(out).not.toMatch(/^Next/m);
  });

  it('truncates a very long objective with an ellipsis', () => {
    const long = 'word '.repeat(200).trim();
    const out = lines(goal({ objective: long }));
    expect(out).toContain('…');
  });
});

describe('GoalSetMessageComponent', () => {
  it('renders a marker-style lifecycle line without repeating the objective', () => {
    const rendered = new GoalSetMessageComponent().render(60);
    // Leading blank line separates it from the line above.
    expect(rendered[0]).toBe('');
    expect(strip(rendered)).toBe('\n● Goal set');
  });

  it('renders the marker and label in the primary accent', () => {
    const rendered = new GoalSetMessageComponent().render(60);

    expect(rendered[1]).toBe(
      chalk.hex(darkColors.primary).bold(STATUS_BULLET) +
        chalk.hex(darkColors.primary).bold('Goal set'),
    );
  });

  it('keeps the lifecycle line within narrow widths', () => {
    for (const width of [39, 20, 10, 4]) {
      for (const line of new GoalSetMessageComponent().render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('UpcomingGoalAddedMessageComponent', () => {
  it('renders the upcoming-goal confirmation like the goal-set lifecycle line', () => {
    const rendered = new UpcomingGoalAddedMessageComponent().render(80);

    expect(strip(rendered)).toBe(
      '\n● Upcoming goal added. It will start after the current goal is complete.',
    );
    expect(rendered[1]).toBe(
      chalk.hex(darkColors.primary).bold(STATUS_BULLET) +
        chalk.hex(darkColors.primary).bold(
          'Upcoming goal added. It will start after the current goal is complete.',
        ),
    );
  });

  it('wraps the upcoming-goal confirmation within narrow widths', () => {
    for (const width of [39, 20, 10, 4]) {
      for (const line of new UpcomingGoalAddedMessageComponent().render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('GoalStatusMessageComponent', () => {
  it('adds a blank line before the status box', () => {
    const rendered = new GoalStatusMessageComponent(goal()).render(80);

    expect(rendered[0]).toBe('');
    expect(strip([rendered[1]!])).toContain('╭ Goal · active ');
  });

  it('wraps objective blockquotes without clipping them at 80 columns', () => {
    const rendered = new GoalStatusMessageComponent(
      goal({ objective: 'word '.repeat(30).trim() }),
    ).render(80);

    expect(strip(rendered)).not.toContain('...');
  });

  it('keeps the status box within narrow widths', () => {
    const rendered = new GoalStatusMessageComponent(goal({ objective: '管理飞书日历的技能描述 '.repeat(4).trim() }));

    for (const width of [39, 24, 20, 10]) {
      for (const line of rendered.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('GoalCompletionMessageComponent', () => {
  it('renders the completion headline in green and keeps the stats line indented', () => {
    const message = '✓ Goal complete.\nWorked 1 turn over 2m28s, using 766.9k tokens.';
    const rendered = new GoalCompletionMessageComponent(message).render(80);

    expect(rendered[0]).toBe('');
    expect(rendered[1]?.trimEnd()).toBe(
      chalk.hex(darkColors.success).bold(STATUS_BULLET) +
        chalk.hex(darkColors.success).bold('✓ Goal complete.'),
    );
    expect(strip([rendered[2]!]).trimEnd()).toBe(
      '  Worked 1 turn over 2m28s, using 766.9k tokens.',
    );
  });
});
