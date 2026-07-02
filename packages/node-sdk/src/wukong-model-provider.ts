import {
  ErrorCodes,
  WukongError,
  resolveWukongHome,
  type Logger,
  type ModelProvider,
  type ResolvedRuntimeProvider,
} from '@wukong/agent-core';
import {
  createWukongDefaultHeaders,
  WUKONG_CODE_FLOW_CONFIG,
  WUKONG_CODE_PROVIDER_NAME,
  WukongOAuthToolkit,
  wukongBaseUrl,
  parseWukongCustomHeaders,
  resolveWukongOAuthRef,
  type WukongHostIdentity,
  type ManagedWukongOAuthRef,
} from '@wukong/wukong-oauth';
import type {
  ProviderConfig as KosongProviderConfig,
  ProviderRequestAuth,
} from '@wukong/kosong';
import { APIStatusError, UNKNOWN_CAPABILITY } from '@wukong/kosong';

import { mapOAuthTokenError } from '#/oauth-error';

export interface WukongProviderOptions extends WukongHostIdentity {
  readonly homeDir?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly promptCacheKey?: string;
  readonly defaultHeaders?: Record<string, string>;
}

export class WukongProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly promptCacheKey: string | undefined;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly toolkit: WukongOAuthToolkit;
  private readonly homeDir: string;
  private readonly identity: WukongHostIdentity;
  private readonly oauthRef: ManagedWukongOAuthRef;

  constructor(options: WukongProviderOptions) {
    this.model = options.model ?? 'wukong-for-coding';
    this.baseUrl = options.baseUrl ?? wukongBaseUrl();
    this.promptCacheKey = options.promptCacheKey;
    this.defaultHeaders = options.defaultHeaders;
    this.homeDir = resolveWukongHome(options.homeDir);
    this.identity = {
      userAgentProduct: options.userAgentProduct,
      version: options.version,
      userAgentSuffix: options.userAgentSuffix,
    };
    this.oauthRef = resolveWukongOAuthRef({
      oauthHost: WUKONG_CODE_FLOW_CONFIG.oauthHost,
      baseUrl: this.baseUrl,
    });
    this.toolkit = new WukongOAuthToolkit({
      homeDir: this.homeDir,
      identity: this.identity,
    });
  }

  get defaultModel(): string {
    return this.model;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    if (model !== this.model) {
      throw new WukongError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not supported by WukongProvider.`,
      );
    }

    const provider: KosongProviderConfig = {
      type: 'wukong',
      model: this.model,
      baseUrl: this.baseUrl,
      generationKwargs: this.promptCacheKey
        ? { prompt_cache_key: this.promptCacheKey }
        : undefined,
      defaultHeaders: {
        ...parseWukongCustomHeaders(),
        ...createWukongDefaultHeaders({
          homeDir: this.homeDir,
          ...this.identity,
        }),
        ...this.defaultHeaders,
      },
    };

    return {
      providerName: 'wukong-for-coding',
      provider,
      modelCapabilities: UNKNOWN_CAPABILITY,
      type: 'wukong',
      protocol: undefined,
    };
  }

  resolveAuth(_model: string, _options?: { readonly log?: Logger }) {
    return async <T>(request: (auth: ProviderRequestAuth) => Promise<T>): Promise<T> => {
      let auth = await this.buildAuth(false);
      for (let refreshed = false; ; refreshed = true) {
        try {
          return await request(auth);
        } catch (error) {
          const is401 = error instanceof APIStatusError && error.statusCode === 401;
          if (!is401) throw error;
          if (refreshed) {
            throw new WukongError(
              ErrorCodes.AUTH_LOGIN_REQUIRED,
              'OAuth token was rejected after refresh. Run /login to re-authenticate.',
              { cause: error },
            );
          }
          auth = await this.buildAuth(true);
        }
      }
    };
  }

  private async buildAuth(force: boolean): Promise<ProviderRequestAuth> {
    try {
      const apiKey = await this.toolkit.ensureFresh(WUKONG_CODE_PROVIDER_NAME, {
        force,
        oauthRef: this.oauthRef,
      });
      return { apiKey };
    } catch (error) {
      // Classify OAuth token failures into the public WukongError protocol so the
      // turn surfaces `auth.login_required` / `provider.connection_error`
      // instead of collapsing everything to `internal`. Unrecognized errors are
      // rethrown raw (see mapOAuthTokenError).
      throw mapOAuthTokenError(error, WUKONG_CODE_PROVIDER_NAME) ?? error;
    }
  }
}
