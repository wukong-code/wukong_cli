import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  fetchProviderCatalog,
  resolveCatalogUrl,
} from '#/built-in-catalog';
import { WUKONG_CODE_CATALOG_URL } from '#/constant/app';
import { DEFAULT_CATALOG_URL } from '@wukong/wukong-sdk';
import {
  BUILT_IN_PROVIDER_IDS,
  buildBuiltInCatalog,
  fetchCatalog,
} from '../scripts/update-catalog.mjs';

const builtInCatalogJson = JSON.stringify({
  example: {
    id: 'example',
    models: {
      model: {
        id: 'model',
        limit: { context: 1000 },
      },
    },
  },
});

describe('resolveCatalogUrl', () => {
  it('uses a configured mirror and otherwise defaults to ModelPriceHub', () => {
    expect(
      resolveCatalogUrl({
        WUKONG_CODE_CATALOG_URL: ' https://catalog.example.test/api.json ',
      }),
    ).toBe('https://catalog.example.test/api.json');
    expect(resolveCatalogUrl({})).toBe(WUKONG_CODE_CATALOG_URL);
  });
});

describe('fetchProviderCatalog', () => {
  it('prefers the configured catalog when it is available', async () => {
    const remote = { remote: { id: 'remote' } };
    const fetchImpl = vi.fn(async () => Response.json(remote));

    await expect(
      fetchProviderCatalog({
        url: 'https://catalog.example.test/api.json',
        fetchImpl,
        builtInCatalogJson,
      }),
    ).resolves.toEqual({
      catalog: remote,
      source: 'remote',
      url: 'https://catalog.example.test/api.json',
    });
  });

  it('tries models.dev after a configured mirror fails', async () => {
    const upstream = { upstream: { id: 'upstream' } };
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('mirror fetch failed'))
      .mockResolvedValueOnce(Response.json(upstream));

    await expect(
      fetchProviderCatalog({
        url: 'https://catalog.example.test/api.json',
        fetchImpl,
        builtInCatalogJson,
      }),
    ).resolves.toEqual({
      catalog: upstream,
      source: 'remote',
      url: DEFAULT_CATALOG_URL,
    });
  });

  it('uses the built-in snapshot when both live requests fail', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await fetchProviderCatalog({
      url: 'https://catalog.example.test/api.json',
      fetchImpl,
      builtInCatalogJson,
    });

    expect(result.source).toBe('built-in');
    expect(result.catalog).toHaveProperty('example');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('can prove the embedded snapshot without making a network request', async () => {
    const fetchImpl = vi.fn();

    const result = await fetchProviderCatalog({
      offline: true,
      fetchImpl,
      builtInCatalogJson,
    });

    expect(result.source).toBe('built-in');
    expect(result.catalog).toHaveProperty('example');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed in offline mode when the build has no embedded snapshot', async () => {
    await expect(
      fetchProviderCatalog({ offline: true, builtInCatalogJson: '' }),
    ).rejects.toThrow('this build has no built-in snapshot');
  });

  it('preserves the live error when no built-in snapshot is available', async () => {
    const error = new TypeError('fetch failed');
    const fetchImpl = vi.fn(async () => {
      throw error;
    });

    await expect(
      fetchProviderCatalog({ fetchImpl, builtInCatalogJson: '' }),
    ).rejects.toBe(error);
  });

  it('does not use fallbacks for an explicit custom URL', async () => {
    const error = new TypeError('custom registry failed');
    const fetchImpl = vi.fn(async () => {
      throw error;
    });

    await expect(
      fetchProviderCatalog({
        url: 'https://custom.example.test/api.json',
        fetchImpl,
        builtInCatalogJson,
        useFallbacks: false,
      }),
    ).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not fall back after an explicit abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException('This operation was aborted', 'AbortError');
    const fetchImpl = vi.fn(async () => {
      throw error;
    });

    await expect(
      fetchProviderCatalog({
        signal: controller.signal,
        fetchImpl,
        builtInCatalogJson,
      }),
    ).rejects.toBe(error);
  });
});

describe('release built-in catalog', () => {
  it('keeps the common providers, including GLM and Kimi endpoints', () => {
    expect(BUILT_IN_PROVIDER_IDS).toEqual(
      new Set([
        'anthropic',
        'deepseek',
        'google',
        'kimi-for-coding',
        'moonshotai-cn',
        'openai',
        'openrouter',
        'zai',
        'zai-coding-plan',
      ]),
    );
  });

  it('drops providers and model fields outside the offline allowlist', () => {
    const result = buildBuiltInCatalog({
      zai: {
        id: 'zai',
        private: 'drop',
        models: {
          glm: {
            id: 'glm',
            limit: { context: 1000 },
            cost: { input: 1 },
          },
        },
      },
      other: {
        id: 'other',
        models: { model: { id: 'model' } },
      },
    });

    expect(result).toEqual({
      zai: {
        id: 'zai',
        models: {
          glm: {
            id: 'glm',
            limit: { context: 1000 },
          },
        },
      },
    });
  });

  it('records the exact bytes and HTTP identity of a release catalog snapshot', async () => {
    const response = Response.json(
      { openai: { id: 'openai', models: { model: { id: 'model' } } } },
      { headers: { etag: '"catalog-v1"', 'last-modified': 'Sat, 08 Aug 2026 00:00:00 GMT' } },
    );
    const fetchImpl = vi.fn(async () => response);

    const result = await fetchCatalog('https://models.example.test/api.json', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://models.example.test/api.json',
      { headers: { Accept: 'application/json' } },
    );
    expect(result.metadata).toEqual({
      schemaVersion: 1,
      requestedUrl: 'https://models.example.test/api.json',
      sourceUrl: 'https://models.example.test/api.json',
      etag: '"catalog-v1"',
      lastModified: 'Sat, 08 Aug 2026 00:00:00 GMT',
      sha256: createHash('sha256').update(result.json).digest('hex'),
      bytes: Buffer.byteLength(result.json),
    });
  });
});
