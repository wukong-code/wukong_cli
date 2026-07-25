import { copyFile, mkdir, stat } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

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

const nodeRequire = createRequire(import.meta.url);
const NODE_SEA_SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export function injectionModeForTarget(target) {
  return target === 'darwin-x64' ? 'legacy-postject' : 'node-build-sea';
}

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

function postjectCliPath() {
  const packageJsonPath = nodeRequire.resolve('postject/package.json');
  return resolve(dirname(packageJsonPath), 'dist/cli.js');
}

async function injectLegacyDarwinX64(seaNodePath, executable) {
  await copyFile(seaNodePath, executable);
  await run('codesign', ['--remove-signature', executable]);
  await run(process.execPath, [
    postjectCliPath(),
    executable,
    'NODE_SEA_BLOB',
    nativeBlobPath(),
    '--sentinel-fuse',
    NODE_SEA_SENTINEL,
    '--macho-segment-name',
    'NODE_SEA',
  ]);
}

export async function runInjectStep() {
  const target = targetTriple();
  await ensureBlobExists();
  await mkdir(nativeBinDir(target), { recursive: true });

  const seaNodePath = await getSeaNodePath();
  const executable = nativeBinPath(target);
  if (injectionModeForTarget(target) === 'legacy-postject') {
    console.log(`Building Intel macOS executable with legacy SEA injection: ${executable}`);
    console.log(`Base Node.js binary: ${seaNodePath}`);
    await injectLegacyDarwinX64(seaNodePath, executable);
    return;
  }

  const buildConfigPath = await writeBuildSeaConfig(target, seaNodePath);

  console.log(`Building single executable with Node SEA: ${executable}`);
  console.log(`Base Node.js binary: ${seaNodePath}`);
  await run(seaNodePath, ['--build-sea', buildConfigPath]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runInjectStep();
}
