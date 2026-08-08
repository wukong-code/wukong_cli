#!/usr/bin/env node
/**
 * Fetches a models.dev-compatible api.json, keeps the common providers needed
 * for offline setup, strips fields not needed by wukong, and writes the result
 * as raw JSON for release builds to inline.
 *
 * This script intentionally does not write into src/. The source tree keeps a
 * placeholder so the generated catalog is not committed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const scriptDir = import.meta.dirname;
const args = process.argv.slice(2);
const outFile = resolveOutputFile(args);
const metadataOutFile = resolveOptionalOutputFile(args, "--metadata-out");
const modelsUrl = process.env.MODELS_DEV_URL || "https://models.dev/api.json";

export const BUILT_IN_PROVIDER_IDS = new Set([
  "anthropic",
  "deepseek",
  "google",
  "kimi-for-coding",
  "moonshotai-cn",
  "openai",
  "openrouter",
  "zai",
  "zai-coding-plan",
]);

const KEEP_PROVIDER = new Set(["id", "name", "api", "env", "npm", "type", "models"]);
const KEEP_MODEL = new Set([
  "id",
  "name",
  "family",
  "limit",
  "tool_call",
  "reasoning",
  "interleaved",
  "modalities",
]);

function resolveOutputFile(args) {
  const index = args.indexOf("--out");
  if (index !== -1) {
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw new Error("Missing value for --out");
    }
    return resolve(process.cwd(), value);
  }
  return resolve(scriptDir, "../dist/built-in-catalog.json");
}

function resolveOptionalOutputFile(args, option) {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing value for ${option}`);
  }
  return resolve(process.cwd(), value);
}

export function stripModel(model) {
  if (typeof model !== "object" || model === null) return undefined;
  const result = {};
  for (const key of Object.keys(model)) {
    if (KEEP_MODEL.has(key)) result[key] = model[key];
  }
  return result;
}

export function stripProvider(provider) {
  if (typeof provider !== "object" || provider === null) return undefined;
  const result = {};
  for (const key of Object.keys(provider)) {
    if (!KEEP_PROVIDER.has(key)) continue;
    const value = provider[key];
    if (key === "models") {
      const stripped = {};
      for (const [mId, m] of Object.entries(value)) {
        const s = stripModel(m);
        if (s !== undefined) stripped[mId] = s;
      }
      if (Object.keys(stripped).length > 0) result[key] = stripped;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function buildBuiltInCatalog(raw, providerIds = BUILT_IN_PROVIDER_IDS) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid payload shape");
  }

  const stripped = {};
  for (const [id, provider] of Object.entries(raw)) {
    if (!providerIds.has(id)) continue;
    const value = stripProvider(provider);
    if (value !== undefined && Object.keys(value).length > 0) stripped[id] = value;
  }
  return stripped;
}

export async function fetchCatalog(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const json = JSON.stringify(buildBuiltInCatalog(raw));
  return {
    json,
    metadata: {
      schemaVersion: 1,
      requestedUrl: url,
      sourceUrl: res.url || url,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      sha256: createHash("sha256").update(json).digest("hex"),
      bytes: Buffer.byteLength(json),
    },
  };
}

async function main() {
  console.log(`Fetching ${modelsUrl} ...`);
  const { json, metadata } = await fetchCatalog(modelsUrl);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json, "utf-8");
  if (metadataOutFile !== undefined) {
    mkdirSync(dirname(metadataOutFile), { recursive: true });
    writeFileSync(metadataOutFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  }
  console.log(`Wrote ${outFile} (${(json.length / 1024).toFixed(0)} KB JSON)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
