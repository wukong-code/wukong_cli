import { createHash } from 'node:crypto';

import { readApiErrorMessage } from './api-error';
import { DEFAULT_WUKONG_CODE_OAUTH_HOST } from './constants';
import { OAuthUnauthorizedError } from './errors';
import { parseWukongCustomHeaders } from './identity';
import { DEFAULT_WUKONG_CODE_BASE_URL, wukongBaseUrl } from './managed-usage';
import { isRecord } from './utils';

export const WUKONG_CODE_PLATFORM_ID = 'wukong';
export const WUKONG_CODE_PROVIDER_NAME = 'managed:wukong';
export const WUKONG_CODE_OAUTH_KEY = 'oauth.wukong';
const WUKONG_CODE_SCOPED_OAUTH_KEY_PREFIX = 'oauth.wukong-env-';
/** Legacy on-disk form written by older config serializers (`oauth/…`). */
const WUKONG_CODE_LEGACY_OAUTH_KEY_PREFIX = 'oauth/';

/**
 * Normalize credential keys so `oauth/wukong-env-…` (legacy config form) and
 * `oauth.wukong-env-…` (canonical form) compare equal.
 */
export function normalizeOAuthCredentialKey(key: string): string {
  if (key.startsWith(WUKONG_CODE_LEGACY_OAUTH_KEY_PREFIX)) {
    return `oauth.${key.slice(WUKONG_CODE_LEGACY_OAUTH_KEY_PREFIX.length)}`;
  }
  return key;
}

export type ManagedWukongProtocol = 'wukong' | 'anthropic';

export function parseModelProtocol(value: unknown): ManagedWukongProtocol | undefined {
  return value === 'anthropic' ? 'anthropic' : undefined;
}

/**
 * Server-declared thinking toggle support from `/models`:
 *  - 'only' — thinking cannot be turned off (always-thinking)
 *  - 'no'   — thinking is not supported at all
 *  - 'both' — thinking can be toggled on and off
 * Absent on older servers — callers fall back to `supportsReasoning`.
 */
export type SupportsThinkingType = 'only' | 'no' | 'both';

export interface ManagedWukongModelInfo {
  readonly id: string;
  readonly contextLength: number;
  readonly supportsReasoning: boolean;
  readonly supportsImageIn: boolean;
  readonly supportsVideoIn: boolean;
  readonly supportsToolUse?: boolean;
  readonly supportsThinkingType?: SupportsThinkingType;
  readonly displayName?: string | undefined;
  readonly protocol?: ManagedWukongProtocol | undefined;
}

export interface ManagedWukongProvisionResult {
  readonly providerName: typeof WUKONG_CODE_PROVIDER_NAME;
  readonly defaultModel?: string;
  readonly defaultThinking?: boolean;
  readonly models: readonly ManagedWukongModelInfo[];
  readonly configPath?: string | undefined;
}

export interface FetchManagedWukongModelsOptions {
  readonly accessToken: string;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly headers?: Record<string, string> | undefined;
}

export interface ManagedWukongApplyResult {
  readonly defaultModel?: string;
  readonly defaultThinking?: boolean;
}

export interface ManagedWukongCleanupResult {
  readonly providerName: typeof WUKONG_CODE_PROVIDER_NAME;
  readonly removedProvider: boolean;
  readonly removedModels: readonly string[];
  readonly defaultModelCleared: boolean;
  readonly removedServices: readonly string[];
}

export interface ManagedWukongOAuthRef {
  readonly storage: 'file' | 'keyring';
  readonly key: string;
  readonly oauthHost?: string | undefined;
}

export interface ManagedWukongOAuthRefInput {
  readonly storage?: 'file' | 'keyring' | undefined;
  readonly key?: string | undefined;
  readonly oauthHost?: string | undefined;
}

export interface ManagedWukongRuntimeAuth {
  readonly baseUrl?: string | undefined;
  readonly oauthRef: ManagedWukongOAuthRef;
}

export interface ManagedWukongLoginAuth {
  readonly baseUrl?: string | undefined;
  readonly oauthHost?: string | undefined;
  readonly oauthRef?: ManagedWukongOAuthRef | undefined;
}

export interface ManagedWukongEnv {
  readonly WUKONG_CODE_BASE_URL?: string | undefined;
  readonly WUKONG_CODE_OAUTH_HOST?: string | undefined;
  readonly WUKONG_OAUTH_HOST?: string | undefined;
}

export class ManagedWukongModelsAuthError extends OAuthUnauthorizedError {
  readonly status: number;
  readonly baseUrl: string;

  constructor(options: {
    readonly status: number;
    readonly baseUrl: string;
    readonly message: string;
  }) {
    super(
      `Wukong models endpoint ${options.baseUrl} rejected OAuth credentials: ${options.message}`,
    );
    this.name = 'ManagedWukongModelsAuthError';
    this.status = options.status;
    this.baseUrl = options.baseUrl;
  }
}

export interface ManagedWukongProviderConfig {
  type: ManagedWukongProtocol;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  oauth?: ManagedWukongOAuthRef | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedWukongModelAlias {
  provider: string;
  model: string;
  maxContextSize: number;
  capabilities?: string[] | undefined;
  displayName?: string | undefined;
  protocol?: ManagedWukongProtocol;
  betaApi?: boolean;
  readonly [key: string]: unknown;
}

export interface ManagedWukongServiceConfig {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  oauth?: ManagedWukongOAuthRef | undefined;
}

export interface ManagedWukongServicesConfig {
  wukongSearch?: ManagedWukongServiceConfig | undefined;
  wukongFetch?: ManagedWukongServiceConfig | undefined;
  readonly [key: string]: unknown;
}

export interface ManagedWukongConfigShape {
  providers: Record<string, ManagedWukongProviderConfig | Record<string, unknown>>;
  models?: Record<string, ManagedWukongModelAlias | Record<string, unknown>> | undefined;
  defaultModel?: string | undefined;
  defaultThinking?: boolean | undefined;
  services?: ManagedWukongServicesConfig | undefined;
  [key: string]: unknown;
}

export interface ManagedWukongConfigAdapter<TConfig> {
  read(): Promise<TConfig> | TConfig;
  write(config: TConfig): Promise<void> | void;
  apply(
    config: TConfig,
    input: {
      readonly models: readonly ManagedWukongModelInfo[];
      readonly baseUrl?: string | undefined;
      readonly oauthKey?: string | undefined;
      readonly oauthHost?: string | undefined;
      readonly preserveDefaultModel?: boolean | undefined;
    },
  ): ManagedWukongApplyResult;
  remove?(config: TConfig): void;
  readonly configPath?: string | undefined;
}

export interface ProvisionManagedWukongConfigOptions<TConfig> {
  readonly adapter: ManagedWukongConfigAdapter<TConfig>;
  readonly accessToken: string;
  readonly baseUrl?: string | undefined;
  readonly oauthKey?: string | undefined;
  readonly oauthHost?: string | undefined;
  readonly preserveDefaultModel?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly headers?: Record<string, string> | undefined;
}

function managedModelKey(modelId: string): string {
  return `${WUKONG_CODE_PLATFORM_ID}/${modelId}`;
}

interface SelectedDefaultModel {
  readonly modelKey: string;
  readonly thinking: boolean;
}

function capabilitiesForModel(model: ManagedWukongModelInfo): string[] | undefined {
  const caps = new Set<string>();
  // supports_thinking_type is the full three-state declaration and wins over
  // the legacy supports_reasoning boolean; absent (older servers) falls back.
  switch (model.supportsThinkingType) {
    case 'only':
      caps.add('thinking');
      caps.add('always_thinking');
      break;
    case 'both':
      caps.add('thinking');
      break;
    case 'no':
      break;
    case undefined:
      if (model.supportsReasoning) caps.add('thinking');
      break;
  }
  if (model.supportsImageIn) caps.add('image_in');
  if (model.supportsVideoIn) caps.add('video_in');
  if (model.supportsToolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

function defaultBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? wukongBaseUrl()).replace(/\/+$/, '');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function persistedOAuthHost(options: {
  readonly key: string;
  readonly oauthHost?: string | undefined;
}): string | undefined {
  const oauthHost = options.oauthHost;
  const normalized = normalizeEndpoint(oauthHost ?? DEFAULT_WUKONG_CODE_OAUTH_HOST);
  if (
    options.key === WUKONG_CODE_OAUTH_KEY &&
    normalized === normalizeEndpoint(DEFAULT_WUKONG_CODE_OAUTH_HOST)
  ) {
    return undefined;
  }
  return normalized;
}

function managedOAuthRef(options: {
  readonly key: string;
  readonly oauthHost?: string | undefined;
  readonly storage?: 'file' | 'keyring' | undefined;
}): ManagedWukongOAuthRef {
  const key = normalizeOAuthCredentialKey(options.key);
  const oauthHost = persistedOAuthHost({ key, oauthHost: options.oauthHost });
  return {
    storage: options.storage ?? 'file',
    key,
    oauthHost,
  };
}

function configuredOAuthRef(
  oauthRef: ManagedWukongOAuthRefInput | undefined,
): ManagedWukongOAuthRef | undefined {
  if (oauthRef === undefined) return undefined;
  const key = oauthRef.key;
  if (key === undefined) return undefined;
  return managedOAuthRef({
    storage: oauthRef.storage,
    key,
    oauthHost: oauthRef.oauthHost,
  });
}

export function wukongEnvBaseUrl(env: ManagedWukongEnv = process.env): string | undefined {
  return env.WUKONG_CODE_BASE_URL;
}

export function wukongEnvOAuthHost(env: ManagedWukongEnv = process.env): string | undefined {
  return env.WUKONG_CODE_OAUTH_HOST ?? env.WUKONG_OAUTH_HOST;
}

// Base URLs that share the default `oauth.wukong` credential slot.
const SHARED_DEFAULT_BASE_URLS: ReadonlySet<string> = new Set([
  normalizeEndpoint(DEFAULT_WUKONG_CODE_BASE_URL),
  // Historical defaults kept so older installs keep the same credential file.
  normalizeEndpoint('https://api.wukong.today/coding/v1'),
]);

export function resolveWukongOAuthKey(options: {
  readonly oauthHost?: string | undefined;
  readonly baseUrl?: string | undefined;
}): string {
  const oauthHost = normalizeEndpoint(options.oauthHost ?? DEFAULT_WUKONG_CODE_OAUTH_HOST);
  const baseUrl = defaultBaseUrl(options.baseUrl);
  const defaultOauthHost = normalizeEndpoint(DEFAULT_WUKONG_CODE_OAUTH_HOST);

  if (oauthHost === defaultOauthHost && SHARED_DEFAULT_BASE_URLS.has(baseUrl)) {
    return WUKONG_CODE_OAUTH_KEY;
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `${WUKONG_CODE_SCOPED_OAUTH_KEY_PREFIX}${digest}`;
}

/**
 * Resolve the full managed-Wukong OAuth ref (credential storage key +
 * persisted host) for an (oauthHost, baseUrl) environment.
 *
 * Single source of truth for "which credential slot does this environment map
 * to". Login, provisioning, and the runtime provider all derive their ref
 * through here, so the slot a token is written to always matches the slot it
 * is later read from — preventing the env-mismatch credential mix-ups this
 * scoping is meant to fix.
 */
export function resolveWukongOAuthRef(options: {
  readonly oauthHost?: string | undefined;
  readonly baseUrl?: string | undefined;
}): ManagedWukongOAuthRef {
  return managedOAuthRef({
    key: resolveWukongOAuthKey(options),
    oauthHost: options.oauthHost,
  });
}

export function resolveWukongRuntimeAuth(options: {
  readonly configuredBaseUrl?: string | undefined;
  readonly configuredOAuthRef?: ManagedWukongOAuthRefInput | undefined;
  readonly env?: ManagedWukongEnv | undefined;
}): ManagedWukongRuntimeAuth {
  const env = options.env ?? process.env;
  const envBaseUrl = wukongEnvBaseUrl(env);
  const envOAuthHost = wukongEnvOAuthHost(env);
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const baseUrl =
    envBaseUrl !== undefined ? normalizeBaseUrl(envBaseUrl) : options.configuredBaseUrl;
  const expected = resolveWukongOAuthRef({
    oauthHost: hasEnvOverride ? envOAuthHost : options.configuredOAuthRef?.oauthHost,
    baseUrl,
  });
  const configured = configuredOAuthRef(options.configuredOAuthRef);
  if (configured === undefined) return { baseUrl, oauthRef: expected };
  if (hasEnvOverride) return { baseUrl, oauthRef: expected };
  if (normalizeOAuthCredentialKey(configured.key) !== expected.key) {
    return { baseUrl, oauthRef: expected };
  }
  return { baseUrl, oauthRef: configured };
}

export function resolveWukongLoginAuth(options: {
  readonly configuredBaseUrl?: string | undefined;
  readonly configuredOAuthRef?: ManagedWukongOAuthRefInput | undefined;
  readonly requestedBaseUrl?: string | undefined;
  readonly requestedOAuthHost?: string | undefined;
  readonly env?: ManagedWukongEnv | undefined;
}): ManagedWukongLoginAuth {
  const env = options.env ?? process.env;
  const envBaseUrl = wukongEnvBaseUrl(env);
  const envOAuthHost = wukongEnvOAuthHost(env);
  const hasOverride =
    options.requestedBaseUrl !== undefined ||
    options.requestedOAuthHost !== undefined ||
    envBaseUrl !== undefined ||
    envOAuthHost !== undefined;
  const baseUrl =
    options.requestedBaseUrl !== undefined
      ? normalizeBaseUrl(options.requestedBaseUrl)
      : envBaseUrl !== undefined
        ? normalizeBaseUrl(envBaseUrl)
        : options.configuredBaseUrl;
  const oauthHost = options.requestedOAuthHost ?? envOAuthHost;
  if (hasOverride) return { baseUrl, oauthHost };

  const configured = configuredOAuthRef(options.configuredOAuthRef);
  if (configured === undefined) return { baseUrl, oauthHost };
  // Always honor a persisted oauth_host. Key-slot mismatches (legacy
  // `oauth/…` vs `oauth.…`, or an older scoped key for what is now the
  // default environment) must not fall back to the compile-time default
  // host — that is how logins were incorrectly sent to auth.wukong.today.
  const effectiveHost = oauthHost ?? configured.oauthHost;
  const expectedKey = resolveWukongOAuthKey({
    oauthHost: configured.oauthHost ?? effectiveHost,
    baseUrl,
  });
  const oauthRef =
    normalizeOAuthCredentialKey(configured.key) === expectedKey
      ? configured
      : resolveWukongOAuthRef({ oauthHost: configured.oauthHost ?? effectiveHost, baseUrl });
  return { baseUrl, oauthHost: effectiveHost, oauthRef };
}

function toModelInfo(item: unknown): ManagedWukongModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Wukong model "${item['id']}" must include a positive context_length.`);
  }
  const displayName = item['display_name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const supportsToolUse = Object.hasOwn(item, 'supports_tool_use')
    ? Boolean(item['supports_tool_use'])
    : true;
  return {
    id: item['id'],
    contextLength,
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsImageIn: Boolean(item['supports_image_in']),
    supportsVideoIn: Boolean(item['supports_video_in']),
    supportsToolUse,
    supportsThinkingType: parseSupportsThinkingType(item['supports_thinking_type']),
    displayName: normalizedDisplayName,
    protocol: parseModelProtocol(item['protocol']),
  };
}

// Unknown or missing values resolve to undefined so callers fall back to the
// legacy supports_reasoning boolean instead of guessing.
export function parseSupportsThinkingType(value: unknown): SupportsThinkingType | undefined {
  return value === 'only' || value === 'no' || value === 'both' ? value : undefined;
}

export async function fetchManagedWukongModels(
  options: FetchManagedWukongModelsOptions,
): Promise<ManagedWukongModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = defaultBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: {
      ...parseWukongCustomHeaders(),
      ...options.headers,
      Authorization: `Bearer ${options.accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const message = await readApiErrorMessage(
      response,
      `Failed to list Wukong models (HTTP ${response.status}).`,
    );
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new ManagedWukongModelsAuthError({
        status: response.status,
        baseUrl,
        message,
      });
    }
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${baseUrl}.`);
  }
  return payload['data']
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedWukongModelInfo => item !== undefined);
}

export function applyManagedWukongConfig(
  config: ManagedWukongConfigShape,
  options: {
    readonly models: readonly ManagedWukongModelInfo[];
    readonly baseUrl?: string | undefined;
    readonly oauthKey?: string | undefined;
    readonly oauthHost?: string | undefined;
    readonly preserveDefaultModel?: boolean | undefined;
  },
): ManagedWukongApplyResult {
  for (const model of options.models) {
    assertPositiveContextLength(model);
  }

  const baseUrl = defaultBaseUrl(options.baseUrl);
  const oauth =
    options.oauthKey !== undefined
      ? managedOAuthRef({ key: options.oauthKey, oauthHost: options.oauthHost })
      : resolveWukongOAuthRef({ baseUrl, oauthHost: options.oauthHost });
  const existingModels = config.models ?? {};
  if (options.models.length === 0) {
    config.providers[WUKONG_CODE_PROVIDER_NAME] = {
      type: 'wukong',
      baseUrl,
      apiKey: '',
      oauth,
    };
    let removedDefault = false;
    for (const [key, model] of Object.entries(existingModels)) {
      if (!isRecord(model) || model['provider'] !== WUKONG_CODE_PROVIDER_NAME) continue;
      delete existingModels[key];
      if (config.defaultModel === key) removedDefault = true;
    }
    config.models = existingModels;
    if (removedDefault) {
      config.defaultModel = undefined;
      config.defaultThinking = undefined;
    }
    if (config.services !== undefined) {
      delete config.services.wukongSearch;
      delete config.services.wukongFetch;
      if (Object.keys(config.services).length === 0) config.services = undefined;
    }
    return {
      defaultModel: config.defaultModel,
      defaultThinking: config.defaultThinking,
    };
  }
  const selectedDefault = selectDefaultModel(config, options.models, {
    preserveExisting: options.preserveDefaultModel === true,
  });

  config.providers[WUKONG_CODE_PROVIDER_NAME] = {
    type: 'wukong',
    baseUrl,
    apiKey: '',
    oauth,
  };

  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === WUKONG_CODE_PROVIDER_NAME) {
      delete existingModels[key];
    }
  }
  for (const model of options.models) {
    const capabilities = capabilitiesForModel(model);
    // Wukong Anthropic-compatible endpoint only accepts adaptive thinking
    // (`thinking: { type: 'adaptive' }`); the kosong adapter otherwise infers
    // budget-based thinking from the model name, which fails for Wukong model ids.
    // Restrict the override to thinking-capable models: the UI treats
    // `adaptiveThinking === true` as "supports a thinking toggle", so marking a
    // non-thinking model would misrepresent it.
    const supportsAdaptiveThinking =
      model.protocol === 'anthropic' &&
      (capabilities?.includes('thinking') === true ||
        capabilities?.includes('always_thinking') === true);
    existingModels[managedModelKey(model.id)] = {
      provider: WUKONG_CODE_PROVIDER_NAME,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities,
      displayName: model.displayName,
      protocol: model.protocol,
      // Wukong anthropic-compatible endpoint is served behind the beta Messages
      // API (`/v1/messages?beta=true`), so route anthropic-protocol models
      // through `client.beta.messages.create`.
      ...(model.protocol === 'anthropic' ? { betaApi: true } : {}),
      ...(supportsAdaptiveThinking ? { adaptiveThinking: true } : {}),
    };
  }

  config.models = existingModels;
  config.defaultModel = selectedDefault.modelKey;
  config.defaultThinking = selectedDefault.thinking;
  config.services = {
    wukongSearch: {
      baseUrl: `${baseUrl}/search`,
      apiKey: '',
      oauth,
    },
    wukongFetch: {
      baseUrl: `${baseUrl}/fetch`,
      apiKey: '',
      oauth,
    },
  };

  return {
    defaultModel: selectedDefault.modelKey,
    defaultThinking: selectedDefault.thinking,
  };
}

export function applyManagedWukongLogoutConfig(config: ManagedWukongConfigShape): void {
  delete config.providers[WUKONG_CODE_PROVIDER_NAME];

  let removedDefaultModel = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== WUKONG_CODE_PROVIDER_NAME) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefaultModel = true;
  }
  config.models = existingModels;

  if (removedDefaultModel) {
    config.defaultModel = undefined;
    config.defaultThinking = undefined;
  }

  if (config['defaultProvider'] === WUKONG_CODE_PROVIDER_NAME) {
    config['defaultProvider'] = undefined;
  }

  if (config.services !== undefined) {
    delete config.services.wukongSearch;
    delete config.services.wukongFetch;
    if (Object.keys(config.services).length === 0) {
      config.services = undefined;
    }
  }
}

// The server's three-state declaration overrides any stale defaultThinking
// being preserved from an earlier config: an always-thinking model ('only')
// must never end up with thinking off, and a non-thinking model ('no') must
// never end up with thinking on.
function forcedThinking(
  model: ManagedWukongModelInfo | undefined,
  fallback: boolean,
): boolean {
  if (model?.supportsThinkingType === 'only') return true;
  if (model?.supportsThinkingType === 'no') return false;
  return fallback;
}

function selectDefaultModel(
  config: ManagedWukongConfigShape,
  models: readonly ManagedWukongModelInfo[],
  options: { readonly preserveExisting: boolean },
): SelectedDefaultModel {
  const firstModel = models[0];
  if (firstModel === undefined) {
    throw new Error('No models available for Wukong.');
  }

  const managedModels = new Map(models.map((model) => [managedModelKey(model.id), model]));
  const existingModels = config.models ?? {};
  const currentDefault =
    typeof config.defaultModel === 'string' && config.defaultModel.length > 0
      ? config.defaultModel
      : undefined;

  if (
    options.preserveExisting &&
    currentDefault !== undefined &&
    canPreserveDefaultModel(existingModels, currentDefault, managedModels)
  ) {
    const preservedModel = managedModels.get(currentDefault);
    return {
      modelKey: currentDefault,
      thinking: forcedThinking(
        preservedModel,
        config.defaultThinking ?? preservedModel?.supportsReasoning ?? false,
      ),
    };
  }

  return {
    modelKey: managedModelKey(firstModel.id),
    thinking: forcedThinking(firstModel, config.defaultThinking ?? firstModel.supportsReasoning),
  };
}

function canPreserveDefaultModel(
  existingModels: Record<string, ManagedWukongModelAlias | Record<string, unknown>>,
  defaultModel: string,
  managedModels: ReadonlyMap<string, ManagedWukongModelInfo>,
): boolean {
  if (managedModels.has(defaultModel)) return true;
  const existing = existingModels[defaultModel];
  return isRecord(existing) && existing['provider'] !== WUKONG_CODE_PROVIDER_NAME;
}

export function clearManagedWukongConfig(
  config: ManagedWukongConfigShape,
): ManagedWukongCleanupResult {
  const removedProvider = Object.hasOwn(config.providers, WUKONG_CODE_PROVIDER_NAME);
  delete config.providers[WUKONG_CODE_PROVIDER_NAME];

  const removedModels: string[] = [];
  const models = config.models;
  if (models !== undefined) {
    for (const [key, model] of Object.entries(models)) {
      if (!isRecord(model) || model['provider'] !== WUKONG_CODE_PROVIDER_NAME) continue;
      delete models[key];
      removedModels.push(key);
    }
  }

  let defaultModelCleared = false;
  if (typeof config.defaultModel === 'string' && removedModels.includes(config.defaultModel)) {
    config.defaultModel = undefined;
    defaultModelCleared = true;
  }

  const removedServices: string[] = [];
  if (config.services?.wukongSearch !== undefined) {
    delete config.services.wukongSearch;
    removedServices.push('wukongSearch');
  }
  if (config.services?.wukongFetch !== undefined) {
    delete config.services.wukongFetch;
    removedServices.push('wukongFetch');
  }
  if (config.services !== undefined && Object.keys(config.services).length === 0) {
    config.services = undefined;
  }

  return {
    providerName: WUKONG_CODE_PROVIDER_NAME,
    removedProvider,
    removedModels,
    defaultModelCleared,
    removedServices,
  };
}

function assertPositiveContextLength(model: ManagedWukongModelInfo): void {
  if (!Number.isInteger(model.contextLength) || model.contextLength <= 0) {
    throw new Error(`Wukong model "${model.id}" must include a positive context_length.`);
  }
}

export async function provisionManagedWukongConfigAfterLogin(
  options: ProvisionManagedWukongConfigOptions<ManagedWukongConfigShape>,
): Promise<ManagedWukongProvisionResult> {
  return provisionManagedWukongConfig(options);
}

export async function provisionManagedWukongConfig<TConfig>(
  options: ProvisionManagedWukongConfigOptions<TConfig>,
): Promise<ManagedWukongProvisionResult> {
  const models = await fetchManagedWukongModels(options);
  const config = await options.adapter.read();
  const applied = options.adapter.apply(config, {
    models,
    baseUrl: options.baseUrl,
    oauthKey: options.oauthKey,
    oauthHost: options.oauthHost,
    preserveDefaultModel: options.preserveDefaultModel,
  });
  await options.adapter.write(config);
  return {
    providerName: WUKONG_CODE_PROVIDER_NAME,
    defaultModel: applied.defaultModel,
    defaultThinking: applied.defaultThinking,
    models,
    configPath: options.adapter.configPath,
  };
}
