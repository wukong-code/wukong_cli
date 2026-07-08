import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthFlowController } from '#/tui/controllers/auth-flow';
import type { AuthFlowHost } from '#/tui/controllers/auth-flow';
import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '#/tui/constant/wukong-tui';

function makeHost(overrides: any = {}): AuthFlowHost {
  const session: any = {
    id: 'sess-1',
    summary: { title: 'Test session' },
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
  };
  const defaultAppState = {
    model: '',
    thinking: false,
    workDir: '/tmp/wukong',
    additionalDirs: [] as readonly string[],
    planMode: false,
    sessionId: '',
    sessionTitle: null,
    availableModels: {},
    availableProviders: {},
    contextTokens: 0,
    maxContextTokens: 0,
    contextUsage: 0,
  };
  const harness = {
    getConfig: vi.fn(async (_opts?: unknown) => ({
      providers: {},
      models: {},
    })),
    createSession: vi.fn(async () => session),
    ...overrides.harness,
  };
  const host: any = {
    state: {
      appState: { ...defaultAppState },
      ...overrides.state,
    },
    session: undefined as any,
    harness,
    options: {
      startup: {
        auto: false,
        yolo: false,
        plan: false,
        continueLast: false,
      },
      initialAppState: { ...defaultAppState },
      ...overrides.options,
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    }),
    setStartupReady: vi.fn(),
    resetSessionRuntime: vi.fn(),
    setSession: vi.fn(async (s: any) => {
      host.session = s;
    }),
    syncRuntimeState: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    appendStartupNotice: vi.fn(),
    sessionEventHandler: { startSubscription: vi.fn() },
    fetchSessions: vi.fn(async () => {}),
    updateTerminalTitle: vi.fn(),
    refreshSkillCommands: vi.fn(async () => {}),
    ...overrides.host,
  };

  if (overrides.session !== undefined) {
    host.session = overrides.session;
  }

  return host as AuthFlowHost;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthFlowController.enterLoginRequiredStartupState', () => {
  it('resets runtime and app state then appends the startup notice', async () => {
    const host = makeHost();
    const ctrl = new AuthFlowController(host);

    ctrl.enterLoginRequiredStartupState();

    expect(host.resetSessionRuntime).toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({
      sessionId: '',
      model: '',
      thinking: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
    expect(host.appendStartupNotice).toHaveBeenCalledWith(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    expect(host.setStartupReady).toHaveBeenCalled();
  });
});

describe('AuthFlowController.refreshConfigAfterLogin', () => {
  it('only refreshes available models/providers when there is no default model', async () => {
    const config = {
      providers: { openai: { type: 'openai' } },
      models: { 'openai/gpt-4': { provider: 'openai', model: 'gpt-4', maxContextSize: 128_000 } },
    };
    const host = makeHost({
      harness: { getConfig: vi.fn(async () => config) },
    });
    const ctrl = new AuthFlowController(host);

    await ctrl.refreshConfigAfterLogin();

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.setAppState).toHaveBeenCalledWith({
      availableModels: config.models,
      availableProviders: config.providers,
    });
    expect(host.setSession).not.toHaveBeenCalled();
    expect(host.harness.createSession).not.toHaveBeenCalled();
  });

  it('activates the default model by creating a new session when none exists', async () => {
    const session = {
      id: 'sess-new',
      summary: { title: 'New session' },
      setModel: vi.fn(async () => {}),
      setThinking: vi.fn(async () => {}),
    };
    const config = {
      providers: { openai: { type: 'openai' } },
      models: {
        'openai/gpt-4': {
          provider: 'openai',
          model: 'gpt-4',
          maxContextSize: 128_000,
        },
      },
      defaultModel: 'openai/gpt-4',
      defaultThinking: true,
    };
    const host = makeHost({
      harness: {
        getConfig: vi.fn(async () => config),
        createSession: vi.fn(async () => session),
      },
    });
    const ctrl = new AuthFlowController(host);

    await ctrl.refreshConfigAfterLogin();

    expect(host.harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: '/tmp/wukong',
        model: 'openai/gpt-4',
        thinking: 'on',
      }),
    );
    expect(host.setSession).toHaveBeenCalledWith(session);
    expect(host.syncRuntimeState).toHaveBeenCalledWith(session);
    expect(host.sessionEventHandler.startSubscription).toHaveBeenCalled();
    expect(host.updateTerminalTitle).toHaveBeenCalled();
    expect(host.refreshSkillCommands).toHaveBeenCalledWith(session);
    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({
        availableModels: config.models,
        availableProviders: config.providers,
        model: 'openai/gpt-4',
        maxContextTokens: 128_000,
        thinking: true,
      }),
    );
  });
});

describe('AuthFlowController.refreshConfigAfterLogout', () => {
  it('resets model state and refreshes available models/providers', async () => {
    const config = {
      providers: {},
      models: {},
    };
    const host = makeHost({
      harness: { getConfig: vi.fn(async () => config) },
    });
    const ctrl = new AuthFlowController(host);

    await ctrl.refreshConfigAfterLogout();

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.setAppState).toHaveBeenCalledWith({
      availableModels: config.models,
      availableProviders: config.providers,
      model: '',
      thinking: false,
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  });
});

describe('AuthFlowController.clearActiveSessionAfterLogout', () => {
  it('closes the session, resets runtime, and clears model state', async () => {
    const host = makeHost();
    const ctrl = new AuthFlowController(host);

    await ctrl.clearActiveSessionAfterLogout();

    expect(host.closeSession).toHaveBeenCalledWith('logged out');
    expect(host.resetSessionRuntime).toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    expect(host.refreshSkillCommands).toHaveBeenCalled();
  });
});

describe('AuthFlowController.refreshAvailableModels', () => {
  it('reloads config and updates available models/providers', async () => {
    const config = {
      providers: { openai: { type: 'openai' } },
      models: { 'openai/gpt-4': { provider: 'openai', model: 'gpt-4', maxContextSize: 128_000 } },
    };
    const host = makeHost({
      harness: { getConfig: vi.fn(async () => config) },
    });
    const ctrl = new AuthFlowController(host);

    await ctrl.refreshAvailableModels();

    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.setAppState).toHaveBeenCalledWith({
      availableModels: config.models,
      availableProviders: config.providers,
    });
  });
});
