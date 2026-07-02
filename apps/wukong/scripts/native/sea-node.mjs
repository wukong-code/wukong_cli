import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { run } from './exec.mjs';
import { appRoot } from './paths.mjs';

const OFFICIAL_NODE_VERSION = 'v26.4.0';
const NODE_SEA_CACHE_DIR = resolve(appRoot, '.node-sea');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function platformTag() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  throw new Error(`Unsupported platform/arch for SEA build: ${platform} ${arch}`);
}

function cachedNodePath() {
  const tag = platformTag();
  const ext = process.platform === 'win32' ? '.exe' : '';
  return resolve(NODE_SEA_CACHE_DIR, `node-${OFFICIAL_NODE_VERSION}-${tag}`, 'bin', `node${ext}`);
}

function tarPath() {
  const tag = platformTag();
  return resolve(NODE_SEA_CACHE_DIR, `node-${OFFICIAL_NODE_VERSION}-${tag}.tar.gz`);
}

function downloadUrl() {
  const tag = platformTag();
  return `https://nodejs.org/download/release/${OFFICIAL_NODE_VERSION}/node-${OFFICIAL_NODE_VERSION}-${tag}.tar.gz`;
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

async function findUsableSystemNode() {
  const candidates = [process.execPath];
  if (process.env.PATH) {
    const sep = process.platform === 'win32' ? ';' : ':';
    const ext = process.platform === 'win32' ? '.exe' : '';
    for (const dir of process.env.PATH.split(sep)) {
      candidates.push(resolve(dir, `node${ext}`));
    }
  }

  for (const nodePath of candidates) {
    if (await nodeBinaryHasSentinel(nodePath)) {
      return nodePath;
    }
  }
  return null;
}

async function downloadOfficialNode() {
  const binPath = cachedNodePath();
  const archivePath = tarPath();
  const extractDir = resolve(NODE_SEA_CACHE_DIR, `node-${OFFICIAL_NODE_VERSION}-${platformTag()}`);

  if (await nodeBinaryHasSentinel(binPath)) {
    console.log(`Using cached official Node.js binary for SEA build: ${binPath}`);
    return binPath;
  }

  await mkdir(NODE_SEA_CACHE_DIR, { recursive: true });
  console.log(`Downloading official Node.js ${OFFICIAL_NODE_VERSION} for SEA build...`);
  console.log(`URL: ${downloadUrl()}`);

  const response = await fetch(downloadUrl());
  if (!response.ok) {
    throw new Error(`Failed to download Node.js: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));

  console.log(`Extracting Node.js archive...`);
  await mkdir(extractDir, { recursive: true });
  await run('tar', ['-xzf', archivePath, '-C', extractDir, '--strip-components=1']);

  const digest = await sha256File(archivePath);
  console.log(`Downloaded and extracted Node.js ${OFFICIAL_NODE_VERSION} (sha256: ${digest})`);

  return binPath;
}

export async function ensureSeaNodeBinary() {
  const usableNode = await findUsableSystemNode();
  if (usableNode !== null) {
    console.log(`Using system Node.js binary for SEA build: ${usableNode}`);
    return usableNode;
  }

  return downloadOfficialNode();
}
