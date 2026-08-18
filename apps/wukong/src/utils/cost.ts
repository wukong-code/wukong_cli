import {
  loadBuiltInCatalog,
  type Catalog,
  type CatalogModelCost,
  type TokenUsage,
} from '@wukong/wukong-sdk';

import { BUILT_IN_CATALOG_JSON } from '#/built-in-catalog';

/**
 * Splits a model alias (`provider/model`) at the first `/`. Aliases without a
 * slash cannot be matched against the provider catalog, so they return
 * `undefined`.
 */
export function parseModelAlias(alias: string): { provider: string; model: string } | undefined {
  const slash = alias.indexOf('/');
  if (slash < 0) return undefined;
  return { provider: alias.slice(0, slash), model: alias.slice(slash + 1) };
}

export interface CostSummary {
  readonly usd: number;
  readonly partial: boolean;
}

export interface CostModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export type CostModelAliases = Readonly<Record<string, CostModelIdentity>>;

interface ModelCostEstimate {
  readonly usd: number;
  readonly estimated: boolean;
  readonly complete: boolean;
}

/**
 * Estimates the USD cost of per-model usage against the release-embedded
 * catalog snapshot (offline; no network I/O). Returns `undefined` when there
 * is no usage or when no alias matched any catalog pricing. Aliases without
 * catalog pricing contribute 0 and flag the summary as `partial`.
 */
export function summarizeCost(
  usageByModel: Record<string, TokenUsage> | undefined,
  catalog?: Catalog,
  modelAliases?: CostModelAliases,
): CostSummary | undefined {
  if (usageByModel === undefined) return undefined;
  const aliases = Object.keys(usageByModel);
  if (aliases.length === 0) return undefined;
  const effectiveCatalog = catalog ?? loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);

  let usd = 0;
  let matched = false;
  let partial = false;
  for (const alias of aliases) {
    const usage = usageByModel[alias]!;
    // Resumed-run deltas can retain historical model keys whose four counters
    // are all zero. They contributed nothing to this run and therefore must
    // not make an otherwise complete estimate look partial or unavailable.
    if (!hasTokenUsage(usage)) continue;
    const identity = modelAliases === undefined ? parseModelAlias(alias) : modelAliases[alias];
    const cost = identity === undefined
      ? undefined
      : effectiveCatalog?.[identity.provider]?.models?.[identity.model]?.cost;
    if (cost === undefined) {
      partial = true;
      continue;
    }
    const estimate = estimateModelCost(usage, cost);
    partial ||= !estimate.complete;
    if (!estimate.estimated) continue;
    matched = true;
    usd += estimate.usd;
  }
  if (!matched) return undefined;
  return { usd, partial };
}

function hasTokenUsage(usage: TokenUsage): boolean {
  return Object.values(usage).some((tokens) => tokens !== 0);
}

function estimateModelCost(usage: TokenUsage, cost: CatalogModelCost): ModelCostEstimate {
  const hasUsage = hasTokenUsage(usage);
  if (hasTieredPricing(cost)) {
    return { usd: 0, estimated: !hasUsage, complete: !hasUsage };
  }

  const components = [
    [usage.inputOther, cost.input],
    [usage.output, cost.output],
    [usage.inputCacheRead, cost.cache_read],
    [usage.inputCacheCreation, cost.cache_write],
  ] as const;
  let usd = 0;
  let pricedUsage = false;
  let complete = true;
  let hasPrice = false;
  for (const [tokens, price] of components) {
    const validPrice = typeof price === 'number' && Number.isFinite(price) && price >= 0;
    hasPrice ||= validPrice;
    if (tokens === 0) continue;
    if (!validPrice) {
      complete = false;
      continue;
    }
    pricedUsage = true;
    usd += tokens * price / 1_000_000;
  }
  return {
    usd,
    estimated: hasUsage ? pricedUsage : hasPrice,
    complete,
  };
}

function hasTieredPricing(cost: CatalogModelCost): boolean {
  const tiers = cost.tiers;
  if (tiers === undefined) return false;
  if (Array.isArray(tiers)) return tiers.length > 0;
  return Object.keys(tiers).length > 0;
}

/** Renders a cost summary; `'unavailable'` when there is nothing to estimate. */
export function formatCost(summary: CostSummary | undefined): string {
  if (summary === undefined) return 'unavailable';
  const formatted = summary.usd >= 0.01 ? summary.usd.toFixed(2) : summary.usd.toFixed(4);
  return `~$${formatted}${summary.partial ? '+' : ''}`;
}
