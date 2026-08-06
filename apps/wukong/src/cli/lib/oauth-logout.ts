import { join } from 'node:path';

import type { WukongConfig } from '@wukong/wukong-sdk';
import {
  FileTokenStorage,
  revokeRefreshToken,
  resolveWukongRuntimeAuth,
  resolveWukongTokenStorageName,
  WUKONG_CODE_FLOW_CONFIG,
  WUKONG_CODE_PROVIDER_NAME,
  type RevokeRefreshTokenResult,
  type TokenStorage,
} from '@wukong/wukong-oauth';

export type ManagedWukongRemoteLogout =
  | RevokeRefreshTokenResult
  | { readonly kind: 'not_attempted'; readonly reason: 'no_refresh_token' };

export interface ManagedWukongLogoutResult {
  readonly hadLocalAccount: boolean;
  readonly remote: ManagedWukongRemoteLogout;
}

interface ManagedWukongLogoutHarness {
  readonly homeDir: string;
  readonly auth: {
    logout(providerName?: string | undefined): Promise<unknown>;
  };
}

export interface LogoutManagedWukongAccountOptions {
  readonly config: WukongConfig;
  readonly storage?: TokenStorage | undefined;
  readonly revokeImpl?: typeof revokeRefreshToken | undefined;
}

/**
 * Revoke the managed Wukong refresh token, then clear local auth state.
 *
 * Remote revocation is deliberately best-effort. The local facade and the
 * credential file are both cleaned even when the network request fails or an
 * injected revoker throws unexpectedly.
 */
export async function logoutManagedWukongAccount(
  harness: ManagedWukongLogoutHarness,
  options: LogoutManagedWukongAccountOptions,
): Promise<ManagedWukongLogoutResult> {
  const provider = options.config.providers[WUKONG_CODE_PROVIDER_NAME];
  const runtime = resolveWukongRuntimeAuth({
    configuredBaseUrl: provider?.baseUrl,
    configuredOAuthRef: provider?.oauth,
  });
  const storageName = resolveWukongTokenStorageName({
    providerName: WUKONG_CODE_PROVIDER_NAME,
    oauthKey: runtime.oauthRef.key,
  });
  const storage = options.storage ?? new FileTokenStorage(join(harness.homeDir, 'credentials'));
  const token = await storage.load(storageName);
  const hadLocalAccount = token !== undefined || provider !== undefined;

  let remote: ManagedWukongRemoteLogout = {
    kind: 'not_attempted',
    reason: 'no_refresh_token',
  };
  if (token !== undefined && token.refreshToken.length > 0) {
    try {
      remote = await (options.revokeImpl ?? revokeRefreshToken)(
        {
          ...WUKONG_CODE_FLOW_CONFIG,
          oauthHost: runtime.oauthRef.oauthHost ?? WUKONG_CODE_FLOW_CONFIG.oauthHost,
        },
        token.refreshToken,
      );
    } catch {
      // A custom/injected implementation may throw even though the built-in
      // helper does not. Never allow that to skip local credential cleanup.
      remote = { kind: 'unknown', reason: 'network_or_timeout' };
    }
  }

  let cleanupError: unknown;
  if (hadLocalAccount) {
    try {
      await harness.auth.logout(WUKONG_CODE_PROVIDER_NAME);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    // Idempotently remove the exact credential slot even if config cleanup
    // failed before the SDK facade reached its own token-removal step.
    await storage.remove(storageName);
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError !== undefined) {
    const cleanupMessage =
      cleanupError instanceof Error
        ? cleanupError.message
        : typeof cleanupError === 'string'
          ? cleanupError
          : 'unknown local cleanup error';
    throw new Error(
      `Could not finish local Wukong logout: ${cleanupMessage}`,
      { cause: cleanupError },
    );
  }

  return { hadLocalAccount, remote };
}

export function formatManagedWukongLogoutMessage(result: ManagedWukongLogoutResult): string {
  if (!result.hadLocalAccount) {
    return 'Wukong account is not connected. Local credentials are already clear.';
  }
  if (result.remote.kind === 'confirmed') {
    return 'Logged out from Wukong Code. Remote session revoked and local credentials removed.';
  }
  if (result.remote.kind === 'not_attempted') {
    return 'Logged out from Wukong Code. Local credentials removed; no remote refresh token was present.';
  }

  const detail = remoteFailureDetail(result.remote);
  return `Logged out locally from Wukong Code. Warning: remote revocation was not confirmed${detail}; the server session may still be active. Contact https://wukong.today/contact if immediate invalidation is required.`;
}

function remoteFailureDetail(result: Extract<ManagedWukongRemoteLogout, { kind: 'unknown' }>): string {
  const status = result.status === undefined ? '' : `, HTTP ${String(result.status)}`;
  switch (result.reason) {
    case 'network_or_timeout':
      return ' (network error or timeout)';
    case 'rate_limited':
      return ` (rate limited${status})`;
    case 'server_error':
      return ` (server error${status})`;
    case 'request_rejected':
      return ` (request rejected${status})`;
    case 'unexpected_status':
      return ` (unexpected response${status})`;
  }
}
