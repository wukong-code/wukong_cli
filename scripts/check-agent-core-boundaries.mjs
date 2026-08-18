#!/usr/bin/env node
/**
 * Dependency-boundary guard for packages/agent-core.
 *
 * Flags NEW cross-module deep imports inside packages/agent-core/src:
 * an import/export-from specifier is a violation when it resolves
 * (relative, through the `#/` alias, or through the package's own
 * `@wukong/agent-core` name) into a DIFFERENT module and DEEPER than that
 * module's root (not exactly the module dir or its index file). Module roots,
 * same-module deep imports, imports from root files, and external packages are
 * allowed.
 *
 * Modules = immediate subdirectories of src/ plus immediate subdirectories of
 * src/agent/ (e.g. "loop", "agent/goal"). A file's module is the longest
 * matching module prefix of its path; root-level files (src/errors.ts,
 * src/index.ts, ...) belong to "root".
 *
 * Existing violations are grandfathered via
 * scripts/agent-core-boundaries-baseline.json. The script exits 0 only when
 * the current violation set exactly matches the baseline. New violations and
 * stale baseline entries both fail so a removed violation cannot be silently
 * reintroduced later.
 *
 * Usage:
 *   node scripts/check-agent-core-boundaries.mjs           # check
 *   node scripts/check-agent-core-boundaries.mjs --update  # rewrite baseline
 *
 * Exit code 0 if the current set matches the baseline, 1 otherwise.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const SRC_DIR = join(ROOT, "packages/agent-core/src");
const SRC_REL = "packages/agent-core/src";
const BASELINE_PATH = join(ROOT, "scripts/agent-core-boundaries-baseline.json");
const SELF_PACKAGE = "@wukong/agent-core";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Convert a platform path (including a Windows path on another OS) to POSIX. */
export function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

/**
 * Build the module list: immediate subdirectories of src/, plus immediate
 * subdirectories of src/agent/. Paths are POSIX-style, relative to src/.
 */
export function buildModules(srcDir) {
  /** @type {string[]} */
  const modules = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    modules.push(entry.name);
    if (entry.name === "agent") {
      for (const sub of readdirSync(join(srcDir, "agent"), {
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

/** Recursively collect TypeScript source files, POSIX-relative to srcDir. */
export function collectSourceFiles(dir, srcDir = dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full, srcDir));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(posix.extname(entry.name))
    ) {
      files.push(toPosixPath(relative(srcDir, full)));
    }
  }
  return files;
}

/** Return the module for a src-relative path, or "root" for root-level files. */
export function findModule(modules, srcRelPath) {
  for (const moduleName of modules) {
    if (srcRelPath.startsWith(`${moduleName}/`)) {
      return moduleName;
    }
  }
  return "root";
}

/**
 * Extract static module specifiers with the TypeScript parser. This covers
 * import declarations, export-from declarations, side-effect imports,
 * import-equals, CommonJS require calls, dynamic imports with
 * string/no-substitution-template arguments, and TypeScript import types while
 * naturally ignoring comments.
 */
export function extractSpecifiers(content, fileName = "source.ts") {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  /** @type {string[]} */
  const specifiers = [];
  /** @type {ts.TypeChecker | undefined} */
  let checker;
  const hasNodeModuleImport = sourceFile.statements.some(
    (statement) => ts.isImportDeclaration(statement) && isNodeModuleImport(statement)
  );

  function getChecker() {
    if (checker !== undefined) return checker;
    const options = {
      noLib: true,
      noResolve: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    };
    /** @type {ts.CompilerHost} */
    const host = {
      fileExists: (path) => path === fileName,
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => "",
      getDefaultLibFileName: () => "lib.d.ts",
      getDirectories: () => [],
      getNewLine: () => "\n",
      getSourceFile: (path) => path === fileName ? sourceFile : undefined,
      readFile: (path) => path === fileName ? content : undefined,
      useCaseSensitiveFileNames: () => true,
      writeFile: () => {},
    };
    checker = ts.createProgram([fileName], options, host).getTypeChecker();
    return checker;
  }

  function isCommonJsLoader(node, seen = new Set()) {
    if (ts.isCallExpression(node)) {
      return isCreateRequireFactory(node.expression);
    }
    if (!ts.isIdentifier(node)) return false;
    if (node.text !== "require" && !hasNodeModuleImport) return false;

    const symbol = getChecker().getSymbolAtLocation(node);
    if (symbol === undefined) return node.text === "require";
    if (seen.has(symbol)) return false;
    seen.add(symbol);

    const declarations = symbol.getDeclarations() ?? [];
    if (
      node.text === "require" &&
      declarations.length > 0 &&
      declarations.every(isAmbientDeclaration)
    ) {
      return true;
    }
    return declarations.some((declaration) => {
      return (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        isCommonJsLoaderInitializer(declaration.initializer, seen)
      );
    });
  }

  function isCommonJsLoaderInitializer(node, seen) {
    if (ts.isCallExpression(node) && isCreateRequireFactory(node.expression)) return true;
    return ts.isIdentifier(node) && isCommonJsLoader(node, seen);
  }

  function isCreateRequireFactory(node) {
    if (ts.isIdentifier(node)) {
      const symbol = getChecker().getSymbolAtLocation(node);
      return symbol?.getDeclarations()?.some((declaration) => {
        return (
          ts.isImportSpecifier(declaration) &&
          (declaration.propertyName?.text ?? declaration.name.text) === "createRequire" &&
          isNodeModuleImport(importDeclarationFor(declaration))
        );
      }) === true;
    }
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "createRequire" &&
      ts.isIdentifier(node.expression) &&
      getChecker().getSymbolAtLocation(node.expression)?.getDeclarations()?.some(
        (declaration) =>
          (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) &&
          isNodeModuleImport(importDeclarationFor(declaration))
      ) === true
    );
  }

  function importDeclarationFor(node) {
    for (let current = node; current !== undefined; current = current.parent) {
      if (ts.isImportDeclaration(current)) return current;
      if (ts.isSourceFile(current)) return undefined;
    }
    return undefined;
  }

  function isNodeModuleImport(node) {
    return (
      node !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === "module" || node.moduleSpecifier.text === "node:module")
    );
  }

  function isAmbientDeclaration(node) {
    for (let current = node; current !== undefined; current = current.parent) {
      if (
        ts.canHaveModifiers(current) &&
        ts.getModifiers(current)?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword
        ) === true
      ) {
        return true;
      }
      if (ts.isSourceFile(current)) return false;
    }
    return false;
  }

  function addStringLiteral(node) {
    if (
      node !== undefined &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      specifiers.push(node.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isCommonJsLoader(node.expression)
      ) {
        addStringLiteral(node.arguments[0]);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      addStringLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function sourceCandidates(base) {
  const extension = posix.extname(base);
  if (SOURCE_EXTENSIONS.has(extension)) return [base];
  if (extension === ".js") {
    return [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`];
  }
  if (extension === ".jsx") return [`${base.slice(0, -4)}.tsx`];
  if (extension === ".mjs") return [`${base.slice(0, -4)}.mts`];
  if (extension === ".cjs") return [`${base.slice(0, -4)}.cts`];
  if (extension !== "") return [];

  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.mts`,
    `${base}/index.cts`,
  ];
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/** Resolve a local specifier to an existing src-relative TypeScript file. */
export function resolveSpecifier(
  srcDir,
  fileSrcRel,
  specifier,
  packageName = SELF_PACKAGE
) {
  const normalizedSpecifier = toPosixPath(specifier);
  /** @type {string} */
  let base;
  if (normalizedSpecifier.startsWith("#/")) {
    base = normalizedSpecifier.slice(2);
  } else if (normalizedSpecifier === packageName) {
    base = "index";
  } else if (normalizedSpecifier.startsWith(`${packageName}/`)) {
    base = normalizedSpecifier.slice(packageName.length + 1);
  } else if (normalizedSpecifier.startsWith("./") || normalizedSpecifier.startsWith("../")) {
    base = posix.join(posix.dirname(fileSrcRel), normalizedSpecifier);
  } else {
    return null; // external package
  }

  base = posix.normalize(base);
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) {
    return null; // escapes src/
  }

  for (const candidate of sourceCandidates(base)) {
    if (isFile(join(srcDir, candidate))) {
      return candidate;
    }
  }
  return null;
}

/** Scan srcDir and return all cross-module deep-import violations. */
export function scanViolations({
  srcDir,
  srcRel = SRC_REL,
  packageName = SELF_PACKAGE,
}) {
  const modules = buildModules(srcDir);
  const files = collectSourceFiles(srcDir).toSorted((a, b) =>
    a.localeCompare(b)
  );

  /** @type {Array<{file: string, specifier: string, from: string, to: string}>} */
  const violations = [];
  for (const file of files) {
    const fromModule = findModule(modules, file);
    if (fromModule === "root") continue; // root files may import anywhere
    const content = readFileSync(join(srcDir, file), "utf8");
    for (const specifier of extractSpecifiers(content, file)) {
      const resolved = resolveSpecifier(srcDir, file, specifier, packageName);
      if (resolved === null) continue;
      const toModule = findModule(modules, resolved);
      if (toModule === "root" || toModule === fromModule) continue;
      // Importing the target module's root index is allowed.
      if (resolved === `${toModule}/index${posix.extname(resolved)}`) continue;
      violations.push({ file, specifier, from: fromModule, to: toModule });
    }
  }

  const current = new Set(
    violations.map((violation) =>
      `${srcRel}/${violation.file}: ${violation.specifier}`
    )
  );
  return { files, violations, current };
}

/** Compare current violations with the persisted baseline. */
export function compareBaseline(current, baseline) {
  const baselineSet = new Set(baseline);
  return {
    newViolations: [...current].filter((value) => !baselineSet.has(value)),
    stale: baseline.filter((value) => !current.has(value)),
  };
}

function readBaseline(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError("Boundary baseline must be an array of strings");
  }
  return parsed;
}

export function main(
  argv = process.argv.slice(2),
  {
    srcDir = SRC_DIR,
    srcRel = SRC_REL,
    baselinePath = BASELINE_PATH,
    logger = console,
  } = {}
) {
  const update = argv.includes("--update");
  const { files, violations, current } = scanViolations({ srcDir, srcRel });

  /** @type {string[]} */
  let baseline;
  try {
    baseline = readBaseline(baselinePath);
  } catch {
    logger.error(`❌ Could not read baseline file: ${baselinePath}`);
    return 1;
  }

  const { newViolations, stale } = compareBaseline(current, baseline);
  if (update) {
    if (newViolations.length > 0) {
      logger.error(
        `❌ Refusing to add ${newViolations.length} new cross-module deep ` +
          "import(s) to the baseline. Fix them before using --update."
      );
      return 1;
    }
    const sorted = [...current].toSorted((a, b) => a.localeCompare(b));
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    logger.log(
      `✅ Baseline reduced to ${sorted.length} violations (${baselinePath}).`
    );
    return 0;
  }

  // Per-module-pair summary (most violated boundaries first).
  const pairCounts = new Map();
  for (const violation of violations) {
    const key = `${violation.from} -> ${violation.to}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const pairs = [...pairCounts.entries()].toSorted((a, b) => b[1] - a[1]);

  logger.log(
    `Scanned ${files.length} files: ${current.size} cross-module deep imports ` +
      `(${baseline.length} grandfathered in baseline).`
  );
  if (pairs.length > 0) {
    logger.log("\nMost violated boundaries:");
    for (const [pair, count] of pairs.slice(0, 10)) {
      logger.log(`  ${count}\t${pair}`);
    }
  }

  if (stale.length > 0) {
    const noun = stale.length === 1 ? "entry" : "entries";
    logger.error(
      `\n❌ ${stale.length} stale baseline ${noun} must be removed by ` +
        "regenerating the baseline:"
    );
    for (const entry of stale) {
      logger.error(`  - ${entry}`);
    }
  }

  if (newViolations.length > 0) {
    logger.error(
      `\n❌ ${newViolations.length} NEW cross-module deep import(s) detected ` +
        "in packages/agent-core:"
    );
    for (const violation of newViolations.toSorted((a, b) =>
      a.localeCompare(b)
    )) {
      logger.error(`  - ${violation}`);
    }
  }

  if (stale.length > 0 || newViolations.length > 0) {
    logger.error(
      "\nCross-module imports must go through the target module's index. " +
        "Fix new imports; after removing violations, regenerate the baseline with: " +
        "node scripts/check-agent-core-boundaries.mjs --update"
    );
    return 1;
  }

  logger.log("\n✅ No new cross-module deep imports in packages/agent-core.");
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  process.exitCode = main();
}
