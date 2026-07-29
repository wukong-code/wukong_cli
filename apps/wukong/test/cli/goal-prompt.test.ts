import { describe, expect, it } from 'vitest';

import {
  formatGoalSummaryText,
  goalExitCode,
  GOAL_EXIT_CODES,
  goalSummaryJson,
  LOOP_EXIT_CODES,
  loopExitCode,
  loopSummaryJson,
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
      kind: 'goal',
      objective: 'write tests',
      replace: false,
    });
  });

  it('parses replace goals', () => {
    expect(parseHeadlessGoalCreate('/goal replace fix the bug')).toEqual({
      kind: 'goal',
      objective: 'fix the bug',
      replace: true,
    });
  });

  it('parses stop conditions', () => {
    expect(parseHeadlessGoalCreate('/goal --until verify-pass ship it')).toEqual({
      kind: 'goal',
      objective: 'ship it',
      replace: false,
      stopCondition: 'proof-pass',
    });
  });

  it('parses Loop as a headless goal with the delivery gate', () => {
    expect(parseHeadlessGoalCreate('/loop --max-iterations 5 fix the tests')).toEqual({
      kind: 'loop',
      objective: 'fix the tests',
      replace: false,
      stopCondition: 'proof-pass',
      maxIterations: 5,
    });
  });

  it('ignores status subcommand', () => {
    expect(parseHeadlessGoalCreate('/goal status')).toBeUndefined();
  });
});

describe('Loop result contract', () => {
  it('maps a completed Loop to PASS and exit 0', () => {
    const snapshot = {
      status: 'complete',
      terminalReason: 'loop:PASS:passed:Delivery gate passed.',
      iteration: 2,
    } as any;

    expect(loopSummaryJson(snapshot)).toMatchObject({
      type: 'loop.result',
      schemaVersion: 2,
      status: 'PASS',
      reasonCode: 'passed',
      iterations: 2,
      blockers: [],
    });
    expect(loopExitCode(snapshot)).toBe(LOOP_EXIT_CODES.PASS);
  });

  it('maps max iterations to NEEDS_WORK and exit 1', () => {
    const snapshot = {
      status: 'blocked',
      terminalReason: 'loop:NEEDS_WORK:max_iterations:Maximum Loop iterations reached.',
      iteration: 5,
    } as any;

    expect(loopSummaryJson(snapshot)).toMatchObject({
      status: 'NEEDS_WORK',
      reasonCode: 'max_iterations',
      iterations: 5,
    });
    expect(loopExitCode(snapshot)).toBe(LOOP_EXIT_CODES.NEEDS_WORK);
  });

  it('maps delivery runtime failures to ERROR and exit 2', () => {
    const snapshot = {
      status: 'blocked',
      terminalReason: 'loop:ERROR:workspace_changed:Workspace changed.',
      iteration: 1,
    } as any;

    expect(loopSummaryJson(snapshot)).toMatchObject({
      status: 'ERROR',
      reasonCode: 'workspace_changed',
    });
    expect(loopExitCode(snapshot)).toBe(LOOP_EXIT_CODES.ERROR);
  });

  it('redacts durable diagnostics from stream-json/public Loop summaries', () => {
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const url =
      `https://alice:${secret}@example.test/v1?token=${secret}`;
    const snapshot = {
      status: 'blocked',
      iteration: 1,
      loopResult: {
        schemaVersion: 2,
        status: 'ERROR',
        reasonCode: secret,
        summary:
          `exception from ${url} {"AWS_SECRET_ACCESS_KEY":"${awsSecret}"}`,
        iterations: 1,
        checks: [{
          command: `OPENAI_API_KEY=${secret} npm test`,
          status: 'failed',
          exitCode: 1,
          durationMs: 10,
        }],
        blockers: [{
          id: secret,
          kind: 'check',
          summary: `Authorization: Bearer ${secret}`,
          evidence: `stderr=${secret}`,
          nextAction: `retry ${url}`,
        }],
      },
    } as any;

    const serialized = JSON.stringify(loopSummaryJson(snapshot));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(awsSecret);
    expect(serialized).not.toContain('alice');
    expect(serialized).toContain('[REDACTED]');
    expect(loopSummaryJson(snapshot).reasonCode).toBe('runtime_error');
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

  it('redacts terminal exceptions in public goal summaries', () => {
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const snapshot = {
      goalId: 'goal-privacy',
      status: 'blocked',
      terminalReason:
        `Authorization: Bearer ${secret} OPENAI_API_KEY=${secret}`,
      turnsUsed: 1,
      tokensUsed: 2,
      wallClockMs: 3,
    } as any;
    const serialized = JSON.stringify(goalSummaryJson(snapshot));

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
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
