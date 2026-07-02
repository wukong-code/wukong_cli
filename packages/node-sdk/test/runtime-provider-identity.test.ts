import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WukongConfig } from '@wukong/agent-core';
import { createWukongDefaultHeaders, WUKONG_CODE_PLATFORM } from '@wukong/wukong-oauth';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { SDKRpcClient } from '#/index';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function resolveRuntimeProvider(options: {
  readonly config: WukongConfig;
  readonly model?: string;
  readonly wukongRequestHeaders?: Record<string, string>;
}) {
  const manager = new ProviderManager({
    config: options.config,
    wukongRequestHeaders: options.wukongRequestHeaders,
  });
  const model = options.model ?? options.config.defaultModel;
  if (model === undefined) {
    throw new Error('No model selected');
  }
  return manager.resolveProviderConfig(model);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wukong-sdk-provider-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider identity headers', () => {
  it('preserves the host user agent suffix in SDK RPC headers', async () => {
    const homeDir = await makeTempDir();
    const client = new SDKRpcClient({
      homeDir,
      identity: {
        ...TEST_IDENTITY,
        userAgentSuffix: 'web-runtime',
      },
    });
    const core = client.core as unknown as {
      readonly wukongRequestHeaders?: Record<string, string>;
    };

    try {
      expect(core.wukongRequestHeaders).toMatchObject({
        'User-Agent': 'wukong-cli/0.0.0-test (web-runtime)',
        'X-Wukong-Version': '0.0.0-test',
      });
    } finally {
      await client.close();
    }
  });

  it('adds wukong-cli User-Agent and complete X-Wukong headers to the default Wukong provider', async () => {
    const homeDir = await makeTempDir();
    const wukongRequestHeaders = createWukongDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'wukong-model',
        providers: {
          wukong: {
            type: 'wukong',
            apiKey: 'test-key',
          },
        },
        models: {
          'wukong-model': {
            provider: 'wukong',
            model: 'wukong-model',
            maxContextSize: 1000,
          },
        },
      },
      wukongRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'wukong-cli/0.0.0-test',
        'X-Wukong-Platform': WUKONG_CODE_PLATFORM,
        'X-Wukong-Version': '0.0.0-test',
        'X-Wukong-Device-Name': expect.any(String),
        'X-Wukong-Device-Model': expect.any(String),
        'X-Wukong-Os-Version': expect.any(String),
        'X-Wukong-Device-Id': expect.stringMatching(/^[0-9a-f-]+$/),
      }),
    });
  });

  it('lets Wukong provider customHeaders override default identity headers', async () => {
    const homeDir = await makeTempDir();
    const wukongRequestHeaders = createWukongDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: WukongConfig = {
      providers: {
        wukong: {
          type: 'wukong',
          apiKey: 'test-key',
          customHeaders: {
            'User-Agent': 'Custom/1',
            'X-Wukong-Version': 'override-version',
          },
        },
      },
      defaultProvider: 'wukong',
      defaultModel: 'wukong-model',
      models: {
        'wukong-model': {
          provider: 'wukong',
          model: 'wukong-model',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      wukongRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'Custom/1',
        'X-Wukong-Version': 'override-version',
        'X-Wukong-Platform': WUKONG_CODE_PLATFORM,
      }),
    });
  });

  it('applies only the User-Agent (no device identity headers) to non-Wukong providers', async () => {
    const homeDir = await makeTempDir();
    const wukongRequestHeaders = createWukongDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: WukongConfig = {
      providers: {
        openai: {
          type: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk-test',
        },
      },
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      models: {
        'gpt-test': {
          provider: 'openai',
          model: 'gpt-test',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      wukongRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-test',
      defaultHeaders: {
        'User-Agent': `wukong-cli/${TEST_IDENTITY.version}`,
      },
    });
    // Device identity headers (`X-Wukong-*`) stay Wukong-only — must not leak to
    // third-party providers.
    const headers = (resolved.provider as { defaultHeaders?: Record<string, string> })
      .defaultHeaders;
    expect(headers).toBeDefined();
    expect(headers).not.toHaveProperty('X-Wukong-Platform');
  });
});
