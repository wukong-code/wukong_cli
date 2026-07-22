import {
  loadRuntimeConfigSafe,
  readConfigFile,
  readConfigFileForUpdate,
  writeConfigFile,
  type WukongConfig,
  type OAuthRef,
} from '@wukong/agent-core';
import {
  applyManagedWukongConfig,
  applyManagedWukongLogoutConfig,
  WUKONG_CODE_PROVIDER_NAME,
  WukongOAuthToolkit,
  resolveWukongLoginAuth,
  resolveWukongRuntimeAuth,
  type AuthManagedUsageResult,
  type AuthStatus,
  type BearerTokenProvider,
  type FetchSubmitFeedbackResult,
  type WukongHostIdentity,
  type WukongOAuthLoginOptions,
  type ManagedWukongConfigShape,
  type OAuthRefreshOutcome,
} from '@wukong/wukong-oauth';

import { mapOAuthTokenError } from '#/oauth-error';

export interface WukongAuthSubmitFeedbackInput {
  readonly message: string;
  readonly category: 'bug' | 'onboarding' | 'loop_result' | 'feature_request' | 'other';
  readonly version: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly arch: 'arm64' | 'x64';
  readonly loopOutcome?: 'PASS' | 'NEEDS_WORK' | 'ERROR' | null;
  readonly reasonCode?: string | null;
  readonly contact?: string | null;
  readonly idempotencyKey: string;
}

export type WukongAuthLoginOptions = Omit<WukongOAuthLoginOptions, 'provisionConfig'>;

export interface WukongAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly modelCount: number;
}

export interface WukongAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface WukongAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: WukongHostIdentity | undefined;
  readonly onConfigUpdated?: ((config: WukongConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

type SDKManagedConfig = WukongConfig & ManagedWukongConfigShape;

export class WukongAuthFacade {
  private readonly toolkit: WukongOAuthToolkit<SDKManagedConfig>;

  constructor(private readonly options: WukongAuthFacadeOptions) {
    this.toolkit = new WukongOAuthToolkit<SDKManagedConfig>({
      homeDir: options.homeDir,
      identity: options.identity,
      onRefresh: options.onRefresh,
      configAdapter: {
        configPath: options.configPath,
        // Write-path base read: strict (a salvaged base would drop the user's
        // broken-but-fixable sections on rewrite) with an actionable message.
        read: () => readConfigFileForUpdate(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedWukongConfig,
        remove: applyManagedWukongLogoutConfig,
      },
    });
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    return this.toolkit.status(providerName, this.resolveRuntimeManagedAuth(providerName).oauthRef);
  }

  async login(
    providerName: string | undefined = WUKONG_CODE_PROVIDER_NAME,
    options: WukongAuthLoginOptions = {},
  ): Promise<WukongAuthLoginResult> {
    const auth = this.resolveManagedAuth(providerName);
    const loginAuth = resolveWukongLoginAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
      requestedBaseUrl: options.baseUrl,
      requestedOAuthHost: options.oauthHost,
    });
    const result = await this.toolkit.login(providerName, {
      ...options,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      oauthRef: options.oauthRef ?? loginAuth.oauthRef,
      provisionConfig: true,
    });
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      modelCount: result.provision?.models.length ?? 0,
    };
  }

  async logout(providerName?: string | undefined): Promise<WukongAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.getManagedUsage(providerName, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  async submitFeedback(
    input: WukongAuthSubmitFeedbackInput,
  ): Promise<FetchSubmitFeedbackResult> {
    const auth = this.resolveRuntimeManagedAuth(WUKONG_CODE_PROVIDER_NAME);
    return this.toolkit.submitFeedback(
      {
        message: input.message,
        category: input.category,
        version: input.version,
        platform: input.platform,
        arch: input.arch,
        loop_outcome: input.loopOutcome,
        reason_code: input.reasonCode,
        contact: input.contact,
      },
      input.idempotencyKey,
      { baseUrl: auth.baseUrl },
    );
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    const provider = this.toolkit.tokenProvider(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
    return {
      getAccessToken: async (options) => {
        try {
          return await provider.getAccessToken(options);
        } catch (error) {
          // Classify OAuth token failures into the public WukongError protocol;
          // unrecognized errors are rethrown raw (see mapOAuthTokenError).
          throw mapOAuthTokenError(error, providerName) ?? error;
        }
      },
    };
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? WUKONG_CODE_PROVIDER_NAME;
    // Read path: token/status resolution must work off a degraded config
    // instead of failing the session when an unrelated section is broken.
    // Write paths (the toolkit's configAdapter.read) stay strict.
    const config = loadRuntimeConfigSafe(this.options.configPath).config;
    const provider = config.providers[name];
    return {
      oauthRef: provider?.oauth,
      baseUrl: provider?.baseUrl,
    };
  }

  private resolveRuntimeManagedAuth(providerName?: string | undefined): {
    readonly oauthRef: OAuthRef;
    readonly baseUrl?: string | undefined;
  } {
    const auth = this.resolveManagedAuth(providerName);
    return resolveWukongRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
    });
  }

  private runtimeOAuthRef(
    providerName: string | undefined,
    oauthRef?: OAuthRef | undefined,
  ): OAuthRef | undefined {
    if ((providerName ?? WUKONG_CODE_PROVIDER_NAME) !== WUKONG_CODE_PROVIDER_NAME) return oauthRef;
    const auth = this.resolveManagedAuth(providerName);
    return resolveWukongRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }
}
