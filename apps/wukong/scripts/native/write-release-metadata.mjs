import { createHash } from 'node:crypto';
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
const builtInCatalog = await readBuiltInCatalogMetadata(profile);
const metadata = {
  schemaVersion: 1,
  target,
  version: packageJson.version,
  sourceRepository: process.env['GITHUB_REPOSITORY'] ?? 'mutnpc/wukong_cli',
  sourceSha,
  profile,
  macosSignedAndNotarized: macosSignedAndNotarized === 'true',
  builtInCatalog,
};

await mkdir(artifactsDir, { recursive: true });
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Wrote build metadata: ${metadataPath}`);

async function readBuiltInCatalogMetadata(buildProfile) {
  if (buildProfile !== 'release') return undefined;

  const catalogPath = process.env['WUKONG_CODE_BUILT_IN_CATALOG_FILE'];
  const catalogMetadataPath = process.env['WUKONG_CODE_BUILT_IN_CATALOG_METADATA_FILE'];
  if (!catalogPath || !catalogMetadataPath) {
    throw new Error('Release metadata requires the exact built-in catalog and metadata files.');
  }

  const catalogBytes = await readFile(catalogPath);
  const catalogMetadata = JSON.parse(await readFile(catalogMetadataPath, 'utf-8'));
  const actualSha256 = createHash('sha256').update(catalogBytes).digest('hex');
  if (
    catalogMetadata.schemaVersion !== 1
    || typeof catalogMetadata.requestedUrl !== 'string'
    || typeof catalogMetadata.sourceUrl !== 'string'
    || !/^[a-f0-9]{64}$/.test(catalogMetadata.sha256 ?? '')
    || catalogMetadata.sha256 !== actualSha256
    || catalogMetadata.bytes !== catalogBytes.length
  ) {
    throw new Error('Built-in catalog metadata does not match the exact catalog bytes.');
  }
  return catalogMetadata;
}
