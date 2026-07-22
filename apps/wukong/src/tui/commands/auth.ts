import { log } from '@wukong/wukong-sdk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '../constant/wukong-tui';
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
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    spinner?.stop({ ok: true, label: 'Logged in.' });
    spinner = undefined;
    host.track('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus('Wukong account is already connected.');
    } else {
      host.showStatus('Wukong account connected. Configure models with /provider.');
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
  const oauthStatus = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const config = await host.harness.getConfig();
  const hasManagedRemnant =
    hasOAuthToken || config.providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
  if (!hasManagedRemnant) {
    host.showStatus('Wukong account is not connected.');
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);

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

  host.track('logout', { provider: DEFAULT_OAUTH_PROVIDER_NAME });
  host.showStatus(`Logged out from ${PRODUCT_NAME}.`);
}
