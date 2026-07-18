import { describe, expect, it } from 'vitest';

import type { GoalSnapshot } from '@wukong/wukong-sdk';

import { ChromeStateAggregator } from '#/tui/utils/chrome-state';
import type { StatEvent, TodayBriefing } from '#/utils/stats';

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship it',
    status: 'active',
    iteration: 3,
    turnsUsed: 3,
    tokensUsed: 100,
    wallClockMs: 42_000,
    budget: {
      turnBudget: null,
      tokenBudget: null,
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

function briefing(): TodayBriefing {
  return {
    date: '2026-07-09',
    focus: null,
    workspace: { cwd: '/repo', changedFiles: 0 },
    today: {
      verify: { runs: 0, passed: 0, failed: 0 },
      scan: { runs: 0, blocked: 0 },
      proof: { runs: 0 },
      guard: { blocked: 0, allowed: 0 },
      goals: { completed: 0, inProgress: 0 },
    },
    streak: 0,
    next: [],
  };
}

describe('ChromeStateAggregator', () => {
  it('hydrates the newest verify and proof from a newest-first event list', async () => {
    const events: StatEvent[] = [
      {
        type: 'verify',
        status: 'passed',
        timestamp: '2026-07-09T12:00:00.000Z',
        date: '2026-07-09',
        cwd: '/repo',
      },
      {
        type: 'proof',
        status: 'pass',
        summary: 'latest proof',
        timestamp: '2026-07-09T11:59:00.000Z',
        date: '2026-07-09',
        cwd: '/repo',
      },
      {
        type: 'verify',
        status: 'failed',
        timestamp: '2026-07-09T10:00:00.000Z',
        date: '2026-07-09',
        cwd: '/repo',
      },
      {
        type: 'proof',
        status: 'blocked',
        summary: 'old proof',
        timestamp: '2026-07-09T09:00:00.000Z',
        date: '2026-07-09',
        cwd: '/repo',
      },
    ];

    const agg = new ChromeStateAggregator({
      cwd: '/repo',
      readStatsEvents: () => events,
      buildTodayBriefing: async () => briefing(),
    });
    await agg.hydrate();

    const state = agg.getState();
    expect(state.lastVerify?.status).toBe('passed');
    expect(state.lastProof?.status).toBe('pass');
    expect(state.lastProof?.summary).toBe('latest proof');
  });

  it('uses GoalSnapshot.wallClockMs as-is for active goals (no double-count)', () => {
    const agg = new ChromeStateAggregator({ cwd: '/repo' });
    agg.setGoal(goal({ wallClockMs: 42_000, stopCondition: 'verify-pass' }));

    const phase = agg.getState().loopPhase;
    expect(phase?.elapsedMs).toBe(42_000);
  });

  it('records verify/proof/scan events through the injected recorder', () => {
    const recorded: StatEvent[] = [];
    const agg = new ChromeStateAggregator({
      cwd: '/repo',
      recordStatEvent: (event) => {
        recorded.push(event);
      },
    });

    agg.recordVerify('passed', 'ok');
    agg.recordScan('failed');
    agg.recordProof('blocked', 'needs review');
    agg.recordGoal('blocked');

    expect(recorded.map((e) => e.type)).toEqual(['verify', 'scan', 'proof', 'goal']);
    expect(agg.getState().lastVerify?.status).toBe('passed');
    expect(agg.getState().lastProof?.status).toBe('blocked');
  });

  it('clears evidence when a different Loop starts', () => {
    const agg = new ChromeStateAggregator({ cwd: '/repo' });
    agg.setGoal(goal({ goalId: 'old-goal' }));
    agg.recordVerify('failed', 'old failure');
    agg.recordProof('blocked', 'old blocker');

    agg.setGoal(goal({ goalId: 'new-goal', iteration: 1 }));

    expect(agg.getState().lastVerify).toBeNull();
    expect(agg.getState().lastProof).toBeNull();
  });

  it('swallows stats read failures during hydrate', async () => {
    const agg = new ChromeStateAggregator({
      cwd: '/repo',
      readStatsEvents: () => {
        throw new Error('EACCES');
      },
      buildTodayBriefing: async () => briefing(),
    });

    await expect(agg.hydrate()).resolves.toBeUndefined();
    expect(agg.getState().lastVerify).toBeNull();
    expect(agg.getState().todayBriefing).not.toBeNull();
  });

  it('derives blocked uiMode from goal status', () => {
    const agg = new ChromeStateAggregator({ cwd: '/repo' });
    agg.setGoal(goal({ status: 'blocked', terminalReason: 'budget' }));
    expect(agg.getState().uiMode).toBe('blocked');
    expect(agg.getState().loopPhase?.phase).toBe('blocked');
    expect(agg.getState().loopPhase?.blockedReason).toBe('budget');
    expect(agg.getState().loopPhase?.objective).toBe('Ship it');
    expect(agg.getState().loopPhase?.nextAction).toBe('/goal resume or /loop stop');
  });

  it('decodes Loop terminal reasons for chrome state', () => {
    const agg = new ChromeStateAggregator({ cwd: '/repo' });
    agg.setGoal(goal({
      status: 'blocked',
      terminalReason: 'loop:ERROR:workspace_changed:Workspace changed during checks.',
    }));

    expect(agg.getState().loopPhase?.blockedReason).toBe('Workspace changed during checks.');
    expect(agg.getState().loopPhase?.nextAction).toBe('Stop other workspace writers, then rerun the Loop.');
  });

  it('makes paused goals visually distinct from waiting work', () => {
    const agg = new ChromeStateAggregator({ cwd: '/repo' });
    agg.setGoal(goal({ status: 'paused' }));
    expect(agg.getState().uiMode).toBe('active');
    expect(agg.getState().loopPhase?.phase).toBe('paused');
  });
});
