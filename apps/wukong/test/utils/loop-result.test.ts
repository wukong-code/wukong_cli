import { describe, expect, it } from 'vitest';
import type { GoalSnapshot } from '@wukong/wukong-sdk';

import { loopOutcomeFromGoal } from '#/utils/loop-result';

function goal(overrides: Partial<GoalSnapshot>): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective: 'ship safely',
    iteration: 1,
    status: 'complete',
    turnsUsed: 1,
    tokensUsed: 1,
    wallClockMs: 1,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    ...overrides,
  };
}

function terminal(
  status: 'PASS' | 'NEEDS_WORK' | 'ERROR',
  reasonCode: string,
  runId = 'run-1',
): NonNullable<GoalSnapshot['loopTerminal']> {
  return {
    schemaVersion: 1,
    runId,
    contractId: 'contract-1',
    status,
    reasonCode,
    continuationPolicy: {
      mode: status === 'PASS' ? 'blocked' : 'same-contract',
      automaticRetry: false,
      requiresPreflightRevalidation: true,
    },
    blockerKeys: [],
    terminalDigest: 'sha256:terminal',
    createdAt: 1,
  };
}

describe('loopOutcomeFromGoal', () => {
  it('fails closed when complete has no durable result', () => {
    expect(loopOutcomeFromGoal(goal({ status: 'complete' }))).toEqual({
      status: 'ERROR',
      reasonCode: 'result_missing',
      summary: 'Loop reported completion without a durable Gate result.',
    });
  });

  it('uses a LoopResult bound to the current durable terminal', () => {
    expect(loopOutcomeFromGoal(goal({
      loopRunId: 'run-1',
      loopTerminal: terminal('PASS', 'passed'),
      loopResult: {
        schemaVersion: 2,
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Gate passed.',
        iterations: 1,
        checks: [],
        blockers: [],
      },
    }))).toMatchObject({ status: 'PASS', reasonCode: 'passed' });
  });

  it('fails closed in the crash window before the terminal is durable', () => {
    expect(loopOutcomeFromGoal(goal({
      status: 'paused',
      loopRunId: 'run-1',
      loopResult: {
        schemaVersion: 2,
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Gate passed.',
        iterations: 1,
        checks: [],
        blockers: [],
      },
    }))).toMatchObject({ status: 'ERROR', reasonCode: 'result_missing' });
  });

  it('rejects a LoopResult and terminal carried from a previous run', () => {
    expect(loopOutcomeFromGoal(goal({
      loopRunId: 'run-2',
      loopTerminal: terminal('PASS', 'passed', 'run-1'),
      loopResult: {
        schemaVersion: 2,
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Gate passed.',
        iterations: 1,
        checks: [],
        blockers: [],
      },
    }))).toMatchObject({ status: 'ERROR', reasonCode: 'result_missing' });
  });

  it('does not expose PASS before the goal commit is complete', () => {
    expect(loopOutcomeFromGoal(goal({
      status: 'paused',
      loopRunId: 'run-1',
      loopTerminal: terminal('PASS', 'passed'),
      loopResult: {
        schemaVersion: 2,
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Gate passed.',
        iterations: 1,
        checks: [],
        blockers: [],
      },
    }))).toMatchObject({ status: 'ERROR', reasonCode: 'result_missing' });
  });

  it('rejects an encoded PASS that is not bound to the durable terminal', () => {
    expect(loopOutcomeFromGoal(goal({
      terminalReason: 'loop:PASS:passed:Gate passed.',
    }))).toMatchObject({ status: 'ERROR', reasonCode: 'result_missing' });
  });
});
