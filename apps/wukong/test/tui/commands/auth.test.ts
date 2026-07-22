import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:wukong';

interface HostOverrides {
  appState?: Record<string, unknown>;
  config?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

function makeHost(overrides: HostOverrides = {}): SlashCommandHost {
  const spinner = { stop: vi.fn(), setLabel: vi.fn() };
  const config = overrides.config ?? { providers: {}, models: {} };
  const auth = {
    status: vi.fn(async () => ({ providers: [] })),
    login: vi.fn(async (_providerName: string, options?: { onDeviceCode?: (data: unknown) => void }) => {
      options?.onDeviceCode?.({
        deviceCode: 'dev-code',
        userCode: 'WUKONG-1234',
        verificationUri: 'https://example.com/device',
        verificationUriComplete: 'https://example.com/device?code=WUKONG-1234',
        expiresIn: 900,
        interval: 5,
      });
      return { providerName: DEFAULT_OAUTH_PROVIDER_NAME, ok: true as const, modelCount: 0 };
    }),
    logout: vi.fn(async () => ({ ok: true })),
    ...overrides.auth,
  };
  const host = {
    state: {
      appState: {
        model: '',
        availableModels: {},
        availableProviders: {},
        ...overrides.appState,
      },
    },
    session: undefined,
    harness: {
      auth,
      getConfig: vi.fn(async () => config),
      removeProvider: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshAvailableModels: vi.fn(async () => {}),
      refreshConfigAfterLogin: vi.fn(async () => {}),
      refreshConfigAfterLogout: vi.fn(async () => {}),
      clearActiveSessionAfterLogout: vi.fn(async () => {}),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleLoginCommand', () => {
  it('connects only the optional Wukong account and points model setup to /provider', async () => {
    const host = makeHost();

    await handleLoginCommand(host);

    expect(host.harness.auth.login).toHaveBeenCalledWith(
      DEFAULT_OAUTH_PROVIDER_NAME,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(host.harness.setConfig).toBeUndefined();
    expect(host.harness.removeProvider).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Wukong account connected. No Wukong models are available yet; use /provider for BYOK models.',
    );
    expect(host.track).toHaveBeenCalledWith('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: false,
    });
  });

  it('reports an already-connected account without touching model config', async () => {
    const host = makeHost({
      auth: {
        status: vi.fn(async () => ({
          providers: [{ providerName: DEFAULT_OAUTH_PROVIDER_NAME, hasToken: true }],
        })),
      },
    });

    await handleLoginCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith(
      'Wukong account connected. No Wukong models are available yet; use /provider for BYOK models.',
    );
    expect(host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
  });

  it('does not track a cancelled device login', async () => {
    const host = makeHost({
      auth: {
        login: vi.fn(async (_providerName: string, options: { signal: AbortSignal }) => {
          host.cancelInFlight?.();
          throw options.signal.reason ?? new Error('aborted');
        }),
      },
    });

    await handleLoginCommand(host);

    expect(host.track).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.cancelInFlight).toBeUndefined();
  });
});

describe('handleLogoutCommand', () => {
  it('does not remove BYOK providers when no Wukong account is connected', async () => {
    const host = makeHost({
      config: {
        providers: { openai: { type: 'openai', apiKey: 'secret' } },
        models: { gpt: { provider: 'openai', model: 'gpt-5' } },
      },
    });

    await handleLogoutCommand(host);

    expect(host.harness.auth.logout).not.toHaveBeenCalled();
    expect(host.harness.removeProvider).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Wukong account is not connected.');
  });

  it('disconnects the Wukong account while preserving an active BYOK model', async () => {
    const host = makeHost({
      appState: {
        model: 'gpt',
        availableModels: { gpt: { provider: 'openai', model: 'gpt-5' } },
      },
      config: {
        providers: {
          [DEFAULT_OAUTH_PROVIDER_NAME]: { type: 'openai' },
          openai: { type: 'openai', apiKey: 'secret' },
        },
        models: { gpt: { provider: 'openai', model: 'gpt-5' } },
      },
    });

    await handleLogoutCommand(host);

    expect(host.harness.auth.logout).toHaveBeenCalledWith(DEFAULT_OAUTH_PROVIDER_NAME);
    expect(host.harness.removeProvider).not.toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).not.toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith(expect.objectContaining({
      availableProviders: expect.objectContaining({ openai: expect.any(Object) }),
    }));
  });

  it('clears a session that still uses the removed legacy managed provider', async () => {
    const host = makeHost({
      appState: {
        model: 'managed-model',
        availableModels: {
          'managed-model': { provider: DEFAULT_OAUTH_PROVIDER_NAME, model: 'legacy' },
        },
      },
      config: {
        providers: { [DEFAULT_OAUTH_PROVIDER_NAME]: { type: 'openai' } },
        models: {},
      },
    });

    await handleLogoutCommand(host);

    expect(host.authFlow.refreshConfigAfterLogout).toHaveBeenCalled();
    expect(host.authFlow.clearActiveSessionAfterLogout).toHaveBeenCalled();
  });
});
