import { readConfigFile, writeConfigFile } from '../../config';
import type { WukongConfig, OAuthRef } from '../../config';
import type { OAuthTokenProviderResolver } from '../../session/provider-manager';
import {
  applyManagedWukongConfig,
  applyManagedWukongLogoutConfig,
  WUKONG_CODE_PROVIDER_NAME,
  WukongOAuthToolkit,
  resolveWukongLoginAuth,
  resolveWukongRuntimeAuth,
  type BearerTokenProvider,
  type WukongOAuthLoginOptions,
  type ManagedWukongConfigShape,
} from '@wukong/wukong-oauth';

import type { IEnvironmentService } from '../environment/environment';

type ServicesManagedConfig = WukongConfig & ManagedWukongConfigShape;

type ServicesAuthLoginOptions = Omit<WukongOAuthLoginOptions, 'provisionConfig'>;

interface ServicesAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
}

interface ServicesAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface ServicesAuthFacade {
  login(
    providerName?: string | undefined,
    options?: ServicesAuthLoginOptions,
  ): Promise<ServicesAuthLoginResult>;
  logout(providerName?: string | undefined): Promise<ServicesAuthLogoutResult>;
  getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined>;
  readonly resolveOAuthTokenProvider: OAuthTokenProviderResolver;
}

class ServicesManagedAuthFacade implements ServicesAuthFacade {
  private readonly toolkit: WukongOAuthToolkit<ServicesManagedConfig>;

  constructor(
    private readonly options: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
  ) {
    this.toolkit = new WukongOAuthToolkit<ServicesManagedConfig>({
      homeDir: options.homeDir,
      configAdapter: {
        configPath: options.configPath,
        read: () => readConfigFile(options.configPath) as ServicesManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedWukongConfig,
        remove: applyManagedWukongLogoutConfig,
      },
    });
  }

  async login(
    providerName: string | undefined = WUKONG_CODE_PROVIDER_NAME,
    options: ServicesAuthLoginOptions = {},
  ): Promise<ServicesAuthLoginResult> {
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
      provisionConfig: false,
    });
    return {
      providerName: result.providerName,
      ok: true,
    };
  }

  async logout(
    providerName?: string | undefined,
  ): Promise<ServicesAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
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
    return this.toolkit.tokenProvider(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? WUKONG_CODE_PROVIDER_NAME;
    const config = readConfigFile(this.options.configPath);
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
    if ((providerName ?? WUKONG_CODE_PROVIDER_NAME) !== WUKONG_CODE_PROVIDER_NAME) {
      return oauthRef;
    }
    const auth = this.resolveManagedAuth(providerName);
    return resolveWukongRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }
}

export function createManagedAuthFacade(
  env: Pick<IEnvironmentService, 'homeDir' | 'configPath'>,
): ServicesAuthFacade {
  return new ServicesManagedAuthFacade(env);
}
