import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

import {
  handleProviderList,
  handleProviderRemove,
  handleProviderTest,
  registerProviderCommand,
  type ProviderDeps,
} from '#/cli/sub/provider';

describe('handleProviderList', () => {
  function makeHarness(config: {
    providers?: Record<string, unknown>;
    models?: Record<string, { provider: string }>;
    defaultModel?: string;
  }) {
    return {
      ensureConfigFile: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockResolvedValue({
        providers: config.providers ?? {},
        models: config.models ?? {},
        defaultModel: config.defaultModel,
      }),
      setConfig: vi.fn(),
      replaceConfig: vi.fn(),
      removeProvider: vi.fn(),
    };
  }

  function makeDeps(overrides: Partial<ProviderDeps> & { harness?: ReturnType<typeof makeHarness> } = {}): ProviderDeps {
    const harness = (overrides.harness ?? makeHarness({})) as unknown as ReturnType<ProviderDeps['getHarness']>;
    return {
      getHarness: () => harness,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      env: {},
      exit: vi.fn((code: number) => {
        throw new Error(`exit ${code}`);
      }) as unknown as (code: number) => never,
      ...overrides,
    };
  }

  it('reports no providers when config is empty', async () => {
    const deps = makeDeps();
    await handleProviderList(deps, { json: false });
    expect(deps.stdout.write).toHaveBeenCalledWith(
      'No providers configured. Run `wukong`, then enter `/provider` to add one.\n',
    );
  });

  it('lists providers with model counts in human format', async () => {
    const deps = makeDeps({
      harness: makeHarness({
        providers: {
          openai: { type: 'openai', source: { kind: 'apiJson', url: 'https://api.openai.com', apiKey: 'x' } },
          anthropic: { type: 'anthropic' },
        },
        models: {
          gpt4: { provider: 'openai' },
          claude: { provider: 'anthropic' },
        },
        defaultModel: 'gpt4',
      }),
    });
    await handleProviderList(deps, { json: false });

    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('openai'));
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('anthropic'));
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('Default model: gpt4'));
  });

  it('emits redacted JSON when requested', async () => {
    const deps = makeDeps({
      harness: makeHarness({
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'top-level-secret',
            env: { OPENAI_API_KEY: 'env-secret' },
            customHeaders: { Authorization: 'header-secret' },
            source: {
              kind: 'apiJson',
              url: 'https://catalog.example/api.json',
              apiKey: 'source-secret',
            },
          },
        },
        models: { gpt4: { provider: 'openai' } },
      }),
    });
    await handleProviderList(deps, { json: true });

    const output = JSON.parse((deps.stdout.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '{}');
    expect(output.providers.openai).toMatchObject({
      type: 'openai',
      hasApiKey: true,
      hasEnv: true,
      hasCustomHeaders: true,
      sourceKind: 'apiJson',
      sourceUrl: 'https://catalog.example/api.json',
    });
    expect(output.models).toHaveProperty('gpt4');
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('top-level-secret');
    expect(serialized).not.toContain('env-secret');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('source-secret');
  });
});

describe('handleProviderRemove', () => {
  function makeHarness(config: { providers?: Record<string, unknown> }) {
    return {
      ensureConfigFile: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockResolvedValue({
        providers: config.providers ?? {},
        models: {},
      }),
      setConfig: vi.fn(),
      replaceConfig: vi.fn(),
      removeProvider: vi.fn().mockResolvedValue({ providers: {}, models: {} }),
    };
  }

  function makeDeps(overrides: Partial<ProviderDeps> & { harness?: ReturnType<typeof makeHarness> } = {}): ProviderDeps {
    const harness = (overrides.harness ?? makeHarness({})) as unknown as ReturnType<ProviderDeps['getHarness']>;
    return {
      getHarness: () => harness,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      env: {},
      exit: vi.fn((code: number) => {
        throw new Error(`exit ${code}`);
      }) as unknown as (code: number) => never,
      ...overrides,
    };
  }

  it('removes an existing provider', async () => {
    const harness = makeHarness({ providers: { openai: { type: 'openai' } } });
    const deps = makeDeps({ harness });
    await handleProviderRemove(deps, 'openai');

    expect(harness.removeProvider).toHaveBeenCalledWith('openai');
    expect(deps.stdout.write).toHaveBeenCalledWith('Removed provider "openai".\n');
  });

  it('exits when the provider is not found', async () => {
    const deps = makeDeps({ harness: makeHarness({ providers: {} }) });
    await expect(handleProviderRemove(deps, 'openai')).rejects.toThrow('exit 1');
    expect(deps.stderr.write).toHaveBeenCalledWith('Provider "openai" not found.\n');
  });
});

describe('registerProviderCommand', () => {
  it('registers provider and catalog subcommands', () => {
    const program = new Command();
    registerProviderCommand(program, { env: {} });

    const provider = program.commands.find((cmd) => cmd.name() === 'provider')!;
    expect(provider).toBeDefined();

    const subNames = provider.commands.map((cmd) => cmd.name());
    expect(subNames).toContain('add');
    expect(subNames).toContain('remove');
    expect(subNames).toContain('list');
    expect(subNames).toContain('catalog');

    const catalog = provider.commands.find((cmd) => cmd.name() === 'catalog')!;
    const catalogSubs = catalog.commands.map((cmd) => cmd.name());
    expect(catalogSubs).toContain('list');
    expect(catalogSubs).toContain('add');

    const list = catalog.commands.find((cmd) => cmd.name() === 'list')!;
    const urlOption = list.options.find((option) => option.long === '--url')!;
    expect(urlOption.description).toContain('https://modelpricelab.com/api.json');
  });

  it('routes a bare provider command to the interactive setup without failing', async () => {
    const stdout = { write: vi.fn() };
    const program = new Command();
    program.exitOverride();
    registerProviderCommand(program, { env: {}, stdout });

    await program.parseAsync(['node', 'wukong', 'provider']);

    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('enter `/provider`'));
  });

  it('registers provider test subcommand with --timeout, --offline, and --json', () => {
    const program = new Command();
    registerProviderCommand(program, { env: {} });
    const provider = program.commands.find((cmd) => cmd.name() === 'provider')!;
    const testCmd = provider.commands.find((cmd) => cmd.name() === 'test');
    expect(testCmd).toBeDefined();
    const longs = testCmd!.options.map((option) => option.long);
    expect(longs).toEqual(expect.arrayContaining(['--timeout', '--offline', '--json']));
  });
});

describe('handleProviderTest', () => {
  function writeBuffer() {
    const chunks: string[] = [];
    return {
      chunks,
      writer: {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      },
    };
  }

  function makeHarness(config: {
    providers?: Record<string, unknown>;
    defaultProvider?: string;
    oauthToken?: string | Error;
  }) {
    return {
      ensureConfigFile: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockResolvedValue({
        providers: config.providers ?? {},
        models: {},
        defaultProvider: config.defaultProvider,
      }),
      setConfig: vi.fn(),
      replaceConfig: vi.fn(),
      removeProvider: vi.fn(),
      auth: {
        resolveOAuthTokenProvider: vi.fn(() => ({
          getAccessToken: vi.fn(async () => {
            if (config.oauthToken instanceof Error) {
              throw config.oauthToken;
            }
            return config.oauthToken ?? 'oauth-access-token';
          }),
        })),
      },
    };
  }

  function makeDeps(
    overrides: Partial<ProviderDeps> & {
      harness?: ReturnType<typeof makeHarness>;
      stdoutBuf?: ReturnType<typeof writeBuffer>;
      stderrBuf?: ReturnType<typeof writeBuffer>;
    } = {},
  ): ProviderDeps {
    const harness = (overrides.harness ?? makeHarness({})) as unknown as ReturnType<ProviderDeps['getHarness']>;
    return {
      getHarness: () => harness,
      stdout: overrides.stdout ?? overrides.stdoutBuf?.writer ?? writeBuffer().writer,
      stderr: overrides.stderr ?? overrides.stderrBuf?.writer ?? writeBuffer().writer,
      env: overrides.env ?? {},
      exit:
        overrides.exit
        ?? (vi.fn((code: number) => {
          throw new Error(`exit ${code}`);
        }) as unknown as (code: number) => never),
      fetch: overrides.fetch,
    };
  }

  it('probes openai, openai_responses, anthropic, google-genai, wukong, and vertexai with clean URLs and headers', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; redirect: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        redirect: init?.redirect,
      });
      return new Response('{}', { status: 200 });
    });

    const stdoutBuf = writeBuffer();
    const stderrBuf = writeBuffer();
    const harness = makeHarness({
      defaultProvider: 'openai',
      providers: {
        openai: { type: 'openai', apiKey: 'YOUR_OPENAI_KEY' },
        responses: { type: 'openai_responses', apiKey: 'YOUR_RESP_KEY' },
        anthropicV1: { type: 'anthropic', apiKey: 'YOUR_ANTHROPIC_KEY', baseUrl: 'https://api.example.test/v1' },
        anthropicRoot: { type: 'anthropic', apiKey: 'YOUR_ANTHROPIC_KEY2', baseUrl: 'https://api.example.test' },
        gemini: { type: 'google-genai', apiKey: 'YOUR_GEMINI_KEY' },
        managed: { type: 'wukong', oauth: { storage: 'file', key: 'wukong-code' } },
        vertex: { type: 'vertexai', apiKey: 'YOUR_VERTEX_KEY' },
      },
    });
    const deps = makeDeps({
      harness,
      stdoutBuf,
      stderrBuf,
      env: { WUKONG_CODE_BASE_URL: 'https://managed.example.test/api/v1' },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await handleProviderTest(deps, undefined, { json: true });

    const payload = JSON.parse(stdoutBuf.chunks.join('')) as {
      ok: boolean;
      results: Array<{ providerId: string; status: string; endpoint: string; httpStatus?: number }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.results.map((r) => [r.providerId, r.status, r.endpoint])).toEqual([
      ['openai', 'ok', 'https://api.openai.com/v1/models'],
      ['anthropicRoot', 'ok', 'https://api.example.test/v1/models'],
      ['anthropicV1', 'ok', 'https://api.example.test/v1/models'],
      ['gemini', 'ok', 'https://generativelanguage.googleapis.com/v1beta/models'],
      ['managed', 'ok', 'https://managed.example.test/api/v1/models'],
      ['responses', 'ok', 'https://api.openai.com/v1/models'],
      ['vertex', 'ok', 'https://aiplatform.googleapis.com/v1/models'],
    ]);
    expect(requests.every((req) => req.redirect === 'manual')).toBe(true);
    const geminiReq = requests.find((req) => req.url.includes('generativelanguage'))!;
    expect(geminiReq.url).not.toContain('key=');
    expect(geminiReq.headers['x-goog-api-key']).toBe('YOUR_GEMINI_KEY');
    const anthropicReq = requests.find((req) => req.headers['x-api-key'] === 'YOUR_ANTHROPIC_KEY')!;
    expect(anthropicReq.headers['anthropic-version']).toBe('2023-06-01');
    expect(stderrBuf.chunks).toEqual([]);
    expect(harness.setConfig).not.toHaveBeenCalled();
    expect(harness.replaceConfig).not.toHaveBeenCalled();
  });

  it('does not fall back to shell ANTHROPIC_API_KEY and reports auth-failed without calling fetch', async () => {
    const fetchMock = vi.fn();
    const stdoutBuf = writeBuffer();
    const deps = makeDeps({
      harness: makeHarness({
        providers: { anthropic: { type: 'anthropic' } },
      }),
      stdoutBuf,
      env: { ANTHROPIC_API_KEY: 'shell-anthropic-secret' },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await expect(handleProviderTest(deps, 'anthropic', { json: true })).rejects.toThrow('exit 1');
    expect(fetchMock).not.toHaveBeenCalled();
    const payload = JSON.parse(stdoutBuf.chunks.join('')) as { ok: boolean; results: Array<{ status: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.results[0]?.status).toBe('auth-failed');
  });

  it('classifies HTTP 401/403 as auth-failed, 404 as not-found, 302/503/DNS as network, and AbortError as timeout', async () => {
    const cases: Array<{
      name: string;
      handler: () => Promise<Response>;
      expectedStatus: string;
    }> = [
      {
        name: 'unauthorized',
        handler: async () => new Response('invalid api key', { status: 401 }),
        expectedStatus: 'auth-failed',
      },
      {
        name: 'forbidden',
        handler: async () => new Response('forbidden', { status: 403 }),
        expectedStatus: 'auth-failed',
      },
      {
        name: 'missing endpoint',
        handler: async () => new Response('missing', { status: 404 }),
        expectedStatus: 'not-found',
      },
      {
        name: 'redirect blocked',
        handler: async () => new Response('', { status: 302, headers: { location: 'https://evil.example.test' } }),
        expectedStatus: 'network',
      },
      {
        name: 'server error',
        handler: async () => new Response('boom', { status: 503 }),
        expectedStatus: 'network',
      },
      {
        name: 'dns error',
        handler: async () => {
          const err = new TypeError('fetch failed');
          (err as Error & { cause: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
            code: 'ENOTFOUND',
          });
          throw err;
        },
        expectedStatus: 'network',
      },
      {
        name: 'abort error',
        handler: async () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        },
        expectedStatus: 'timeout',
      },
    ];

    for (const testCase of cases) {
      const stdoutBuf = writeBuffer();
      const deps = makeDeps({
        harness: makeHarness({
          providers: { p: { type: 'openai', apiKey: 'YOUR_API_KEY' } },
        }),
        stdoutBuf,
        fetch: vi.fn(testCase.handler) as unknown as typeof globalThis.fetch,
      });
      await expect(handleProviderTest(deps, 'p', { json: true }), testCase.name).rejects.toThrow('exit 1');
      const payload = JSON.parse(stdoutBuf.chunks.join('')) as {
        results: Array<{ status: string }>;
      };
      expect(payload.results[0]?.status, testCase.name).toBe(testCase.expectedStatus);
    }
  });

  it('classifies actual slow responses exceeding timeout as timeout', async () => {
    const stdoutBuf = writeBuffer();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const harness = makeHarness({ providers: { p: { type: 'openai', apiKey: 'YOUR_API_KEY' } } });
    const { testConfiguredProviders } = await import('#/cli/lib/provider-test');
    const result = await testConfiguredProviders(
      harness as unknown as ReturnType<ProviderDeps['getHarness']>,
      {
        timeoutMs: 15,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      },
    );
    expect(result.results[0]?.status).toBe('timeout');
    void stdoutBuf;
  });

  it('supports offline mode via option and WUKONG_OFFLINE=1 without invoking fetch', async () => {
    for (const cfg of [
      { opts: { json: true, offline: true }, env: {} },
      { opts: { json: true }, env: { WUKONG_OFFLINE: '1' } },
    ]) {
      const fetchMock = vi.fn();
      const stdoutBuf = writeBuffer();
      const deps = makeDeps({
        harness: makeHarness({
          providers: { p: { type: 'openai', apiKey: 'YOUR_API_KEY' } },
        }),
        stdoutBuf,
        env: cfg.env,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      await expect(handleProviderTest(deps, 'p', cfg.opts)).rejects.toThrow('exit 1');
      expect(fetchMock).not.toHaveBeenCalled();
      const payload = JSON.parse(stdoutBuf.chunks.join('')) as {
        ok: boolean;
        results: Array<{ status: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.results[0]?.status).toBe('offline');
    }
  });

  it('handles missing providerId, empty config, conflicting apiKey+oauth, missing OAuth token, and vertexai ADC', async () => {
    const stderr1 = writeBuffer();
    await expect(
      handleProviderTest(makeDeps({ harness: makeHarness({ providers: {} }), stderrBuf: stderr1 }), 'missing', { json: false }),
    ).rejects.toThrow('exit 1');
    expect(stderr1.chunks.join('')).toContain('Provider "missing" not found.');

    const stderr2 = writeBuffer();
    await expect(
      handleProviderTest(makeDeps({ harness: makeHarness({ providers: {} }), stderrBuf: stderr2 }), undefined, { json: false }),
    ).rejects.toThrow('exit 1');
    expect(stderr2.chunks.join('')).toContain('No providers configured.');

    const stdout3 = writeBuffer();
    await expect(
      handleProviderTest(
        makeDeps({
          harness: makeHarness({
            providers: {
              conflict: { type: 'wukong', apiKey: 'YOUR_API_KEY', oauth: { storage: 'file', key: 'k' } },
              oauthBroken: { type: 'wukong', oauth: { storage: 'file', key: 'k' } },
              vertexAdc: { type: 'vertexai', env: { GOOGLE_CLOUD_PROJECT: 'proj' } },
            },
            oauthToken: new Error('not logged in'),
          }),
          stdoutBuf: stdout3,
        }),
        undefined,
        { json: true },
      ),
    ).rejects.toThrow('exit 1');
    const payload = JSON.parse(stdout3.chunks.join('')) as {
      results: Array<{ providerId: string; status: string }>;
    };
    expect(payload.results.map((r) => [r.providerId, r.status])).toEqual([
      ['conflict', 'auth-failed'],
      ['oauthBroken', 'auth-failed'],
      ['vertexAdc', 'auth-failed'],
    ]);
  });

  it('never leaks API keys, URL userinfo/query tokens, custom headers, error bodies, or raw fetch errors', async () => {
    const stdoutHttp = writeBuffer();
    const stderrHttp = writeBuffer();
    const fetchBodyLeak = vi.fn(async () => new Response('BODY_SECRET_LEAK_12345', { status: 401 }));
    const depsHttp = makeDeps({
      harness: makeHarness({
        providers: {
          leakTest: {
            type: 'openai',
            apiKey: 'sk-secret-test-value',
            baseUrl: 'https://user:pass@api.example.test/v1?token=query-secret',
            customHeaders: { 'X-Custom-Secret': 'hdr-secret-value' },
          },
        },
      }),
      stdoutBuf: stdoutHttp,
      stderrBuf: stderrHttp,
      fetch: fetchBodyLeak as unknown as typeof globalThis.fetch,
    });

    await expect(handleProviderTest(depsHttp, 'leakTest', { json: true })).rejects.toThrow('exit 1');

    const stdoutNet = writeBuffer();
    const stderrNet = writeBuffer();
    const fetchErrorLeak = vi.fn(async () => {
      throw new Error('Request failed for https://user:pass@api.example.test/v1?token=query-secret with sk-secret-test-value');
    });
    const depsNet = makeDeps({
      harness: makeHarness({
        providers: {
          leakNet: {
            type: 'openai',
            apiKey: 'sk-secret-test-value',
            baseUrl: 'https://user:pass@api.example.test/v1?token=query-secret',
          },
        },
      }),
      stdoutBuf: stdoutNet,
      stderrBuf: stderrNet,
      fetch: fetchErrorLeak as unknown as typeof globalThis.fetch,
    });

    await expect(handleProviderTest(depsNet, 'leakNet', { json: false })).rejects.toThrow('exit 1');

    const combined = [
      ...stdoutHttp.chunks,
      ...stderrHttp.chunks,
      ...stdoutNet.chunks,
      ...stderrNet.chunks,
    ].join('\n');
    expect(combined).not.toContain('sk-secret-test-value');
    expect(combined).not.toContain('user:pass');
    expect(combined).not.toContain('query-secret');
    expect(combined).not.toContain('hdr-secret-value');
    expect(combined).not.toContain('BODY_SECRET_LEAK_12345');
    expect(combined).toContain('https://api.example.test/v1/models');
  });
});
