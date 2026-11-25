import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { runBundleStep } from './01-bundle.mjs';
import { collectNativeAssets, nativeAssetSummary } from './assets.mjs';
import { run } from './exec.mjs';
import { resolveTargetDeps } from './native-deps.mjs';
import { appRoot, targetTriple } from './paths.mjs';

export async function runNativePreflight(options = {}) {
  const target = options.target ?? targetTriple();
  const root = options.appRoot ?? appRoot;

  const visAssetPath = resolve(root, 'src', 'generated', 'vis-web-asset.ts');
  if (!existsSync(visAssetPath)) {
    await run(process.execPath, [resolve(root, 'scripts', 'build-vis-asset.mjs')]);
  }

  await runBundleStep();

  const { manifest, assets } = await collectNativeAssets({
    appRoot: root,
    target,
  });

  const requiredDeps = resolveTargetDeps(target);
  const byName = new Map(manifest.packages.map((pkg) => [pkg.name, pkg]));

  for (const dep of requiredDeps) {
    const pkg = byName.get(dep.resolvedName);
    if (pkg === undefined || pkg.files.length === 0) {
      throw new Error(`Native preflight missing package assets for ${dep.resolvedName}`);
    }
    if (dep.collect === 'native-files' && !pkg.files.some((file) => file.relativePath.endsWith('.node'))) {
      throw new Error(`Native preflight found no .node file in ${dep.resolvedName}`);
    }
  }

  const refPkg = byName.get('@wukong/reference-verification-skills');
  if (refPkg === undefined || refPkg.files.length === 0) {
    throw new Error('Native preflight missing @wukong/reference-verification-skills assets');
  }

  for (const [assetKey, filePath] of Object.entries(assets)) {
    if (!existsSync(filePath)) {
      throw new Error(`Native preflight asset file does not exist on disk (${assetKey}): ${filePath}`);
    }
  }

  console.log(`Native preflight passed for ${target}:`);
  for (const line of nativeAssetSummary(manifest)) {
    console.log(`- ${line}`);
  }
  return { manifest, assets };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runNativePreflight();
}
