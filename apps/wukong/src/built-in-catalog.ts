import {
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  loadBuiltInCatalog,
  type Catalog,
} from '@wukong/wukong-sdk';

import {
  WUKONG_CODE_CATALOG_URL,
  WUKONG_CODE_CATALOG_URL_ENV,
} from '#/constant/app';

// Filled by tsdown define in release builds. Source stays empty so the
// generated models.dev snapshot is not committed.
declare const __WUKONG_CODE_BUILT_IN_CATALOG__: string | undefined;

export const BUILT_IN_CATALOG_JSON: string | undefined =
  typeof __WUKONG_CODE_BUILT_IN_CATALOG__ === 'string'
    ? __WUKONG_CODE_BUILT_IN_CATALOG__
    : undefined;

export interface CatalogResult {
  readonly catalog: Catalog;
  readonly source: 'remote' | 'built-in';
  readonly url?: string;
}

interface FetchCatalogOptions {
  readonly url?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly builtInCatalogJson?: string;
  readonly useFallbacks?: boolean;
}

export function resolveCatalogUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[WUKONG_CODE_CATALOG_URL_ENV]?.trim();
  return configured === undefined || configured.length === 0
    ? WUKONG_CODE_CATALOG_URL
    : configured;
}

/**
 * Fetches the configured catalog, then models.dev when a mirror was
 * configured, and finally the release-embedded snapshot. Explicit `--url`
 * callers can disable fallbacks so a bad custom registry still fails loudly.
 * An explicit abort remains an abort; it must not silently continue into the
 * provider picker.
 */
export async function fetchProviderCatalog(
  options: FetchCatalogOptions = {},
): Promise<CatalogResult> {
  const primaryUrl = options.url ?? resolveCatalogUrl();
  const useFallbacks = options.useFallbacks ?? true;
  const urls =
    useFallbacks && primaryUrl !== DEFAULT_CATALOG_URL
      ? [primaryUrl, DEFAULT_CATALOG_URL]
      : [primaryUrl];
  let lastError: unknown;

  for (const url of urls) {
    try {
      const catalog = await fetchCatalog(url, options.signal, options.fetchImpl);
      return { catalog, source: 'remote', url };
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      lastError = error;
    }
  }

  const catalog = useFallbacks
    ? loadBuiltInCatalog(options.builtInCatalogJson ?? BUILT_IN_CATALOG_JSON)
    : undefined;
  if (catalog === undefined) throw lastError;
  return { catalog, source: 'built-in' };
}
