import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { run } from './exec.mjs';
import { appRoot, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_OFFICIAL_NODE_VERSION = 'v26.4.0';
const OFFICIAL_NODE_VERSION_BY_TARGET = Object.freeze({
  // Node's LIEF-based `--build-sea` output segfaults on macOS x64. Node also
  // skips its upstream SEA suite on this platform (nodejs/node#59553,
  // nodejs/node#60250). Keep Intel macOS on the stable Node 24 runtime and
  // inject its blob with postject in 03-inject.mjs.
  'darwin-x64': 'v24.18.0',
});
const NODE_SEA_CACHE_DIR = resolve(appRoot, '.node-sea');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export function officialNodeVersion(target = resolveTarget()) {
  return OFFICIAL_NODE_VERSION_BY_TARGET[target] ?? DEFAULT_OFFICIAL_NODE_VERSION;
}

/**
 * Map a Wukong target triple (e.g. darwin-x64, win32-x64) to the Node.js
 * distribution tag used in the official Node.js release tarballs.
 */
function nodePlatformTag(target) {
  const [platform, arch] = target.split('-');
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  if (platform === 'win32' && arch === 'arm64') return 'win-arm64';
  throw new Error(`Unsupported target for Node.js SEA build: ${target}`);
}

function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

function resolveTarget() {
  const envTarget = process.env.WUKONG_CODE_BUILD_TARGET;
  if (envTarget) return envTarget;
  return targetTriple();
}

function cachedNodePath(target = resolveTarget(), version = officialNodeVersion(target)) {
  const tag = nodePlatformTag(target);
  const ext = process.platform === 'win32' ? '.exe' : '';
  return resolve(NODE_SEA_CACHE_DIR, `node-${version}-${tag}`, 'bin', `node${ext}`);
}

function tarPath(target = resolveTarget(), version = officialNodeVersion(target)) {
  const tag = nodePlatformTag(target);
  return resolve(NODE_SEA_CACHE_DIR, `node-${version}-${tag}.tar.gz`);
}

function downloadUrl(target = resolveTarget(), version = officialNodeVersion(target)) {
  const tag = nodePlatformTag(target);
  return `https://nodejs.org/download/release/${version}/node-${version}-${tag}.tar.gz`;
}

async function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function nodeBinaryHasSentinel(nodePath) {
  try {
    const { readFile } = await import('node:fs/promises');
    const binary = await readFile(nodePath);
    return binary.includes(SENTINEL);
  } catch {
    return false;
  }
}

async function nodeVersion(nodePath) {
  try {
    const { stdout } = await execFileAsync(nodePath, ['--version'], { maxBuffer: 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function versionGte(version, minVersion) {
  // Strip leading 'v' and compare numeric components.
  const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
  const a = parse(version);
  const b = parse(minVersion);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

async function findUsableSystemNode(requiredVersion) {
  const candidates = [process.execPath];
  if (process.env.PATH) {
    const sep = process.platform === 'win32' ? ';' : ':';
    const ext = process.platform === 'win32' ? '.exe' : '';
    for (const dir of process.env.PATH.split(sep)) {
      candidates.push(resolve(dir, `node${ext}`));
    }
  }

  for (const nodePath of candidates) {
    if (!(await nodeBinaryHasSentinel(nodePath))) continue;
    const actualVersion = await nodeVersion(nodePath);
    if (actualVersion && versionGte(actualVersion, requiredVersion)) {
      return nodePath;
    }
  }
  return null;
}

async function downloadOfficialNode(
  target = resolveTarget(),
  version = officialNodeVersion(target),
) {
  const binPath = cachedNodePath(target, version);
  const archivePath = tarPath(target, version);
  const extractDir = resolve(NODE_SEA_CACHE_DIR, `node-${version}-${nodePlatformTag(target)}`);

  if (await nodeBinaryHasSentinel(binPath)) {
    console.log(`Using cached official Node.js binary for SEA build: ${binPath}`);
    return binPath;
  }

  await mkdir(NODE_SEA_CACHE_DIR, { recursive: true });
  console.log(`Downloading official Node.js ${version} for target ${target}...`);
  console.log(`URL: ${downloadUrl(target, version)}`);

  const response = await fetch(downloadUrl(target, version));
  if (!response.ok) {
    throw new Error(`Failed to download Node.js: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));

  console.log(`Extracting Node.js archive...`);
  await mkdir(extractDir, { recursive: true });
  await run('tar', ['-xzf', archivePath, '-C', extractDir, '--strip-components=1']);

  const digest = await sha256File(archivePath);
  console.log(`Downloaded and extracted Node.js ${version} (sha256: ${digest})`);

  return binPath;
}

export async function ensureSeaNodeBinary() {
  // Allow the caller / build environment to pin the Node.js binary used for
  // SEA generation. This is used by the Nix build, which prefetches an
  // official upstream Node binary because nixpkgs' nodejs_24 does not support
  // the --build-sea flag and the Nix sandbox cannot download at build time.
  const pinnedNode = process.env.WUKONG_SEA_NODE_PATH;
  if (pinnedNode) {
    console.log(`Using pinned Node.js binary for SEA build: ${pinnedNode}`);
    return pinnedNode;
  }

  const target = resolveTarget();
  const host = hostTarget();
  const version = officialNodeVersion(target);

  // When the requested target matches the host architecture we can reuse the
  // system Node.js if it already supports single-executable applications.
  // For cross-compilation we must download a Node.js binary for the target.
  // Intel macOS deliberately uses the exact Node 24 runtime because Node 26
  // SEA executables crash before JavaScript starts on that platform.
  if (target === host && target !== 'darwin-x64') {
    const usableNode = await findUsableSystemNode(version);
    if (usableNode !== null) {
      console.log(`Using system Node.js binary for SEA build: ${usableNode}`);
      return usableNode;
    }
  }

  return downloadOfficialNode(target, version);
}
