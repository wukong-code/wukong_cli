import { describe, expect, it } from 'vitest';

import {
  formatGoalSummaryText,
  formatLoopResultText,
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

  it('fails closed for unknown or non-terminal statuses', () => {
    expect(goalExitCode('running')).toBe(GOAL_EXIT_CODES.error);
  });

  it('fails closed when the durable goal is missing', () => {
    expect(goalExitCode(undefined)).toBe(GOAL_EXIT_CODES.error);
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
      loopRunId: 'run-pass',
      iteration: 2,
      wallClockMs: 100,
      tokensUsed: 10,
      gateAttempts: 2,
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-pass',
        contractId: 'contract-1',
        status: 'PASS',
        reasonCode: 'passed',
        continuationPolicy: {
          mode: 'blocked',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: [],
        terminalDigest: 'sha256:terminal-pass',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Delivery gate passed.',
        iterations: 2,
        checks: [],
        blockers: [],
      },
    } as any;

    expect(loopSummaryJson(snapshot)).toMatchObject({
      type: 'loop.result',
      schemaVersion: 2,
      status: 'PASS',
      reasonCode: 'passed',
      iterations: 2,
      writerIterations: 2,
      gateAttempts: 2,
      blockers: [],
    });
    expect(loopExitCode(snapshot)).toBe(LOOP_EXIT_CODES.PASS);
  });

  it('reports exact provider-call and token usage in JSON and text Loop results', () => {
    const snapshot = {
      status: 'blocked',
      terminalReason: 'loop:NEEDS_WORK:budget_exhausted:Budget exhausted.',
      loopRunId: 'run-budget',
      iteration: 3,
      wallClockMs: 100,
      tokensUsed: 12_500,
      budget: { tokenBudget: 50_000, remainingTokens: 37_500 },
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
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-budget',
        contractId: 'contract-budget',
        status: 'NEEDS_WORK',
        reasonCode: 'budget_exhausted',
        continuationPolicy: {
          mode: 'same-contract',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: [],
        terminalDigest: 'sha256:terminal-budget',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'budget_exhausted',
        summary: 'Budget exhausted.',
        iterations: 3,
        checks: [],
        blockers: [],
      },
    } as any;

    const result = loopSummaryJson(snapshot);
    expect(result).toMatchObject({
      providerUsage: snapshot.providerUsage,
      tokenBudget: 50_000,
      remainingTokens: 37_500,
    });
    expect(formatLoopResultText(result)).toContain(
      'Usage      Writer calls 3/12 (9 remaining) · Reviewer calls 2/4 (2 remaining) · Retries 2 · Tokens 12500/50000 (37500 remaining)',
    );
  });

  it('shows Gate completeness, freshness, and missing producers in headless results', () => {
    const result = loopSummaryJson({
      status: 'blocked',
      terminalReason: 'loop:NEEDS_WORK:reviewer_invalid:Reviewer output was invalid.',
      loopRunId: 'run-evidence',
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-evidence',
        contractId: 'contract-evidence',
        status: 'NEEDS_WORK',
        reasonCode: 'reviewer_invalid',
        continuationPolicy: {
          mode: 'same-contract',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: [],
        terminalDigest: 'sha256:terminal-evidence',
        createdAt: 1,
      },
      iteration: 1,
      wallClockMs: 10,
      tokensUsed: 20,
      budget: { tokenBudget: null, remainingTokens: null },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'reviewer_invalid',
        summary: 'Reviewer output was invalid.',
        iterations: 1,
        checks: [],
        blockers: [],
        evidence: {
          verification: 'fresh',
          reviewer: 'not_run',
          completeness: 'partial',
          fresh: false,
          expectedProducers: ['required-checks', 'fresh-reviewer', 'workspace-freshness'],
          observedProducers: ['required-checks'],
          missingProducers: ['fresh-reviewer', 'workspace-freshness'],
        },
      },
    } as any);

    expect(result.evidence).toMatchObject({
      completeness: 'partial',
      fresh: false,
      missingProducers: ['fresh-reviewer', 'workspace-freshness'],
    });
    expect(formatLoopResultText(result)).toContain(
      'Evidence   completeness partial; fresh no; verification fresh; reviewer not_run; missing fresh-reviewer, workspace-freshness',
    );
    expect(formatLoopResultText(result)).toContain(
      'Unverified Missing Gate producers: fresh-reviewer, workspace-freshness.',
    );
  });

  it('labels Loop-introduced and pre-existing changed files separately', () => {
    const text = formatLoopResultText({
      type: 'loop.result',
      schemaVersion: 2,
      status: 'NEEDS_WORK',
      reasonCode: 'checks_failed',
      summary: 'Checks failed.',
      iterations: 1,
      writerIterations: 1,
      gateAttempts: 1,
      continuationMode: 'same-contract',
      nextAction: 'Fix checks.',
      checks: [],
      changedFiles: [
        {
          path: 'src/new.ts', status: '??', attribution: 'introduced_by_loop',
          preExisting: false, touchedByLoop: true,
        },
        {
          path: 'src/existing.ts', status: 'M', attribution: 'modified_by_loop',
          preExisting: true, touchedByLoop: true,
        },
        {
          path: 'src/deleted.ts', status: 'D', attribution: 'deleted_by_loop',
          preExisting: false, touchedByLoop: true,
        },
        { path: 'src/unknown.ts', status: 'M', attribution: 'unknown' },
      ],
      evidence: { verification: 'not_run', reviewer: 'not_run' },
      durationMs: 1,
      tokensUsed: 10,
      providerUsage: null,
      tokenBudget: null,
      remainingTokens: null,
      blockers: [],
    });

    expect(text).toContain('?? src/new.ts [introduced by Loop]');
    expect(text).toContain('M src/existing.ts [pre-existing; modified by Loop]');
    expect(text).toContain('D src/deleted.ts [deleted by Loop]');
    expect(text).toContain('M src/unknown.ts [attribution unavailable]');
  });

  it('maps max iterations to NEEDS_WORK and exit 1', () => {
    const snapshot = {
      status: 'blocked',
      terminalReason: 'loop:NEEDS_WORK:max_iterations:Maximum Loop iterations reached.',
      loopRunId: 'run-max-iterations',
      iteration: 5,
      wallClockMs: 100,
      tokensUsed: 10,
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-max-iterations',
        contractId: 'contract-1',
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        continuationPolicy: {
          mode: 'same-contract',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: [],
        terminalDigest: 'sha256:terminal-max-iterations',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        summary: 'Maximum Loop iterations reached.',
        iterations: 5,
        checks: [],
        blockers: [],
      },
    } as any;

    expect(loopSummaryJson(snapshot)).toMatchObject({
      status: 'NEEDS_WORK',
      reasonCode: 'max_iterations',
      iterations: 5,
      writerIterations: 5,
    });
    expect(loopExitCode(snapshot)).toBe(LOOP_EXIT_CODES.NEEDS_WORK);
  });

  it('maps delivery runtime failures to ERROR and exit 2', () => {
    const snapshot = {
      status: 'blocked',
      terminalReason: 'loop:ERROR:workspace_changed:Workspace changed.',
      loopRunId: 'run-workspace-changed',
      iteration: 1,
      wallClockMs: 100,
      tokensUsed: 10,
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-workspace-changed',
        contractId: 'contract-1',
        status: 'ERROR',
        reasonCode: 'workspace_changed',
        continuationPolicy: {
          mode: 'blocked',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: [],
        terminalDigest: 'sha256:terminal-workspace-changed',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'ERROR',
        reasonCode: 'workspace_changed',
        summary: 'Workspace changed.',
        iterations: 1,
        checks: [],
        blockers: [],
      },
    } as any;

    expect(loopSummaryJson(snapshot)).toMatchObject({
      status: 'ERROR',
      reasonCode: 'workspace_changed',
    });
    expect(loopExitCode(snapshot)).toBe(LOOP_EXIT_CODES.ERROR);
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
