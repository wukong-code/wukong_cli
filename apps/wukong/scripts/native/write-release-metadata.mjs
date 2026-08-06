import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { appRoot, nativeArtifactsDir } from './paths.mjs';

const [target, sourceSha, profile, macosSignedAndNotarized] = process.argv.slice(2);
if (!target || !sourceSha || !profile) {
  console.error(
    'Usage: write-release-metadata.mjs <target> <source-sha> <profile> <macos-signed-and-notarized>',
  );
  process.exit(1);
}

if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
  console.error(`Invalid source SHA: ${sourceSha}`);
  process.exit(1);
}
if (!['true', 'false'].includes(macosSignedAndNotarized ?? '')) {
  console.error('macos-signed-and-notarized must be exactly true or false.');
  process.exit(1);
}
if (macosSignedAndNotarized === 'true' && !target.startsWith('darwin-')) {
  console.error(`Only Darwin targets may be recorded as signed and notarized: ${target}`);
  process.exit(1);
}
if (macosSignedAndNotarized === 'true' && profile !== 'release') {
  console.error('Only release-profile builds may be recorded as signed and notarized.');
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const artifactsDir = nativeArtifactsDir();
const metadataPath = resolve(artifactsDir, `wukong-${target}.build.json`);
const metadata = {
  schemaVersion: 1,
  target,
  version: packageJson.version,
  sourceRepository: process.env['GITHUB_REPOSITORY'] ?? 'mutnpc/wukong_cli',
  sourceSha,
  profile,
  macosSignedAndNotarized: macosSignedAndNotarized === 'true',
};

await mkdir(artifactsDir, { recursive: true });
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Wrote build metadata: ${metadataPath}`);
