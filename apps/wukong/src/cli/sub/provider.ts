/**
 * `wukong provider` sub-command — non-interactive provider management.
 *
 * Mirrors the TUI `/provider` flow (apps/wukong/src/tui/commands/provider.ts)
 * for the custom-registry path so users can import an api.json document, drop
 * a provider, or inspect what is configured without launching the TUI.
 *
 * `add` writes the same `source = { kind: 'apiJson', url, apiKey }` blob the
 * TUI does; the next launch's `refreshAllProviderModels`
 * (apps/wukong/src/tui/utils/refresh-providers.ts) groups by URL, retries
 * available API-key candidates, and re-fetches the model list, so periodic
 * refresh is automatic.
 */

import {
  applyCustomRegistryEntries,
  CustomRegistryApiError,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedWukongConfigShape,
} from '@wukong/wukong-oauth';
import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogProviderModels,
  CatalogFetchError,
  createWukongHarness,
  DEFAULT_CATALOG_URL,
  inferWireType,
  type CatalogProviderEntry,
  type WukongConfig,
  type WukongHarness,
} from '@wukong/wukong-sdk';
import type { Command } from 'commander';

import {
  fetchProviderCatalog,
  resolveCatalogUrl,
  type CatalogResult,
} from '#/built-in-catalog';
import { createWukongCodeHostIdentity } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProviderDeps {
  readonly getHarness: () => WukongHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly env: NodeJS.ProcessEnv;
  readonly exit: (code: number) => never;
}

interface AddOptions {
  readonly apiKey?: string;
}

interface ListOptions {
  readonly json: boolean;
}

interface CatalogListOptions {
  readonly json: boolean;
  readonly filter?: string;
  readonly url?: string;
}

interface CatalogAddOptions {
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly url?: string;
}

export async function handleProviderAdd(
  deps: ProviderDeps,
  url: string,
  opts: AddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  if (apiKey === undefined) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or set WUKONG_REGISTRY_API_KEY.\n',
    );
    deps.exit(1);
  }

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    deps.stderr.write('Registry URL is required.\n');
    deps.exit(1);
  }

  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url: trimmedUrl,
    apiKey,
  };

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  try {
    entries = await fetchCustomRegistry(source);
  } catch (error) {
    const suffix = error instanceof CustomRegistryApiError ? ` (HTTP ${String(error.status)})` : '';
    deps.stderr.write(`Failed to fetch registry${suffix}: ${errorMessage(error)}\n`);
    deps.exit(1);
  }

  const entryList = Object.values(entries);
  if (entryList.length === 0) {
    deps.stderr.write(`Registry at ${trimmedUrl} contained no usable providers.\n`);
    deps.exit(1);
  }

  const config = await harness.getConfig();
  const previousDefaultModel = config.defaultModel;
  applyCustomRegistryEntries(asManaged(config), entries, source);
  config.defaultModel = previousDefaultModel !== undefined
    && config.models?.[previousDefaultModel] !== undefined
    ? previousDefaultModel
    : undefined;
  await harness.replaceConfig(config);

  const addedProviderIds = entryList.map((entry) => entry.id);
  const modelCount = entryList.reduce(
    (count, entry) => count + Object.keys(entry.models).length,
    0,
  );

  deps.stdout.write(
    `Imported ${String(addedProviderIds.length)} provider${addedProviderIds.length === 1 ? '' : 's'} ` +
      `(${String(modelCount)} model${modelCount === 1 ? '' : 's'}) from ${trimmedUrl}:\n`,
  );
  for (const id of addedProviderIds) {
    deps.stdout.write(`  - ${id}\n`);
  }
}

export async function handleProviderRemove(
  deps: ProviderDeps,
  providerId: string,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  if (config.providers[providerId] === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found.\n`);
    deps.exit(1);
  }
  await harness.removeProvider(providerId);
  deps.stdout.write(`Removed provider "${providerId}".\n`);
}

export async function handleProviderList(
  deps: ProviderDeps,
  opts: ListOptions,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();

  if (opts.json) {
    deps.stdout.write(`${JSON.stringify(providerListJson(config), null, 2)}\n`);
    return;
  }

  const modelsByProvider = new Map<string, string[]>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(alias);
    modelsByProvider.set(model.provider, list);
  }

  const providerIds = Object.keys(config.providers).toSorted();
  if (providerIds.length === 0) {
    deps.stdout.write(
      'No providers configured. Run `wukong`, then enter `/provider` to add one.\n',
    );
    return;
  }

  for (const id of providerIds) {
    const provider = config.providers[id]!;
    const aliases = modelsByProvider.get(id) ?? [];
    const sourceLabel = providerSourceLabel(provider);
    deps.stdout.write(
      `${id}  type=${provider.type}  models=${String(aliases.length)}  source=${sourceLabel}\n`,
    );
  }
  if (config.defaultModel !== undefined) {
    deps.stdout.write(`\nDefault model: ${config.defaultModel}\n`);
  }
}

/**
 * Fetches the models.dev-style public catalog and lists providers, or — when
 * `providerId` is given — drills into one provider and lists its models. This
 * mirrors the discovery half of the TUI "Known third-party provider" flow.
 */
export async function handleCatalogList(
  deps: ProviderDeps,
  providerId: string | undefined,
  opts: CatalogListOptions,
): Promise<void> {
  const url = opts.url ?? resolveCatalogUrl(deps.env);
  const { catalog } = await loadCatalogOrExit(deps, url, opts.url === undefined);

  if (providerId !== undefined) {
    const entry = catalog[providerId];
    if (entry === undefined) {
      deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
      deps.exit(1);
    }
    const models = catalogProviderModels(entry);
    if (opts.json) {
      deps.stdout.write(
        `${JSON.stringify({ providerId, name: entry.name ?? providerId, models }, null, 2)}\n`,
      );
      return;
    }
    if (models.length === 0) {
      deps.stdout.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
      return;
    }
    deps.stdout.write(`${entry.name ?? providerId} (${providerId})\n`);
    for (const model of models) {
      const cap: string[] = [];
      if (model.capability.tool_use) cap.push('tool_use');
      if (model.capability.thinking) cap.push('thinking');
      if (model.capability.image_in) cap.push('image_in');
      const ctx =
        typeof model.capability.max_context_tokens === 'number'
          ? String(model.capability.max_context_tokens)
          : '?';
      const capLabel = cap.length > 0 ? ` [${cap.join(',')}]` : '';
      deps.stdout.write(`  ${model.id}  ctx=${ctx}${capLabel}\n`);
    }
    return;
  }

  const filter = opts.filter?.toLowerCase();
  const entries = Object.entries(catalog)
    .filter(([id, entry]) => {
      if (filter === undefined) return true;
      const haystack = `${id} ${entry.name ?? ''}`.toLowerCase();
      return haystack.includes(filter);
    })
    .toSorted(([a], [b]) => a.localeCompare(b));

  if (opts.json) {
    const out: Record<string, CatalogProviderEntry> = {};
    for (const [id, entry] of entries) out[id] = entry;
    deps.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  if (entries.length === 0) {
    if (filter !== undefined) {
      deps.stdout.write(`No providers in catalog match "${filter}".\n`);
    } else {
      deps.stdout.write('Catalog is empty.\n');
    }
    return;
  }

  for (const [id, entry] of entries) {
    const modelCount = entry.models === undefined ? 0 : Object.keys(entry.models).length;
    const wire = inferWireType(entry) ?? '?';
    deps.stdout.write(
      `${id}  wire=${wire}  models=${String(modelCount)}  ${entry.name ?? ''}\n`,
    );
  }
}

/**
 * Imports a known provider from the models.dev catalog by id. Unlike
 * `provider add` (which expects a custom api.json), this command relies on
 * the catalog's normalized metadata to fill in context limits and capabilities.
 */
export async function handleCatalogAdd(
  deps: ProviderDeps,
  providerId: string,
  opts: CatalogAddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  if (apiKey === undefined) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or set WUKONG_REGISTRY_API_KEY.\n',
    );
    deps.exit(1);
  }

  const url = opts.url ?? resolveCatalogUrl(deps.env);
  const { catalog, source, url: sourceUrl } = await loadCatalogOrExit(
    deps,
    url,
    opts.url === undefined,
  );

  const entry = catalog[providerId];
  if (entry === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
    deps.exit(1);
  }

  const wire = inferWireType(entry);
  if (wire === undefined) {
    deps.stderr.write(`Provider "${providerId}" has an unsupported wire type in the catalog.\n`);
    deps.exit(1);
  }

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    deps.stderr.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
    deps.exit(1);
  }

  if (opts.defaultModel !== undefined && !models.some((m) => m.id === opts.defaultModel)) {
    deps.stderr.write(
      `Model "${opts.defaultModel}" is not in provider "${providerId}". Run "wukong provider catalog list ${providerId}" to see available ids.\n`,
    );
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  const config = await harness.getConfig();

  // Capture defaults BEFORE `removeProvider`, because that call clears
  // `defaultModel` when it points at one of this provider's aliases (see
  // `core-impl.ts removeWukongProvider`). Without this, re-importing an
  // already-configured provider would lose the user's previously-set default
  // even when `--default-model` is not supplied.
  const previousDefaultModel = config.defaultModel;
  const previousDefaultThinking = config.defaultThinking;

  const baseUrl = catalogBaseUrl(entry, wire);
  // `applyCatalogProvider` always overwrites both `defaultModel` and
  // `defaultThinking`. The values we pass here are temporary; we restore
  // a consistent state in the post-apply block below.
  applyCatalogProvider(config, {
    providerId,
    wire,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    apiKey,
    models,
    selectedModelId: opts.defaultModel ?? '',
    thinking: false,
  });

  // Resolve the final `defaultModel`:
  //   - If the caller asked for one, `applyCatalogProvider` already set it.
  //   - Else, restore the previous default ONLY when its alias still resolves
  //     after the catalog refresh; the catalog may have dropped the old
  //     model, in which case restoring would point default_model at a
  //     non-existent alias and break the next session.
  if (opts.defaultModel === undefined) {
    const stillResolves =
      previousDefaultModel !== undefined &&
      config.models?.[previousDefaultModel] !== undefined;
    config.defaultModel = stillResolves ? previousDefaultModel : undefined;
  }

  // Always restore `defaultThinking` from what was there before — including
  // `undefined`. Persisting `false` when the user never set it would make
  // `resolveThinkingLevel` (agent-core/src/agent/config/thinking.ts) treat
  // it as an explicit "off" request and silently disable thinking, even
  // for thinking-capable models.
  config.defaultThinking = previousDefaultThinking;

  await harness.replaceConfig(config);

  const displayName = entry.name ?? providerId;
  const sourceLabel =
    source === 'built-in'
      ? 'the built-in catalog snapshot'
      : (sourceUrl ?? url);
  deps.stdout.write(
    `Imported ${displayName} (${providerId}) with ${String(models.length)} model${models.length === 1 ? '' : 's'} from ${sourceLabel}.\n`,
  );
  if (opts.defaultModel !== undefined) {
    deps.stdout.write(`Default model set to ${providerId}/${opts.defaultModel}.\n`);
  } else if (config.defaultModel === undefined) {
    deps.stderr.write(
      'No default model is configured. Run `wukong`, enter `/provider`, and choose a model before starting a session.\n',
    );
  }
}

function providerListJson(config: WukongConfig): Record<string, unknown> {
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([id, provider]) => {
      const source = provider.source;
      const sourceKind = typeof source?.['kind'] === 'string' ? source['kind'] : undefined;
      const sourceUrl = typeof source?.['url'] === 'string' ? source['url'] : undefined;
      return [
        id,
        {
          type: provider.type,
          ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
          ...(provider.defaultModel === undefined ? {} : { defaultModel: provider.defaultModel }),
          hasApiKey: provider.apiKey !== undefined,
          hasOAuth: provider.oauth !== undefined,
          hasEnv: provider.env !== undefined && Object.keys(provider.env).length > 0,
          hasCustomHeaders:
            provider.customHeaders !== undefined && Object.keys(provider.customHeaders).length > 0,
          ...(sourceKind === undefined ? {} : { sourceKind }),
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
        },
      ];
    }),
  );
  const models = Object.fromEntries(
    Object.entries(config.models ?? {}).map(([alias, model]) => [
      alias,
      {
        provider: model.provider,
        model: model.model,
        maxContextSize: model.maxContextSize,
        ...(model.maxOutputSize === undefined ? {} : { maxOutputSize: model.maxOutputSize }),
        ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        ...(model.reasoningKey === undefined ? {} : { reasoningKey: model.reasoningKey }),
        ...(model.protocol === undefined ? {} : { protocol: model.protocol }),
        ...(model.adaptiveThinking === undefined
          ? {}
          : { adaptiveThinking: model.adaptiveThinking }),
        ...(model.betaApi === undefined ? {} : { betaApi: model.betaApi }),
      },
    ]),
  );
  return {
    providers,
    models,
    ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
  };
}

async function loadCatalogOrExit(
  deps: ProviderDeps,
  url: string,
  useFallbacks: boolean,
): Promise<CatalogResult> {
  try {
    const result = await fetchProviderCatalog({ url, useFallbacks });
    if (result.source === 'built-in') {
      deps.stderr.write(
        'Configured and upstream catalogs are unavailable; using the built-in snapshot.\n',
      );
    } else if (result.url !== url) {
      deps.stderr.write(
        `Catalog at ${url} is unavailable; using ${DEFAULT_CATALOG_URL}.\n`,
      );
    }
    return result;
  } catch (error) {
    const suffix = error instanceof CatalogFetchError ? ` (HTTP ${String(error.status)})` : '';
    deps.stderr.write(`Failed to fetch catalog from ${url}${suffix}: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerProviderCommand(parent: Command, deps?: Partial<ProviderDeps>): void {
  const defaultCatalogUrl = resolveCatalogUrl(deps?.env);
  const provider = parent
    .command('provider')
    .description('Configure LLM providers and browse or import provider catalogs.')
    .action(() => {
      const resolved = resolveDeps(deps);
      resolved.stdout.write(
        'Interactive provider setup is available in the TUI. Run `wukong`, then enter `/provider`.\nUse `wukong provider --help` for non-interactive commands.\n',
      );
    });

  // Last-resort boundary: handlers report expected failures themselves, but
  // anything that escapes (e.g. a config write rejected because config.toml
  // is invalid) must end as a one-line error + exit 1, not an unhandled
  // rejection dumping a stack trace.
  const runAction = async (resolved: ProviderDeps, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      resolved.stderr.write(`${errorMessage(error)}\n`);
      resolved.exit(1);
    }
  };

  provider
    .command('add <url>')
    .description('Import every provider listed in a custom registry (api.json).')
    .option('--api-key <key>', 'Registry API key. Falls back to WUKONG_REGISTRY_API_KEY.')
    .action(async (url: string, options: { apiKey?: string }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderAdd(resolved, url, { apiKey: options.apiKey }));
    });

  provider
    .command('remove <providerId>')
    .description('Remove a provider and every model alias that referenced it.')
    .action(async (providerId: string) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderRemove(resolved, providerId));
    });

  provider
    .command('list')
    .description('Show configured providers and their model counts.')
    .option('--json', 'Emit a redacted providers/models summary as JSON.', false)
    .action(async (options: { json?: boolean }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderList(resolved, { json: options.json === true }));
    });

  const catalog = provider
    .command('catalog')
    .description('Discover and import providers from a models.dev-compatible catalog.');

  catalog
    .command('list [providerId]')
    .description('List providers in the catalog, or models when a providerId is given.')
    .option('--filter <substring>', 'Case-insensitive id/name substring filter.')
    .option('--url <url>', `Override catalog URL. Defaults to ${defaultCatalogUrl}.`)
    .option('--json', 'Emit the matching catalog slice as JSON.', false)
    .action(
      async (
        providerId: string | undefined,
        options: { filter?: string; url?: string; json?: boolean },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleCatalogList(resolved, providerId, {
            json: options.json === true,
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            ...(options.url === undefined ? {} : { url: options.url }),
          }),
        );
      },
    );

  catalog
    .command('add <providerId>')
    .description('Import a known provider from the catalog by id.')
    .option('--api-key <key>', 'API key for the provider. Falls back to WUKONG_REGISTRY_API_KEY.')
    .option('--default-model <modelId>', 'Mark the imported model as default_model after import.')
    .option('--url <url>', `Override catalog URL. Defaults to ${defaultCatalogUrl}.`)
    .action(
      async (
        providerId: string,
        options: { apiKey?: string; defaultModel?: string; url?: string },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleCatalogAdd(resolved, providerId, {
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
            ...(options.url === undefined ? {} : { url: options.url }),
          }),
        );
      },
    );
}

function resolveDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  let harness: WukongHarness | undefined;
  const identity = createWukongCodeHostIdentity();
  return {
    getHarness:
      overrides.getHarness ??
      (() => {
        harness ??= createWukongHarness({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    env: overrides.env ?? process.env,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

function resolveApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env['WUKONG_REGISTRY_API_KEY'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return undefined;
}

function asManaged(config: WukongConfig): ManagedWukongConfigShape {
  return config as unknown as ManagedWukongConfigShape;
}

function providerSourceLabel(provider: WukongConfig['providers'][string]): string {
  const source = provider.source;
  if (source !== undefined) {
    if (source['kind'] === 'apiJson' && typeof source['url'] === 'string') {
      return `apiJson(${source['url']})`;
    }
  }
  if (provider.oauth !== undefined) return 'oauth';
  return 'inline';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
