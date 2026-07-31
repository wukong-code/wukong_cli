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
    expect(deps.stdout.write).toHaveBeenCalledWith('No providers configured.\n');
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

  it('emits JSON when requested', async () => {
    const deps = makeDeps({
      harness: makeHarness({
        providers: { openai: { type: 'openai' } },
        models: { gpt4: { provider: 'openai' } },
      }),
    });
    await handleProviderList(deps, { json: true });

    const output = JSON.parse((deps.stdout.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '{}');
    expect(output.providers).toHaveProperty('openai');
    expect(output.models).toHaveProperty('gpt4');
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
    expect(urlOption.description).toContain('https://modelpricehub.com/api.json');
  });
});
