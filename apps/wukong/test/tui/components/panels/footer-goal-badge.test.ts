import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { LoopPhaseComponent } from '#/tui/components/chrome/loop-phase';
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

function renderPhase(chromeState: ChromeStateAggregator, width = 160): string {
  const phase = chromeState.getState().loopPhase;
  if (phase === null) return '';
  return strip(new LoopPhaseComponent(phase).render(width).join('\n'));
}

describe('FooterComponent — goal and evidence tracks', () => {
  it('omits the evidence track when there is no goal', () => {
    const footer = new FooterComponent(baseState({ goal: null }), makeChromeState(null));
    const out = strip(footer.render(160).join('\n'));
    expect(out).not.toContain('Gate ');
  });

  it('moves the active objective and iteration to the phase rail', () => {
    const chromeState = makeChromeState(goal());
    const footer = new FooterComponent(baseState({ goal: goal() }), chromeState);
    const out = strip(footer.render(160).join('\n'));
    const phase = renderPhase(chromeState);
    expect(footer.render(160)).toHaveLength(2);
    expect(out).toContain('Gate self');
    expect(out).not.toContain('Ship it');
    expect(phase).toContain('◐ 7  WAIT  4m');
    expect(phase).toContain('Ship it');
  });

  it('shows used/limit iterations in the phase rail when a budget is set', () => {
    const chromeState = makeChromeState(goal({ maxIterations: 20 }));
    expect(renderPhase(chromeState)).toContain('7/20');
  });

  it('makes paused state explicit in the phase rail', () => {
    const chromeState = makeChromeState(goal({ status: 'paused' }));
    expect(renderPhase(chromeState)).toContain('Ⅱ 7  PAUSED');
  });

  it('shows a blocked state with an actionable recovery hint', () => {
    const chromeState = makeChromeState(
      goal({ status: 'blocked', terminalReason: 'budget reached' }),
    );
    const phase = renderPhase(chromeState);
    expect(phase).toContain('⛔ 7  BLOCKED');
    expect(phase).toContain('budget reached');
    expect(phase).toContain('Next: /goal resume or /loop stop');
    expect(renderPhase(chromeState, 72)).toContain('Next: /goal resume or /loop stop');
  });

  it('hides goal chrome for a completed goal', () => {
    const footer = new FooterComponent(
      baseState({ goal: goal({ status: 'complete' }) }),
      makeChromeState(goal({ status: 'complete' })),
    );
    expect(strip(footer.render(160).join('\n'))).not.toContain('Gate ');
    expect(renderPhase(makeChromeState(goal({ status: 'complete' })))).toBe('');
  });

  it('renders a single iteration without extra copy', () => {
    const chromeState = makeChromeState(goal({ iteration: 1 }));
    expect(renderPhase(chromeState)).toContain('◐ 1  WAIT');
  });

  it('shows the configured deterministic gate in the evidence rail', () => {
    const gatedGoal = goal({ stopCondition: 'verify-pass' });
    const footer = new FooterComponent(baseState({ goal: gatedGoal }), makeChromeState(gatedGoal));
    expect(strip(footer.render(160).join('\n'))).toContain('Gate verify-pass');
  });

  it('uses Loop language and keeps checks separate from review', () => {
    const gatedGoal = goal({ stopCondition: 'proof-pass' });
    const chromeState = makeChromeState(gatedGoal);
    chromeState.recordVerify('passed');
    chromeState.recordProof('blocked', 'High-risk finding: unfinished marker (src/app.ts:4).');

    const out = strip(new FooterComponent(baseState({ goal: gatedGoal }), chromeState).render(200).join('\n'));

    expect(out).toContain('Loop gate');
    expect(out).toContain('Checks PASS');
    expect(out).toContain('Review BLOCKED');
    expect(out).toContain('src/app.ts:4');
    expect(out).not.toContain('Gate proof-pass');
    expect(out).not.toContain('Verify');
    expect(out).not.toContain('Proof');
  });
});
