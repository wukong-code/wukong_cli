import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { WUKONG_MASCOT_PALETTE } from '#/constant/mascot';
import { WUKONG_EMBLEM, renderWukongEmblem } from '#/tui/constant/welcome-art';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import type { TodayBriefing } from '#/utils/stats';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;

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

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

function hexCode(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
}

/** The two header rows (logo + title) of the rendered welcome box. */
function headerOf(lines: string[]): string {
  return [lines[2], lines[3]].join('\n');
}

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('compresses the official 29 x 22 mascot into 29 x 11 half-block rows', () => {
    expect(WUKONG_EMBLEM).toHaveLength(11);
    expect(renderWukongEmblem()).toHaveLength(11);
    expect(Math.max(...WUKONG_EMBLEM.map((row) => visibleWidth(row)))).toBeLessThanOrEqual(29);
  });

  it('renders the official mascot palette by default', () => {
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    expect(codes).toContain(hexCode(WUKONG_MASCOT_PALETTE['g'] ?? ''));
    expect(codes).toContain(hexCode(WUKONG_MASCOT_PALETTE['G'] ?? ''));
    // The normal header uses the stable mascot palette plus title/tagline
    // colors. It must not fan out into the `/dance` rainbow.
    expect(codes.size).toBeLessThanOrEqual(4);
  });

  it('paints the banner in rainbow while colored', () => {
    setDanceView(true, 0);
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    expect(codes.size).toBeGreaterThanOrEqual(5);
  });

  it('renders exactly the default banner when not colored', () => {
    const base = headerOf(new WelcomeComponent(appState).render(80));
    setDanceView(false, 5);
    const off = headerOf(new WelcomeComponent(appState).render(80));

    expect(off).toBe(base);
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders a compact today block when idle and a briefing is present', () => {
    const lines = new WelcomeComponent(appState, fakeBriefing(), 'idle').render(80);
    const output = lines.join('\n');

    expect(output).toContain('Today');
    expect(output).toContain('verify 3 (2✓ 1✗)');
    expect(output).toContain('Focus: Ship it');
    expect(output).not.toContain('Wukong Code');
  });

  it('falls back to the welcome card when a goal is active', () => {
    const lines = new WelcomeComponent(appState, fakeBriefing(), 'active').render(80);
    const output = lines.join('\n');

    expect(output).toContain('Wukong Code');
    expect(output).not.toContain('verify 3 (2✓ 1✗)');
  });

  it('updates the rendered block via setState', () => {
    const component = new WelcomeComponent(appState, fakeBriefing(), 'active');
    const activeOutput = component.render(80).join('\n');
    expect(activeOutput).toContain('Wukong Code');

    component.setState(fakeBriefing(), 'idle');
    const idleOutput = component.render(80).join('\n');
    expect(idleOutput).toContain('verify 3 (2✓ 1✗)');
    expect(idleOutput).not.toContain('Wukong Code');
  });
});
