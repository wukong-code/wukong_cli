import { afterEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { GoalSnapshot } from '@wukong/wukong-sdk';
import type { AppState } from '#/tui/types';
import { ChromeStateAggregator } from '#/tui/utils/chrome-state';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship it',
    status: 'active',
    iteration: 7,
    turnsUsed: 7,
    tokensUsed: 1234,
    wallClockMs: 245_000, // 4m05s
    budget: {
      turnBudget: null,
      tokenBudget: null,
      wallClockBudgetMs: null,
    },
    ...overrides,
  } as GoalSnapshot;
}

function makeChromeState(goal?: GoalSnapshot | null): ChromeStateAggregator {
  const agg = new ChromeStateAggregator({ cwd: '/tmp/proj' });
  agg.setGoal(goal ?? null);
  return agg;
}

describe('FooterComponent — goal track', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits the goal track when there is no goal', () => {
    const footer = new FooterComponent(baseState({ goal: null }), makeChromeState(null));
    const out = strip(footer.render(160).join('\n'));
    expect(out).not.toContain('Goal:');
    expect(out).not.toContain('Goal ● blocked');
  });

  it('shows the objective and iteration for an active goal', () => {
    const footer = new FooterComponent(baseState({ goal: goal() }), makeChromeState(goal()));
    const out = strip(footer.render(160).join('\n'));
    expect(out).toContain('Goal: Ship it');
    expect(out).toMatch(/Goal: Ship it · 7\b/);
  });

  it('requests a repaint while an active goal timer is visible', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();

    new FooterComponent(
      baseState({ goal: goal({ wallClockMs: 0 }) }),
      makeChromeState(goal({ wallClockMs: 0 })),
      onRefresh,
    );

    vi.advanceTimersByTime(1_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows used/limit iterations only when an iteration budget is set', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ maxIterations: 20 }) }),
      makeChromeState(goal({ maxIterations: 20 })),
    );
    expect(strip(footer.render(160).join('\n'))).toContain('7/20');
  });

  it('shows a paused goal track', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ status: 'paused' }) }),
      makeChromeState(goal({ status: 'paused' })),
    );
    expect(strip(footer.render(160).join('\n'))).toContain('Goal: Ship it');
  });

  it('shows a blocked goal track', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ status: 'blocked' }) }),
      makeChromeState(goal({ status: 'blocked' })),
    );
    const out = strip(footer.render(160).join('\n'));
    expect(out).toContain('Goal ● blocked');
  });

  it('hides the goal track for a completed goal', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ status: 'complete' }) }),
      makeChromeState(goal({ status: 'complete' })),
    );
    expect(strip(footer.render(160).join('\n'))).not.toContain('Goal:');
  });

  it('renders a single iteration without plural', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ iteration: 1 }) }),
      makeChromeState(goal({ iteration: 1 })),
    );
    const out = strip(footer.render(160).join('\n'));
    expect(out).toMatch(/Goal: Ship it · 1\b/);
  });
});
