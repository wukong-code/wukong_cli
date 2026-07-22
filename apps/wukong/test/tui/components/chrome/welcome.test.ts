import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { WUKONG_EMBLEM, renderWukongEmblem } from '#/tui/constant/welcome-art';
import type { AppState } from '#/tui/types';
import type { TodayBriefing } from '#/utils/stats';

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'wukong-k2',
  permissionMode: 'manual',
  thinking: false,
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function fakeBriefing(): TodayBriefing {
  return {
    date: '2026-07-09',
    focus: 'Ship it',
    workspace: { cwd: '/tmp/project', changedFiles: 2 },
    today: {
      verify: { runs: 3, passed: 2, failed: 1 },
      scan: { runs: 1, blocked: 0 },
      proof: { runs: 0 },
      guard: { blocked: 0, allowed: 0 },
      goals: { completed: 0, inProgress: 1 },
    },
    streak: 1,
    next: [],
  };
}

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('compresses the official 29 x 22 mascot into 29 x 11 half-block rows', () => {
    expect(WUKONG_EMBLEM).toHaveLength(11);
    expect(renderWukongEmblem()).toHaveLength(11);
    expect(Math.max(...WUKONG_EMBLEM.map((row) => visibleWidth(row)))).toBeLessThanOrEqual(29);
  });

  it('renders a compact Loop-first ready state', () => {
    const output = new WelcomeComponent(appState).render(80).join('\n');
    expect(output).toContain('Wukong Code');
    expect(output).toContain('Continue a task');
    expect(output).toContain('Start a Loop');
    expect(output).toContain('/loop <goal>');
    expect(output).toContain('Configure model');
    expect(output).toContain('/provider');
  });

  it('shows one workspace-matching foreign continuation suggestion', () => {
    const output = new WelcomeComponent({
      ...appState,
      resumeSuggestionSource: 'codex',
    }).render(80).join('\n');

    expect(output).toContain('Continue recent task from Codex');
    expect(output).toContain('/resume codex');
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('does not promote Today statistics when idle', () => {
    const lines = new WelcomeComponent(appState, fakeBriefing(), 'idle').render(80);
    const output = lines.join('\n');

    expect(output).toContain('Wukong Code');
    expect(output).toContain('/loop <goal>');
    expect(output).not.toContain('verify 3');
    expect(output).not.toContain('Focus: Ship it');
  });

  it('hides the welcome block when a goal is active', () => {
    const lines = new WelcomeComponent(appState, fakeBriefing(), 'active').render(80);
    expect(lines).toEqual([]);
  });

  it('updates the rendered block via setState', () => {
    const component = new WelcomeComponent(appState, fakeBriefing(), 'active');
    expect(component.render(80)).toEqual([]);

    component.setState(fakeBriefing(), 'idle');
    const idleOutput = component.render(80).join('\n');
    expect(idleOutput).toContain('Wukong Code');
    expect(idleOutput).toContain('/loop <goal>');
  });

  it('shows /provider as the required model setup and /login as optional', () => {
    const loggedOut = { ...appState, model: '' };
    const lines = new WelcomeComponent(loggedOut, fakeBriefing(), 'idle').render(80);
    const output = lines.join('\n');

    expect(lines.length).toBeLessThanOrEqual(6);
    expect(output).toContain('Setup required');
    expect(output).toContain('/provider configure model key');
    expect(output).toContain('/login optional account');
    expect(output).not.toContain('Today');
  });
});
