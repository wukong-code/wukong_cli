import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

import {
  handleProviderList,
  handleProviderRemove,
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
});
