import { log } from '@wukong/wukong-sdk';

import {
  formatManagedWukongLogoutMessage,
  logoutManagedWukongAccount,
} from '#/cli/lib/oauth-logout';

import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/wukong-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { LoginProgressSpinnerHandle } from '../types';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  await handleWukongCodeOAuthLogin(host);
}

async function handleWukongCodeOAuthLogin(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    const result = await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    spinner?.stop({ ok: true, label: 'Logged in.' });
    spinner = undefined;
    await host.authFlow.refreshAvailableModels();
    host.track('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    if (result.modelCount === 0) {
      host.showStatus(
        'Wukong account connected. No Wukong models are available yet; use /provider for BYOK models.',
      );
    } else if (alreadyLoggedIn) {
      host.showStatus('Wukong account is already connected and its model catalog is up to date.');
    } else {
      host.showStatus(`Wukong account connected. ${String(result.modelCount)} model(s) available.`);
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? 'Login cancelled.' : 'Login failed.',
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: DEFAULT_OAUTH_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  let result: Awaited<ReturnType<typeof logoutManagedWukongAccount>>;
  try {
    result = await logoutManagedWukongAccount(host.harness, { config });
  } catch (error) {
    host.showError(`Logout failed: ${formatErrorMessage(error)}`);
    return;
  }
  if (!result.hadLocalAccount) {
    host.showStatus(formatManagedWukongLogoutMessage(result));
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  if (currentProvider === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }

  host.track('logout', {
    provider: DEFAULT_OAUTH_PROVIDER_NAME,
    remote_revocation: result.remote.kind,
  });
  host.showStatus(formatManagedWukongLogoutMessage(result));
}
