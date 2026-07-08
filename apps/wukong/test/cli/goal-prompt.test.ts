import { describe, expect, it } from 'vitest';

import {
  formatGoalSummaryText,
  goalExitCode,
  GOAL_EXIT_CODES,
  goalSummaryJson,
  parseHeadlessGoalCreate,
} from '#/cli/goal-prompt';

describe('goalExitCode', () => {
  it('maps complete to 0', () => {
    expect(goalExitCode('complete')).toBe(GOAL_EXIT_CODES.complete);
  });

  it('maps blocked to 3', () => {
    expect(goalExitCode('blocked')).toBe(GOAL_EXIT_CODES.blocked);
  });

  it('maps paused to 6', () => {
    expect(goalExitCode('paused')).toBe(GOAL_EXIT_CODES.paused);
  });

  it('defaults unknown statuses to 0', () => {
    expect(goalExitCode('running')).toBe(GOAL_EXIT_CODES.complete);
  });

  it('treats undefined as complete', () => {
    expect(goalExitCode(undefined)).toBe(GOAL_EXIT_CODES.complete);
  });
});

describe('parseHeadlessGoalCreate', () => {
  it('returns undefined for non-goal prompts', () => {
    expect(parseHeadlessGoalCreate('hello world')).toBeUndefined();
  });

  it('returns undefined for empty goal prompts', () => {
    expect(parseHeadlessGoalCreate('/goal')).toBeUndefined();
  });

  it('parses a plain objective', () => {
    expect(parseHeadlessGoalCreate('/goal write tests')).toEqual({
      objective: 'write tests',
      replace: false,
    });
  });

  it('parses replace goals', () => {
    expect(parseHeadlessGoalCreate('/goal replace fix the bug')).toEqual({
      objective: 'fix the bug',
      replace: true,
    });
  });

  it('parses stop conditions', () => {
    expect(parseHeadlessGoalCreate('/goal --until verify-pass ship it')).toEqual({
      objective: 'ship it',
      replace: false,
    });
  });

  it('ignores status subcommand', () => {
    expect(parseHeadlessGoalCreate('/goal status')).toBeUndefined();
  });
});

describe('goalSummaryJson', () => {
  it('returns null fields for a missing goal', () => {
    expect(goalSummaryJson(null)).toEqual({
      type: 'goal.summary',
      goalId: null,
      status: null,
      reason: null,
      turnsUsed: null,
      tokensUsed: null,
      wallClockMs: null,
    });
  });

  it('maps a goal snapshot', () => {
    const snapshot = {
      goalId: 'goal-123',
      status: 'blocked',
      terminalReason: 'budget exhausted',
      turnsUsed: 5,
      tokensUsed: 1200,
      wallClockMs: 3000,
    } as const;

    expect(goalSummaryJson(snapshot as any)).toEqual({
      type: 'goal.summary',
      goalId: 'goal-123',
      status: 'blocked',
      reason: 'budget exhausted',
      turnsUsed: 5,
      tokensUsed: 1200,
      wallClockMs: 3000,
    });
  });
});

describe('formatGoalSummaryText', () => {
  it('handles a missing goal', () => {
    expect(formatGoalSummaryText(null)).toBe('Goal: no goal found.');
  });

  it('renders status with counts', () => {
    const snapshot = {
      status: 'complete',
      terminalReason: undefined,
      turnsUsed: 3,
      tokensUsed: 900,
    } as const;

    expect(formatGoalSummaryText(snapshot as any)).toBe(
      'Goal [complete] (turns: 3, tokens: 900)',
    );
  });

  it('includes the terminal reason when present', () => {
    const snapshot = {
      status: 'blocked',
      terminalReason: 'max iterations reached',
      turnsUsed: 10,
      tokensUsed: 5000,
    } as const;

    expect(formatGoalSummaryText(snapshot as any)).toBe(
      'Goal [blocked]: max iterations reached (turns: 10, tokens: 5000)',
    );
  });
});
