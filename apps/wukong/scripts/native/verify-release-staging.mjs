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

const [stagingDirArg, releaseTag, expectedSourceSha, outputDirArg] = process.argv.slice(2);
if (!stagingDirArg || !releaseTag || !expectedSourceSha || !outputDirArg) {
  console.error(
    'Usage: verify-release-staging.mjs <staging-dir> <release-tag> <source-sha> <output-dir>',
  );
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) {
  throw new Error(`Release tag must be v-prefixed semver: ${releaseTag}`);
}
if (!/^[a-f0-9]{40}$/.test(expectedSourceSha)) {
  throw new Error(`Expected an exact 40-character source SHA, got: ${expectedSourceSha}`);
}

const stagingDir = resolve(stagingDirArg);
const outputDir = resolve(outputDirArg);
const expectedVersion = releaseTag.slice(1);
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
    metadata.sourceSha !== expectedSourceSha ||
    metadata.profile !== 'release'
  ) {
    throw new Error(`Build metadata does not match the release contract: ${basename(metadataPath)}`);
  }
  const expectedMacosSigningState = target.startsWith('darwin-');
  if (metadata.macosSignedAndNotarized !== expectedMacosSigningState) {
    throw new Error(
      expectedMacosSigningState
        ? `macOS release artifact is not recorded as signed and notarized: ${zipName}`
        : `Non-macOS release artifact must not claim macOS signing or notarization: ${zipName}`,
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
  sourceRepository: process.env['GITHUB_REPOSITORY'] ?? 'mutnpc/wukong_cli',
  sourceSha: expectedSourceSha,
  workflowRun: process.env['GITHUB_RUN_ID']
    ? `https://github.com/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
    : undefined,
  generatedAt: new Date().toISOString(),
  artifacts,
};
await writeFile(
  resolve(outputDir, 'release-provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
);

console.log(
  `Verified ${String(TARGETS.length)} release archives from ${expectedSourceSha}; staged 13 public assets.`,
);
