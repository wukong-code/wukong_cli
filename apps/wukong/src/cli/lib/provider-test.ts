import type { ProviderConfig, ProviderType, WukongHarness } from '@wukong/wukong-sdk';

export type ProviderConnectivityStatus =
  | 'ok'
  | 'auth-failed'
  | 'not-found'
  | 'network'
  | 'timeout'
  | 'offline';

export interface ProviderTestResult {
  readonly providerId: string;
  readonly type: string;
  readonly endpoint: string;
  readonly status: ProviderConnectivityStatus;
  readonly httpStatus?: number;
  readonly latencyMs: number;
  readonly message: string;
}

export interface ProviderTestOptions {
  readonly providerId?: string;
  readonly timeoutMs?: number;
  readonly offline?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ProviderTestRunResult {
  readonly results: readonly ProviderTestResult[];
  readonly missingProviderId?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function sanitizeEndpointForDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '<invalid-url>';
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export async function testConfiguredProviders(
  harness: WukongHarness,
  options: ProviderTestOptions = {},
): Promise<ProviderTestRunResult> {
  const config = await harness.getConfig();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const offline = isOfflineMode(options.offline, env);

  if (options.providerId !== undefined) {
    const provider = config.providers[options.providerId];
    if (provider === undefined) {
      return { results: [], missingProviderId: options.providerId };
    }
    const result = await probeSingleProvider({
      harness,
      providerId: options.providerId,
      provider,
      timeoutMs,
      offline,
      env,
      fetchImpl,
    });
    return { results: [result], missingProviderId: undefined };
  }

  const orderedIds = orderProviderIds(Object.keys(config.providers), config.defaultProvider);
  if (orderedIds.length === 0) {
    return { results: [], missingProviderId: undefined };
  }

  const results: ProviderTestResult[] = [];
  for (const providerId of orderedIds) {
    const provider = config.providers[providerId];
    if (provider === undefined) continue;
    results.push(
      await probeSingleProvider({
        harness,
        providerId,
        provider,
        timeoutMs,
        offline,
        env,
        fetchImpl,
      }),
    );
  }
  return { results, missingProviderId: undefined };
}

export function formatProviderTestResults(results: readonly ProviderTestResult[]): string {
  const lines = ['Provider connectivity check:', ''];
  for (const result of results) {
    const statusLabel = result.status.padEnd(11);
    const httpInfo = result.httpStatus === undefined ? '' : ` [HTTP ${String(result.httpStatus)}]`;
    lines.push(
      `  ${statusLabel} ${result.providerId} (${result.type}) ${result.endpoint} (${String(result.latencyMs)}ms)${httpInfo}`,
    );
    lines.push(`              ${result.message}`);
  }
  lines.push('');
  return lines.join('\n');
}

function orderProviderIds(ids: readonly string[], defaultProvider?: string): string[] {
  const sorted = ids.toSorted((left, right) => left.localeCompare(right));
  if (defaultProvider !== undefined && sorted.includes(defaultProvider)) {
    return [defaultProvider, ...sorted.filter((id) => id !== defaultProvider)];
  }
  return sorted;
}

function isOfflineMode(explicitOffline: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return (
    explicitOffline === true
    || env['WUKONG_OFFLINE'] === '1'
    || env['WUKONG_CODE_OFFLINE'] === '1'
    || env['WUKONG_CODE_CATALOG_OFFLINE'] === '1'
  );
}

async function probeSingleProvider(input: {
  readonly harness: WukongHarness;
  readonly providerId: string;
  readonly provider: ProviderConfig;
  readonly timeoutMs: number;
  readonly offline: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof globalThis.fetch;
}): Promise<ProviderTestResult> {
  const { harness, providerId, provider, timeoutMs, offline, env, fetchImpl } = input;
  const baseUrl = resolveBaseUrl(providerId, provider, env);
  const target = buildProbeUrl(baseUrl, provider.type);

  if (offline) {
    return {
      providerId,
      type: provider.type,
      endpoint: target.displayEndpoint,
      status: 'offline',
      httpStatus: undefined,
      latencyMs: 0,
      message: 'Offline mode enabled; skipped connectivity probe.',
    };
  }

  if (target.probeUrl === undefined) {
    return {
      providerId,
      type: provider.type,
      endpoint: target.displayEndpoint,
      status: 'network',
      httpStatus: undefined,
      latencyMs: 0,
      message: 'Invalid provider endpoint URL. Check base_url in config.toml.',
    };
  }

  const authResolution = await resolveAuthHeaders(harness, providerId, provider, env);
  if (!authResolution.ok) {
    return {
      providerId,
      type: provider.type,
      endpoint: target.displayEndpoint,
      status: 'auth-failed',
      httpStatus: undefined,
      latencyMs: 0,
      message: authResolution.message,
    };
  }

  const headers = buildHeaders(provider.customHeaders, authResolution.headers);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(target.probeUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    await response.body?.cancel?.().catch(() => {});
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return classifyHttpResponse(providerId, provider.type, target.displayEndpoint, response.status, latencyMs);
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (timedOut || isTimeoutOrAbortError(error)) {
      return {
        providerId,
        type: provider.type,
        endpoint: target.displayEndpoint,
        status: 'timeout',
        httpStatus: undefined,
        latencyMs,
        message: `Connectivity probe timed out after ${String(timeoutMs)}ms.`,
      };
    }
    const safeCode = extractSafeErrorCode(error);
    return {
      providerId,
      type: provider.type,
      endpoint: target.displayEndpoint,
      status: 'network',
      httpStatus: undefined,
      latencyMs,
      message: safeCode === undefined
        ? 'Unable to reach provider endpoint.'
        : `Unable to reach provider endpoint (${safeCode}).`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttpResponse(
  providerId: string,
  type: string,
  endpoint: string,
  httpStatus: number,
  latencyMs: number,
): ProviderTestResult {
  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      providerId,
      type,
      endpoint,
      status: 'ok',
      httpStatus,
      latencyMs,
      message: 'Connected successfully.',
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      providerId,
      type,
      endpoint,
      status: 'auth-failed',
      httpStatus,
      latencyMs,
      message: `Authentication failed (HTTP ${String(httpStatus)}). Check your API key or credentials.`,
    };
  }
  if (httpStatus === 404) {
    return {
      providerId,
      type,
      endpoint,
      status: 'not-found',
      httpStatus,
      latencyMs,
      message: 'Provider models endpoint not found (HTTP 404). Verify base_url.',
    };
  }
  if (httpStatus === 408 || httpStatus === 504) {
    return {
      providerId,
      type,
      endpoint,
      status: 'timeout',
      httpStatus,
      latencyMs,
      message: `Provider endpoint timed out (HTTP ${String(httpStatus)}).`,
    };
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    return {
      providerId,
      type,
      endpoint,
      status: 'network',
      httpStatus,
      latencyMs,
      message: 'Provider endpoint returned an unexpected redirect (credentials are not forwarded).',
    };
  }
  return {
    providerId,
    type,
    endpoint,
    status: 'network',
    httpStatus,
    latencyMs,
    message: `Provider returned HTTP ${String(httpStatus)}.`,
  };
}

function resolveBaseUrl(
  providerId: string,
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
): string {
  switch (provider.type) {
    case 'openai':
    case 'openai_responses':
      return (
        nonEmpty(provider.baseUrl)
        ?? nonEmpty(provider.env?.['OPENAI_BASE_URL'])
        ?? 'https://api.openai.com/v1'
      );
    case 'wukong':
      if (provider.oauth !== undefined || providerId === 'managed:wukong') {
        return (
          nonEmpty(env['WUKONG_CODE_BASE_URL'])
          ?? nonEmpty(provider.baseUrl)
          ?? 'https://wukong.today/api/v1'
        );
      }
      return (
        nonEmpty(provider.baseUrl)
        ?? nonEmpty(provider.env?.['WUKONG_BASE_URL'])
        ?? 'https://api.wukong.ai/v1'
      );
    case 'anthropic':
      return (
        nonEmpty(provider.baseUrl)
        ?? nonEmpty(provider.env?.['ANTHROPIC_BASE_URL'])
        ?? 'https://api.anthropic.com'
      );
    case 'google-genai':
      return nonEmpty(provider.baseUrl) ?? 'https://generativelanguage.googleapis.com';
    case 'vertexai':
      return nonEmpty(provider.baseUrl) ?? 'https://aiplatform.googleapis.com';
  }
}

function buildProbeUrl(
  rawBaseUrl: string,
  type: ProviderType,
): { readonly probeUrl?: string; readonly displayEndpoint: string } {
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { probeUrl: undefined, displayEndpoint: '<invalid-url>' };
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = appendModelsPath(parsed.pathname, type);
    const probeUrl = parsed.toString();
    return {
      probeUrl,
      displayEndpoint: sanitizeEndpointForDisplay(probeUrl),
    };
  } catch {
    return { probeUrl: undefined, displayEndpoint: '<invalid-url>' };
  }
}

function appendModelsPath(pathname: string, type: ProviderType): string {
  const trimmed = pathname.replace(/\/+$/u, '');
  if (trimmed.endsWith('/models')) {
    return trimmed;
  }
  switch (type) {
    case 'openai':
    case 'openai_responses':
    case 'wukong':
      return `${trimmed}/models`;
    case 'anthropic':
      return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
    case 'google-genai':
      return trimmed.endsWith('/v1beta') || trimmed.endsWith('/v1')
        ? `${trimmed}/models`
        : `${trimmed}/v1beta/models`;
    case 'vertexai':
      return trimmed.endsWith('/v1') || trimmed.endsWith('/v1beta1')
        ? `${trimmed}/models`
        : `${trimmed}/v1/models`;
  }
}

async function resolveAuthHeaders(
  harness: WukongHarness,
  providerId: string,
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
): Promise<
  | { readonly ok: true; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly message: string }
> {
  if (nonEmpty(provider.apiKey) !== undefined && provider.oauth !== undefined) {
    return {
      ok: false,
      message: 'Provider has both api_key and oauth configured; keep only one authentication method.',
    };
  }

  switch (provider.type) {
    case 'openai':
    case 'openai_responses': {
      const apiKey =
        nonEmpty(provider.apiKey)
        ?? nonEmpty(provider.env?.['OPENAI_API_KEY'])
        ?? nonEmpty(env['OPENAI_API_KEY']);
      if (apiKey === undefined) {
        return {
          ok: false,
          message: 'Missing API key for OpenAI-compatible provider (expected api_key or OPENAI_API_KEY).',
        };
      }
      return { ok: true, headers: { Authorization: `Bearer ${apiKey}` } };
    }
    case 'wukong': {
      if (provider.oauth !== undefined) {
        const tokenProvider = harness.auth?.resolveOAuthTokenProvider?.(providerId, provider.oauth);
        if (tokenProvider === undefined) {
          return {
            ok: false,
            message: 'OAuth authentication required. Run `wukong login` to authenticate.',
          };
        }
        try {
          const token = nonEmpty(await tokenProvider.getAccessToken());
          if (token === undefined) {
            return {
              ok: false,
              message: 'OAuth authentication required. Run `wukong login` to authenticate.',
            };
          }
          return { ok: true, headers: { Authorization: `Bearer ${token}` } };
        } catch {
          return {
            ok: false,
            message: 'OAuth authentication required. Run `wukong login` to authenticate.',
          };
        }
      }
      const apiKey =
        nonEmpty(provider.apiKey)
        ?? nonEmpty(provider.env?.['WUKONG_API_KEY'])
        ?? nonEmpty(env['WUKONG_API_KEY']);
      if (apiKey === undefined) {
        return {
          ok: false,
          message: 'Missing API key or OAuth session for Wukong provider.',
        };
      }
      return { ok: true, headers: { Authorization: `Bearer ${apiKey}` } };
    }
    case 'anthropic': {
      const apiKey =
        nonEmpty(provider.apiKey)
        ?? nonEmpty(provider.env?.['ANTHROPIC_API_KEY']);
      if (apiKey === undefined) {
        return {
          ok: false,
          message: 'Missing API key for Anthropic provider (expected api_key or provider env ANTHROPIC_API_KEY).',
        };
      }
      return {
        ok: true,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      };
    }
    case 'google-genai': {
      const apiKey =
        nonEmpty(provider.apiKey)
        ?? nonEmpty(provider.env?.['GOOGLE_API_KEY'])
        ?? nonEmpty(env['GOOGLE_API_KEY']);
      if (apiKey === undefined) {
        return {
          ok: false,
          message: 'Missing API key for Google GenAI provider (expected api_key or GOOGLE_API_KEY).',
        };
      }
      return { ok: true, headers: { 'x-goog-api-key': apiKey } };
    }
    case 'vertexai': {
      const apiKey =
        nonEmpty(provider.apiKey)
        ?? nonEmpty(provider.env?.['VERTEXAI_API_KEY'])
        ?? nonEmpty(provider.env?.['GOOGLE_API_KEY']);
      if (apiKey === undefined) {
        return {
          ok: false,
          message: 'Vertex AI credentials require an API key or ADC runtime session; no API key is configured for static connectivity probing.',
        };
      }
      return { ok: true, headers: { 'x-goog-api-key': apiKey } };
    }
  }
}

function buildHeaders(
  customHeaders: Record<string, string> | undefined,
  authHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const protectedKeys = new Set([
    'accept',
    ...Object.keys(authHeaders).map((key) => key.toLowerCase()),
  ]);
  if (customHeaders !== undefined) {
    for (const [key, value] of Object.entries(customHeaders)) {
      if (!protectedKeys.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
  }
  headers['Accept'] = 'application/json';
  for (const [key, value] of Object.entries(authHeaders)) {
    headers[key] = value;
  }
  return headers;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTimeoutOrAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if ('cause' in error && error.cause instanceof Error) {
    return error.cause.name === 'AbortError' || error.cause.name === 'TimeoutError';
  }
  return false;
}

function extractSafeErrorCode(error: unknown): string | undefined {
  const directCode = readSafeCode(error);
  if (directCode !== undefined) return directCode;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return readSafeCode(error.cause);
  }
  return undefined;
}

function readSafeCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return undefined;
  }
  const raw = value.code;
  if (typeof raw !== 'string') return undefined;
  return /^[A-Z0-9_]{2,40}$/u.test(raw) ? raw : undefined;
}
