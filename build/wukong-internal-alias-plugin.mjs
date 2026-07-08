import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolve `#/` internal imports the same way the packages do at runtime via
 * their `package.json` `imports` field, but without relying on the bundler to
 * understand Node subpath imports.
 *
 * For an import like `#/auth` from `packages/node-sdk/src/index.ts`, the
 * plugin walks up to the nearest `package.json`, then resolves to
 * `<pkg>/src/auth.ts` (or `<pkg>/src/auth/index.ts` when that exists).
 *
 * This makes `#/` imports work in both Vitest and tsdown/rolldown across the
 * whole workspace.
 */
export function wukongInternalAliasPlugin() {
  const packageRootCache = new Map();

  function findPackageRoot(from) {
    if (packageRootCache.has(from)) return packageRootCache.get(from);
    let dir = from;
    while (dir !== dirname(dir)) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        // Stop at the first package.json that defines the #/ alias, otherwise
        // stop at any package root.
        if (pkg.imports && pkg.imports['#/*']) {
          packageRootCache.set(from, dir);
          return dir;
        }
        if (pkg.name && dir.endsWith(`/${pkg.name.replace(/^@.*\//, '')}`)) {
          packageRootCache.set(from, dir);
          return dir;
        }
      }
      dir = dirname(dir);
    }
    packageRootCache.set(from, undefined);
    return undefined;
  }

  return {
    name: 'wukong-internal-alias',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('#/')) return null;
      if (!importer) return null;
      const root = findPackageRoot(dirname(importer));
      if (!root) return null;
      const subpath = id.slice(2);
      const indexCandidate = resolve(root, 'src', subpath, 'index.ts');
      if (existsSync(indexCandidate)) return indexCandidate;
      return resolve(root, 'src', `${subpath}.ts`);
    },
  };
}
