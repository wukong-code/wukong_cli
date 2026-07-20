import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';
import { ChromeStateAggregator } from '#/tui/utils/chrome-state';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
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

function makeChromeState(): ChromeStateAggregator {
  return new ChromeStateAggregator({ cwd: '/tmp/proj' });
}

describe('FooterComponent — unified Task Plane status', () => {
  it('omits task status when counts are 0', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    const out = strip(footer.render(120).join('\n'));
    expect(out).not.toMatch(/◎ \d+ tasks?/);
  });

  it('renders commands in one task status', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 0 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toContain('◎ 1 task · 1 command');
  });

  it('renders agents in one task status', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 1 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toContain('◎ 1 task · 1 agent');
  });

  it('combines agents and commands without duplicate status lines', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toContain('◎ 5 tasks · 3 agents · 2 commands');
    expect(out.match(/◎/g)).toHaveLength(1);
  });

  it('pluralizes correctly', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 1 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toContain('◎ 2 tasks · 1 agent · 1 command');
  });

  it('updates task status live via setBackgroundCounts', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1 });
    expect(strip(footer.render(120)[0]!)).toContain('◎ 3 tasks');
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    const after = strip(footer.render(120)[0]!);
    expect(after).not.toMatch(/◎ \d+ tasks?/);
  });

  it('clamps negative counts to 0', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: -5, agentTasks: -2 });
    const out = strip(footer.render(120)[0]!);
    expect(out).not.toMatch(/◎ \d+ tasks?/);
  });

  it('drops task detail when terminal is too narrow to fit it', () => {
    const footer = new FooterComponent(baseState(), makeChromeState());
    footer.setBackgroundCounts({ bashTasks: 4, agentTasks: 3 });
    // At a narrow width the env line is truncated and badges may be dropped.
    const out = strip(footer.render(20).join('\n'));
    expect(out).not.toContain('3 agents');
    expect(out).not.toContain('4 commands');
  });
});
