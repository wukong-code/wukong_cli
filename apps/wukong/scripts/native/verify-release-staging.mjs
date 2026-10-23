import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];

const [
  stagingDirArg,
  releaseTag,
  expectedSourceSha,
  outputDirArg,
  expectedMacosSigningArg = 'true',
] = process.argv.slice(2);
if (!stagingDirArg || !releaseTag || !expectedSourceSha || !outputDirArg) {
  console.error(
    'Usage: verify-release-staging.mjs <staging-dir> <release-tag> <source-sha> <output-dir> [expect-macos-signing]',
  );
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) {
  throw new Error(`Release tag must be v-prefixed semver: ${releaseTag}`);
}
if (!/^[a-f0-9]{40}$/.test(expectedSourceSha)) {
  throw new Error(`Expected an exact 40-character source SHA, got: ${expectedSourceSha}`);
}
if (expectedMacosSigningArg !== 'true' && expectedMacosSigningArg !== 'false') {
  throw new Error(`Expected macOS signing state must be true or false, got: ${expectedMacosSigningArg}`);
}

const stagingDir = resolve(stagingDirArg);
const outputDir = resolve(outputDirArg);
const expectedVersion = releaseTag.slice(1);
const distributionSha = process.env['WUKONG_RELEASE_DISTRIBUTION_SHA'];
const websiteSha = process.env['WUKONG_RELEASE_WEBSITE_SHA'];
if ((distributionSha === undefined) !== (websiteSha === undefined)) {
  throw new Error('Distribution and website SHAs must be recorded together.');
}
if (
  distributionSha !== undefined
  && (!/^[a-f0-9]{40}$/.test(distributionSha) || !/^[a-f0-9]{40}$/.test(websiteSha))
) {
  throw new Error('Distribution and website SHAs must be exact 40-character commits.');
}
const expectedStagingFiles = TARGETS.flatMap((target) => [
  `wukong-${target}.zip`,
  `wukong-${target}.zip.sha256`,
  `wukong-${target}.build.json`,
]).toSorted();
const actualStagingFiles = (await readdir(stagingDir)).toSorted();

if (JSON.stringify(actualStagingFiles) !== JSON.stringify(expectedStagingFiles)) {
  throw new Error(
    `Staging must contain exactly the 18 expected files.\nExpected: ${expectedStagingFiles.join(', ')}\nActual: ${actualStagingFiles.join(', ')}`,
  );
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const artifacts = [];
let builtInCatalog;
for (const target of TARGETS) {
  const zipName = `wukong-${target}.zip`;
  const zipPath = resolve(stagingDir, zipName);
  const checksumPath = `${zipPath}.sha256`;
  const metadataPath = resolve(stagingDir, `wukong-${target}.build.json`);

  const zipBytes = await readFile(zipPath);
  const actualSha256 = createHash('sha256').update(zipBytes).digest('hex');
  const checksumText = await readFile(checksumPath, 'utf-8');
  const checksumMatch = checksumText.match(/^([a-f0-9]{64})\s+([^\s]+)\s*$/);
  if (!checksumMatch || checksumMatch[1] !== actualSha256 || checksumMatch[2] !== zipName) {
    throw new Error(`Checksum file does not exactly match ${zipName}`);
  }

  const { stdout: archiveList } = await execFileAsync('unzip', ['-Z1', zipPath]);
  const expectedExecutable = target.startsWith('win32-') ? 'wukong.exe' : 'wukong';
  const entries = archiveList.split(/\r?\n/).filter(Boolean);
  if (entries.length !== 1 || entries[0] !== expectedExecutable) {
    throw new Error(`${zipName} must contain only ${expectedExecutable}; found ${entries.join(', ')}`);
  }

  const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
  if (
    metadata.schemaVersion !== 1 ||
    metadata.target !== target ||
    metadata.version !== expectedVersion ||
    metadata.sourceRepository !== 'wukong-code/wukong_cli' ||
    metadata.sourceSha !== expectedSourceSha ||
    metadata.profile !== 'release'
  ) {
    throw new Error(`Build metadata does not match the release contract: ${basename(metadataPath)}`);
  }
  if (
    metadata.builtInCatalog?.schemaVersion !== 1
    || typeof metadata.builtInCatalog.requestedUrl !== 'string'
    || typeof metadata.builtInCatalog.sourceUrl !== 'string'
    || !/^[a-f0-9]{64}$/.test(metadata.builtInCatalog.sha256 ?? '')
    || !Number.isInteger(metadata.builtInCatalog.bytes)
    || metadata.builtInCatalog.bytes <= 0
  ) {
    throw new Error(`Build metadata is missing the exact release catalog: ${basename(metadataPath)}`);
  }
  if (builtInCatalog === undefined) {
    builtInCatalog = metadata.builtInCatalog;
  } else if (JSON.stringify(metadata.builtInCatalog) !== JSON.stringify(builtInCatalog)) {
    throw new Error(`Release targets were not built from one catalog snapshot: ${basename(metadataPath)}`);
  }
  const expectedMacosSigningState =
    target.startsWith('darwin-') && expectedMacosSigningArg === 'true';
  if (metadata.macosSignedAndNotarized !== expectedMacosSigningState) {
    throw new Error(
      expectedMacosSigningState
        ? `macOS release artifact is not recorded as signed and notarized: ${zipName}`
        : `Release artifact must not claim Developer ID signing and notarization: ${zipName}`,
    );
  }

  await copyFile(zipPath, resolve(outputDir, zipName));
  await copyFile(checksumPath, resolve(outputDir, `${zipName}.sha256`));
  artifacts.push({ target, filename: zipName, sha256: actualSha256, build: metadata });
}

const provenance = {
  schemaVersion: 1,
  releaseTag,
  version: expectedVersion,
  sourceRepository: process.env['GITHUB_REPOSITORY'] ?? 'wukong-code/wukong_cli',
  sourceSha: expectedSourceSha,
  workflowRun: process.env['GITHUB_RUN_ID']
    ? `https://github.com/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
    : undefined,
  generatedAt: new Date().toISOString(),
  publicTruth: distributionSha === undefined ? undefined : {
    distributionRepository: 'wukong-code/wukong-code',
    distributionSha,
    websiteRepository: 'wukong-code/wukong_web',
    websiteSha,
  },
  builtInCatalog,
  artifacts,
};
await writeFile(
  resolve(outputDir, 'release-provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
);

console.log(
  `Verified ${String(TARGETS.length)} release archives from ${expectedSourceSha}; staged 13 public assets.`,
);
