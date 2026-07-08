import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:wukong';

const mockPrompts = vi.hoisted(() => ({
  promptPlatformSelection: vi.fn(async () => undefined as string | undefined),
  promptApiKey: vi.fn(async () => undefined as string | undefined),
  promptModelSelectionForOpenPlatform: vi.fn(
    async () => undefined as { model: Record<string, unknown>; thinking: boolean } | undefined,
  ),
  promptLogoutProviderSelection: vi.fn(async () => undefined as string | undefined),
}));

const mockOAuth = vi.hoisted(() => ({
  fetchOpenPlatformModels: vi.fn(async () => [] as Array<Record<string, unknown>>),
  filterModelsByPrefix: vi.fn((models: Array<Record<string, unknown>>) => models),
  getOpenPlatformById: vi.fn(() => undefined as Record<string, unknown> | undefined),
  applyOpenPlatformConfig: vi.fn(),
}));

vi.mock('@wukong/wukong-oauth', () => ({
  ...mockOAuth,
  OpenPlatformApiError: class OpenPlatformApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('#/tui/commands/prompts', () => mockPrompts);

interface HostOverrides {
  appState?: any;
  harness?: any;
  authFlow?: any;
}

function makeHost(overrides: HostOverrides = {}): SlashCommandHost {
  const spinner = { stop: vi.fn(), setLabel: vi.fn() };
  const harnessDefaults = {
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(async (_providerName: string, options?: { onDeviceCode?: (data: unknown) => void }) => {
        if (options?.onDeviceCode) {
          options.onDeviceCode({
            deviceCode: 'dev-code',
            userCode: 'WUKONG-1234',
            verificationUri: 'https://example.com/device',
            verificationUriComplete: 'https://example.com/device?code=WUKONG-1234',
            expiresIn: 900,
            interval: 5,
          });
        }
      }),
      logout: vi.fn(async () => ({})),
    },
    getConfig: vi.fn(async (_opts?: unknown) => ({
      providers: {},
      models: {},
    })),
    setConfig: vi.fn(async () => ({})),
    removeProvider: vi.fn(async () => ({})),
  };
  const harness = {
    ...harnessDefaults,
    ...overrides.harness,
    auth: {
      ...harnessDefaults.auth,
      ...overrides.harness?.auth,
    },
  };

  const defaultAppState = {
    model: '',
    availableModels: {},
    availableProviders: {},
  };

  const host = {
    state: {
      appState: { ...defaultAppState, ...overrides.appState },
    },
    session: undefined,
    harness,
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => {}),
      refreshConfigAfterLogout: vi.fn(async () => {}),
      clearActiveSessionAfterLogout: vi.fn(async () => {}),
      ...overrides.authFlow,
    },
    cancelInFlight: undefined,
    track: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showLoginAuthorizationPrompt: vi.fn(() => spinner),
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    }),
  } as unknown as SlashCommandHost;

  return host;
}

function fakePlatform(id: string): any {
  return {
    id,
    name: `Platform ${id}`,
    baseUrl: `https://api.${id}.example/v1`,
    consoleUrl: `https://platform.${id}.example`,
  };
}

function fakeModel(id: string): any {
  return {
    id,
    displayName: id.toUpperCase(),
    contextLength: 128_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrompts.promptPlatformSelection.mockResolvedValue(undefined);
  mockPrompts.promptApiKey.mockResolvedValue(undefined);
  mockPrompts.promptModelSelectionForOpenPlatform.mockResolvedValue(undefined);
  mockPrompts.promptLogoutProviderSelection.mockResolvedValue(undefined);
  mockOAuth.fetchOpenPlatformModels.mockResolvedValue([]);
  mockOAuth.filterModelsByPrefix.mockImplementation((models: Array<Record<string, unknown>>) => models);
  mockOAuth.getOpenPlatformById.mockReturnValue(undefined);
  mockOAuth.applyOpenPlatformConfig.mockImplementation((config: any, options: any) => {
    const platform = options.platform;
    const selectedModel = options.selectedModel;
    const apiKey = options.apiKey;
    const aliasKey = `${platform.id}/${selectedModel.id}`;
    config.providers = {
      ...config.providers,
      [platform.id]: {
        type: 'openai',
        apiKey,
        baseUrl: platform.baseUrl,
      },
    };
    config.models = {
      ...config.models,
      [aliasKey]: {
        provider: platform.id,
        model: selectedModel.id,
        maxContextSize: selectedModel.contextLength,
      },
    };
    config.defaultModel = aliasKey;
  });
});

describe('handleLoginCommand', () => {
  it('selecting Wukong OAuth succeeds', async () => {
    mockPrompts.promptPlatformSelection.mockResolvedValue('wukong');
    const host = makeHost();

    await handleLoginCommand(host);

    expect(host.harness.auth.login).toHaveBeenCalledWith(
      DEFAULT_OAUTH_PROVIDER_NAME,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith(
      'login',
      expect.objectContaining({ provider: DEFAULT_OAUTH_PROVIDER_NAME, method: 'oauth' }),
    );
  });

  it('returns early when platform selection is cancelled', async () => {
    mockPrompts.promptPlatformSelection.mockResolvedValue(undefined);
    const host = makeHost();

    await handleLoginCommand(host);

    expect(host.harness.auth.login).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
  });

  it('open-platform API key login succeeds', async () => {
    const platform = fakePlatform('wukong-ai');
    const model = fakeModel('k2');
    mockPrompts.promptPlatformSelection.mockResolvedValue('wukong-ai');
    mockOAuth.getOpenPlatformById.mockReturnValue(platform);
    mockPrompts.promptApiKey.mockResolvedValue('sk-openplatform');
    mockOAuth.fetchOpenPlatformModels.mockResolvedValue([model]);
    mockPrompts.promptModelSelectionForOpenPlatform.mockResolvedValue({ model, thinking: false });
    const host = makeHost();

    await handleLoginCommand(host);

    expect(mockOAuth.fetchOpenPlatformModels).toHaveBeenCalledWith(
      platform,
      'sk-openplatform',
      fetch,
      expect.any(AbortSignal),
    );
    expect(host.harness.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          'wukong-ai': expect.objectContaining({ apiKey: 'sk-openplatform' }),
        }),
        defaultModel: 'wukong-ai/k2',
      }),
    );
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith('login', { provider: 'wukong-ai', method: 'api_key' });
    expect(host.showStatus).toHaveBeenCalled();
  });

  it('open-platform 401 shows a hint to select Wukong instead', async () => {
    const platform = fakePlatform('wukong-ai');
    const { OpenPlatformApiError } = await import('@wukong/wukong-oauth');
    mockPrompts.promptPlatformSelection.mockResolvedValue('wukong-ai');
    mockOAuth.getOpenPlatformById.mockReturnValue(platform);
    mockPrompts.promptApiKey.mockResolvedValue('bad-key');
    mockOAuth.fetchOpenPlatformModels.mockRejectedValue(new OpenPlatformApiError('Unauthorized', 401));
    const host = makeHost();

    await handleLoginCommand(host);

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Failed to verify API key'));
    expect(host.showStatus).toHaveBeenCalledWith(
      'Hint: If your API key was obtained from Wukong, please select "Wukong" instead.',
    );
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('shows an error when no models are available for the platform', async () => {
    const platform = fakePlatform('wukong-ai');
    mockPrompts.promptPlatformSelection.mockResolvedValue('wukong-ai');
    mockOAuth.getOpenPlatformById.mockReturnValue(platform);
    mockPrompts.promptApiKey.mockResolvedValue('sk-openplatform');
    mockOAuth.fetchOpenPlatformModels.mockResolvedValue([]);
    const host = makeHost();

    await handleLoginCommand(host);

    expect(host.showError).toHaveBeenCalledWith('No models available for this platform.');
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });
});

describe('handleLogoutCommand', () => {
  it('shows status when there is nothing to logout', async () => {
    const host = makeHost({
      harness: {
        getConfig: vi.fn(async () => ({ providers: {} })),
      },
    });

    await handleLogoutCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith('Nothing to logout.');
    expect(host.harness.auth.logout).not.toHaveBeenCalled();
    expect(host.harness.removeProvider).not.toHaveBeenCalled();
  });

  it('logs out OAuth provider and refreshes when it is the current provider', async () => {
    mockPrompts.promptLogoutProviderSelection.mockResolvedValue(DEFAULT_OAUTH_PROVIDER_NAME);
    const host = makeHost({
      appState: {
        model: 'wukong/k2',
        availableModels: {
          'wukong/k2': { provider: DEFAULT_OAUTH_PROVIDER_NAME },
        },
      },
      harness: {
        getConfig: vi.fn(async () => ({
          providers: { [DEFAULT_OAUTH_PROVIDER_NAME]: { type: 'wukong' } },
          models: { 'wukong/k2': { provider: DEFAULT_OAUTH_PROVIDER_NAME } },
        })),
        auth: {
          status: vi.fn(async () => ({
            providers: [{ providerName: DEFAULT_OAUTH_PROVIDER_NAME, hasToken: true }],
          })),
        },
      },
    });

    await handleLogoutCommand(host);

    expect(host.harness.auth.logout).toHaveBeenCalledWith(DEFAULT_OAUTH_PROVIDER_NAME);
    expect(host.authFlow.refreshConfigAfterLogout).toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith('logout', { provider: DEFAULT_OAUTH_PROVIDER_NAME });
  });

  it('logs out API-key provider and updates available models/providers', async () => {
    mockPrompts.promptLogoutProviderSelection.mockResolvedValue('openai');
    const updatedConfig = {
      providers: {},
      models: {},
    };
    const host = makeHost({
      appState: {
        model: 'wukong/k2',
        availableModels: {
          'wukong/k2': { provider: DEFAULT_OAUTH_PROVIDER_NAME },
        },
      },
      harness: {
        getConfig: vi.fn(async (opts?: { reload?: boolean }) => {
          if (opts?.reload) return updatedConfig;
          return {
            providers: { openai: { type: 'openai', apiKey: 'sk' } },
            models: { 'openai/gpt-4': { provider: 'openai' } },
          };
        }),
        removeProvider: vi.fn(async () => updatedConfig),
      },
    });

    await handleLogoutCommand(host);

    expect(host.harness.removeProvider).toHaveBeenCalledWith('openai');
    expect(host.harness.getConfig).toHaveBeenCalledWith({ reload: true });
    expect(host.setAppState).toHaveBeenCalledWith({
      availableModels: updatedConfig.models,
      availableProviders: updatedConfig.providers,
    });
    expect(host.authFlow.refreshConfigAfterLogout).not.toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).not.toHaveBeenCalled();
  });

  it('refreshes and clears the active session when selecting the current provider', async () => {
    mockPrompts.promptLogoutProviderSelection.mockResolvedValue('openai');
    const host = makeHost({
      appState: {
        model: 'openai/gpt-4',
        availableModels: {
          'openai/gpt-4': { provider: 'openai' },
        },
      },
      harness: {
        getConfig: vi.fn(async () => ({
          providers: { openai: { type: 'openai', apiKey: 'sk' } },
          models: { 'openai/gpt-4': { provider: 'openai' } },
        })),
      },
    });

    await handleLogoutCommand(host);

    expect(host.harness.removeProvider).toHaveBeenCalledWith('openai');
    expect(host.authFlow.refreshConfigAfterLogout).toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).toHaveBeenCalled();
  });
});
