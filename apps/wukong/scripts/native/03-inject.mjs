import { mkdir, stat } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';

import { run } from './exec.mjs';
import {
  appRoot,
  nativeBinDir,
  nativeBinPath,
  nativeBlobPath,
  nativeIntermediatesDir,
  nativeSeaConfigPath,
  targetTriple,
} from './paths.mjs';
import { ensureSeaNodeBinary } from './sea-node.mjs';

async function getSeaNodePath() {
  if (process.env.WUKONG_SEA_NODE_PATH) return process.env.WUKONG_SEA_NODE_PATH;
  return ensureSeaNodeBinary();
}

async function ensureBlobExists() {
  try {
    await stat(nativeBlobPath());
  } catch {
    throw new Error(`SEA blob not found at ${nativeBlobPath()}. Run 02-sea-blob.mjs first.`);
  }
}

async function writeBuildSeaConfig(target, seaNodePath) {
  const baseConfig = JSON.parse(await readFile(nativeSeaConfigPath(), 'utf-8'));
  const buildConfig = {
    ...baseConfig,
    output: nativeBinPath(target),
    // Use a target-architecture Node.js binary as the SEA base so that
    // cross-compilation (e.g. darwin-x64 on an arm64 Mac) produces the
    // correct executable architecture.
    node: seaNodePath,
  };
  const buildConfigPath = `${nativeIntermediatesDir()}/sea-build-config.json`;
  await writeFile(buildConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`);
  return buildConfigPath;
}

export async function runInjectStep() {
  const target = targetTriple();
  await ensureBlobExists();
  await mkdir(nativeBinDir(target), { recursive: true });

  const seaNodePath = await getSeaNodePath();
  const buildConfigPath = await writeBuildSeaConfig(target, seaNodePath);

  console.log(`Building single executable with Node SEA: ${nativeBinPath(target)}`);
  console.log(`Base Node.js binary: ${seaNodePath}`);
  await run(seaNodePath, ['--build-sea', buildConfigPath]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runInjectStep();
}
