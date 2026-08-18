import {
  estimateUsageCost,
  loadBuiltInCatalog,
  type Catalog,
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

/**
 * Estimates the USD cost of per-model usage against the release-embedded
 * catalog snapshot (offline; no network I/O). Returns `undefined` when there
 * is no usage or when no alias matched any catalog pricing. Aliases without
 * catalog pricing contribute 0 and flag the summary as `partial`.
 */
export function summarizeCost(
  usageByModel: Record<string, TokenUsage> | undefined,
  catalog?: Catalog,
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
    const parsed = parseModelAlias(alias);
    const cost = parsed === undefined
      ? undefined
      : effectiveCatalog?.[parsed.provider]?.models?.[parsed.model]?.cost;
    if (cost === undefined) {
      partial = true;
      continue;
    }
    matched = true;
    usd += estimateUsageCost(usage, cost);
  }
  if (!matched) return undefined;
  return { usd, partial };
}

/** Renders a cost summary; `'unavailable'` when there is nothing to estimate. */
export function formatCost(summary: CostSummary | undefined): string {
  if (summary === undefined) return 'unavailable';
  const formatted = summary.usd >= 0.01 ? summary.usd.toFixed(2) : summary.usd.toFixed(4);
  return `~$${formatted}${summary.partial ? '+' : ''}`;
}
