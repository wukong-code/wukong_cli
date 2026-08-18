#!/usr/bin/env node
/**
 * Dependency-boundary guard for packages/agent-core.
 *
 * Flags NEW cross-module deep imports inside packages/agent-core/src:
 * an import/export-from specifier is a violation when it resolves
 * (relative, or the `#/` alias = package src/) into a DIFFERENT module
 * and DEEPER than that module's root (not exactly the module dir or its
 * index.ts). Module roots, same-module deep imports, imports from root
 * files, and external packages are allowed.
 *
 * Modules = immediate subdirectories of src/ plus immediate
 * subdirectories of src/agent/ (e.g. "loop", "agent/goal"). A file's
 * module is the longest matching module prefix of its path; root-level
 * files (src/errors.ts, src/index.ts, ...) belong to "root".
 *
 * Existing violations are grandfathered via
 * scripts/agent-core-boundaries-baseline.json. The script exits 0 when
 * the current violation set is a subset of the baseline, and exits 1
 * listing any new violations. Stale baseline entries (violations that
 * no longer exist) are reported as a warning only.
 *
 * Usage:
 *   node scripts/check-agent-core-boundaries.mjs           # check
 *   node scripts/check-agent-core-boundaries.mjs --update  # rewrite baseline
 *
 * Exit code 0 if no new violations, 1 otherwise.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative, posix } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC_DIR = join(ROOT, "packages/agent-core/src");
const SRC_REL = "packages/agent-core/src";
const BASELINE_PATH = join(ROOT, "scripts/agent-core-boundaries-baseline.json");
const UPDATE = process.argv.includes("--update");

/**
 * Build the module list: immediate subdirectories of src/, plus
 * immediate subdirectories of src/agent/. Paths are posix-style,
 * relative to src/ (e.g. "loop", "agent/goal").
 */
function buildModules() {
  /** @type {string[]} */
  const modules = [];
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    modules.push(entry.name);
    if (entry.name === "agent") {
      for (const sub of readdirSync(join(SRC_DIR, "agent"), {
        withFileTypes: true,
      })) {
        if (sub.isDirectory()) {
          modules.push(`agent/${sub.name}`);
        }
      }
    }
  }
  // Longest first so findModule picks the longest matching prefix.
  return modules.toSorted((a, b) => b.length - a.length);
}

/**
 * Recursively collect all *.ts files under dir, posix-relative to SRC_DIR.
 */
function collectTsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(posix.join(...relative(SRC_DIR, full).split("/")));
    }
  }
  return files;
}

/**
 * The module a src-relative path belongs to ("loop", "agent/goal", ...),
 * or "root" for root-level files.
 */
function findModule(modules, srcRelPath) {
  for (const m of modules) {
    if (srcRelPath.startsWith(`${m}/`)) {
      return m;
    }
  }
  return "root";
}

/**
 * Extract import/export specifiers from source text via regex.
 * Covers `import ... from '...'`, `export ... from '...'`,
 * side-effect `import '...'`, and dynamic `import('...')`.
 */
function extractSpecifiers(content) {
  /** @type {string[]} */
  const specs = [];
  const patterns = [
    /(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\n}])\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

/**
 * Resolve a specifier to an existing src-relative .ts file, or null.
 * Handles `#/` (= src/), relative paths, `.ts` extension, and
 * directory `index.ts`.
 */
function resolveSpecifier(fileSrcRel, specifier) {
  /** @type {string} */
  let base;
  if (specifier.startsWith("#/")) {
    base = specifier.slice(2);
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(fileSrcRel), specifier));
  } else {
    return null; // external package
  }
  if (base.startsWith("../")) {
    return null; // escapes src/ (e.g. into other packages or node_modules)
  }
  const candidates = base.endsWith(".ts")
    ? [base]
    : base.endsWith(".js")
      ? [base.slice(0, -3) + ".ts"]
      : [`${base}.ts`, `${base}/index.ts`];
  for (const c of candidates) {
    if (existsSync(join(SRC_DIR, c))) {
      return c;
    }
  }
  return null;
}

function main() {
  const modules = buildModules();
  const files = collectTsFiles(SRC_DIR).toSorted((a, b) => a.localeCompare(b));

  /** @type {Array<{file: string, specifier: string, from: string, to: string}>} */
  const violations = [];
  for (const file of files) {
    const fromModule = findModule(modules, file);
    if (fromModule === "root") continue; // root files may import anywhere
    const content = readFileSync(join(SRC_DIR, file), "utf8");
    for (const specifier of extractSpecifiers(content)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) continue;
      const toModule = findModule(modules, resolved);
      if (toModule === "root" || toModule === fromModule) continue;
      // Importing the module root (its index.ts) is allowed.
      if (resolved === `${toModule}/index.ts`) continue;
      violations.push({ file, specifier, from: fromModule, to: toModule });
    }
  }

  // Per-module-pair summary (most violated boundaries first).
  const pairCounts = new Map();
  for (const v of violations) {
    const key = `${v.from} -> ${v.to}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const pairs = [...pairCounts.entries()].toSorted((a, b) => b[1] - a[1]);

  const current = new Set(
    violations.map((v) => `${SRC_REL}/${v.file}: ${v.specifier}`)
  );

  if (UPDATE) {
    const sorted = [...current].toSorted((a, b) => a.localeCompare(b));
    writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + "\n");
    console.log(
      `✅ Baseline rewritten with ${sorted.length} violations (${BASELINE_PATH}).`
    );
    return;
  }

  /** @type {string[]} */
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`❌ Could not read baseline file: ${BASELINE_PATH}`);
    process.exit(1);
  }
  const baselineSet = new Set(baseline);

  const newViolations = [...current].filter((v) => !baselineSet.has(v));
  const stale = baseline.filter((v) => !current.has(v));

  console.log(
    `Scanned ${files.length} files: ${current.size} cross-module deep imports ` +
      `(${baseline.length} grandfathered in baseline).`
  );
  if (pairs.length > 0) {
    console.log("\nMost violated boundaries:");
    for (const [pair, count] of pairs.slice(0, 10)) {
      console.log(`  ${count}\t${pair}`);
    }
  }

  if (stale.length > 0) {
    console.warn(
      `\n⚠️  ${stale.length} stale baseline entries no longer exist ` +
        "(safe to regenerate the baseline):"
    );
    for (const s of stale) {
      console.warn(`  - ${s}`);
    }
  }

  if (newViolations.length > 0) {
    console.error(
      `\n❌ ${newViolations.length} NEW cross-module deep import(s) detected ` +
        "in packages/agent-core:"
    );
    for (const v of newViolations.toSorted((a, b) => a.localeCompare(b))) {
      console.error(`  - ${v}`);
    }
    console.error(
      "\nCross-module imports must go through the target module's index " +
        "(module root). If this coupling is intentional, regenerate the " +
        "baseline with: node scripts/check-agent-core-boundaries.mjs --update"
    );
    process.exit(1);
  }

  console.log("\n✅ No new cross-module deep imports in packages/agent-core.");
}

main();
