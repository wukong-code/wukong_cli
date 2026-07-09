import { describe, expect, it, vi } from 'vitest';

import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';
import { WukongTUI, type WukongTUIStartupInput, type TUIState } from '#/tui/wukong-tui';

interface ActivityDriver {
  state: TUIState;
  updateLoopPhase(): void;
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeStartupInput(): WukongTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeDriverWithTerminalProgress(): {
  driver: ActivityDriver;
  state: TUIState;
  setProgress: ReturnType<typeof vi.fn<(active: boolean) => void>>;
} {
  const setProgress = vi.fn<(active: boolean) => void>();
  const driver = new WukongTUI({} as never, makeStartupInput()) as unknown as ActivityDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  driver.state.terminal = { columns: 80, setProgress } as unknown as TUIState['terminal'];
  driver.state.terminalState.supportsProgress = true;
  return { driver, state: driver.state, setProgress };
}

describe('updateLoopPhase terminal progress', () => {
  it('toggles terminal progress when the loop phase enters and leaves work mode', () => {
    vi.useFakeTimers();
    try {
      const { driver, state, setProgress } = makeDriverWithTerminalProgress();

      state.livePane = { ...state.livePane, mode: 'waiting' };
      driver.updateLoopPhase();

      expect(setProgress).toHaveBeenCalledTimes(1);
      expect(setProgress).toHaveBeenLastCalledWith(true);
      expect(state.terminalState.progressActive).toBe(true);

      state.livePane = { ...state.livePane, mode: 'idle' };
      driver.updateLoopPhase();

      expect(setProgress).toHaveBeenCalledTimes(2);
      expect(setProgress).toHaveBeenLastCalledWith(false);
      expect(state.terminalState.progressActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never emits terminal progress when the terminal does not support OSC 9;4', () => {
    vi.useFakeTimers();
    try {
      const { driver, state, setProgress } = makeDriverWithTerminalProgress();
      state.terminalState.supportsProgress = false;

      state.livePane = { ...state.livePane, mode: 'waiting' };
      driver.updateLoopPhase();
      state.livePane = { ...state.livePane, mode: 'idle' };
      driver.updateLoopPhase();

      expect(setProgress).not.toHaveBeenCalled();
      expect(state.terminalState.progressActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps terminal progress active for thinking without an activity spinner', () => {
    vi.useFakeTimers();
    try {
      const { driver, state, setProgress } = makeDriverWithTerminalProgress();
      state.livePane = { ...state.livePane, mode: 'idle' };
      state.appState.streamingPhase = 'thinking';

      driver.updateLoopPhase();

      expect(setProgress).toHaveBeenCalledTimes(1);
      expect(setProgress).toHaveBeenLastCalledWith(true);
      expect(state.loopPhase.render(80).join('')).not.toBe('');

      state.appState.streamingPhase = 'idle';
      driver.updateLoopPhase();

      expect(setProgress).toHaveBeenCalledTimes(2);
      expect(setProgress).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
