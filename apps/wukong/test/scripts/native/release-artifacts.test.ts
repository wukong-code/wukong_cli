import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';

import { appRoot } from '../../../scripts/native/paths.mjs';
import { verifyArchiveChecksum } from '../../../scripts/native/verify-archive.mjs';

const execFileAsync = promisify(execFile);
const packageScript = resolve(appRoot, 'scripts/native/package.mjs');
const manifestScript = resolve(appRoot, 'scripts/native/produce-manifest.mjs');
const releaseMetadataScript = resolve(appRoot, 'scripts/native/write-release-metadata.mjs');
const releaseStagingScript = resolve(appRoot, 'scripts/native/verify-release-staging.mjs');
const artifactsDir = resolve(appRoot, 'dist-native/artifacts');
const target = 'test-zip-artifact';
const catalogTarget = 'test-release-catalog-metadata';
const executableName = process.platform === 'win32' ? 'wukong.exe' : 'wukong';
const fakeBinary = resolve(appRoot, 'dist-native/bin', target, executableName);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zipEntryNames(zipPath: string): readonly string[] {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function readZipEntry(zipPath: string, expectedName: string): Buffer {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    if (name === expectedName) {
      return readLocalEntry(zip, localHeaderOffset, method, compressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`zip entry not found: ${expectedName}`);
}

function readLocalEntry(
  zip: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  expect(zip.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
  const nameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method: ${String(method)}`);
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('end of central directory not found');
}

async function writeSingleEntryZip(path: string, name: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(`binary for ${name}\n`), name, { mode: 0o100755 });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

describe('native release artifacts', () => {
  afterEach(() => {
    rmSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true, force: true });
    rmSync(resolve(artifactsDir, `wukong-${target}.zip`), { force: true });
    rmSync(resolve(artifactsDir, `wukong-${target}.zip.sha256`), { force: true });
    rmSync(resolve(artifactsDir, `wukong-${catalogTarget}.build.json`), { force: true });
  });

  it('packages the native binary as a zip archive and checksums the archive', async () => {
    const binaryContent = 'native binary payload\n';
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, binaryContent, { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, WUKONG_CODE_BUILD_TARGET: target },
    });

    const archivePath = resolve(artifactsDir, `wukong-${target}.zip`);
    const checksumPath = `${archivePath}.sha256`;
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(checksumPath)).toBe(true);
    expect(zipEntryNames(archivePath)).toEqual([executableName]);
    expect(readZipEntry(archivePath, executableName).toString('utf-8')).toBe(binaryContent);
    expect(readFileSync(checksumPath, 'utf-8')).toBe(
      `${sha256(readFileSync(archivePath))}  wukong-${target}.zip\n`,
    );
  });

  it('produces a manifest from zip archive checksums', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'wukong-manifest-zip-'));
    const archiveBytes = Buffer.from('fake zip bytes');
    const checksum = sha256(archiveBytes);
    await writeFile(join(releaseDir, 'wukong-darwin-arm64.zip'), archiveBytes);
    await writeFile(
      join(releaseDir, 'wukong-darwin-arm64.zip.sha256'),
      `${checksum}  wukong-darwin-arm64.zip\n`,
    );

    await execFileAsync(process.execPath, [manifestScript, releaseDir, '@wukong/wukong@0.5.0']);

    const manifest = JSON.parse(
      await readFile(join(releaseDir, 'manifest.json'), 'utf-8'),
    ) as {
      version: string;
      tag: string;
      platforms: Record<string, { filename: string; checksum: string }>;
    };
    expect(manifest).toEqual({
      version: '0.5.0',
      tag: '@wukong/wukong@0.5.0',
      platforms: {
        'darwin-arm64': {
          filename: 'wukong-darwin-arm64.zip',
          checksum,
        },
      },
    });
  });

  it('verifies an exact public archive checksum and rejects filename or digest drift', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'wukong-public-archive-'));
    const archivePath = join(releaseDir, 'wukong-linux-x64.zip');
    const checksumPath = `${archivePath}.sha256`;
    const archiveBytes = Buffer.from('public release bytes');
    await writeFile(archivePath, archiveBytes);
    await writeFile(checksumPath, `${sha256(archiveBytes)}  wukong-linux-x64.zip\n`);

    await expect(verifyArchiveChecksum(archivePath, checksumPath)).resolves.toEqual({
      archiveName: 'wukong-linux-x64.zip',
      sha256: sha256(archiveBytes),
    });

    await writeFile(checksumPath, `${sha256(archiveBytes)}  another.zip\n`);
    await expect(verifyArchiveChecksum(archivePath, checksumPath)).rejects.toThrow(
      'does not exactly match',
    );
  });

  it('records and verifies the exact built-in catalog in release metadata', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'wukong-release-catalog-'));
    const catalogPath = join(releaseDir, 'catalog.json');
    const catalogMetadataPath = join(releaseDir, 'catalog-metadata.json');
    const catalogBytes = Buffer.from('{"openai":{"id":"openai"}}');
    const catalogMetadata = {
      schemaVersion: 1,
      requestedUrl: 'https://models.dev/api.json',
      sourceUrl: 'https://models.dev/api.json',
      etag: '"catalog-v1"',
      lastModified: null,
      sha256: sha256(catalogBytes),
      bytes: catalogBytes.length,
    };
    await writeFile(catalogPath, catalogBytes);
    await writeFile(catalogMetadataPath, `${JSON.stringify(catalogMetadata)}\n`);

    await execFileAsync(
      process.execPath,
      [releaseMetadataScript, catalogTarget, 'a'.repeat(40), 'release', 'false'],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          WUKONG_CODE_BUILT_IN_CATALOG_FILE: catalogPath,
          WUKONG_CODE_BUILT_IN_CATALOG_METADATA_FILE: catalogMetadataPath,
        },
      },
    );

    const metadata = JSON.parse(
      await readFile(resolve(artifactsDir, `wukong-${catalogTarget}.build.json`), 'utf-8'),
    ) as { builtInCatalog: typeof catalogMetadata };
    expect(metadata.builtInCatalog).toEqual(catalogMetadata);
  });

  it.skipIf(process.platform === 'win32')(
    'verifies one catalog and three-repository identity across an rc staging set',
    async () => {
      const stagingDir = await mkdtemp(join(tmpdir(), 'wukong-rc-staging-'));
      const outputDir = await mkdtemp(join(tmpdir(), 'wukong-rc-assets-'));
      const sourceSha = 'a'.repeat(40);
      const distributionSha = 'b'.repeat(40);
      const websiteSha = 'c'.repeat(40);
      const builtInCatalog = {
        schemaVersion: 1,
        requestedUrl: 'https://models.dev/api.json',
        sourceUrl: 'https://models.dev/api.json',
        etag: '"catalog-v1"',
        lastModified: null,
        sha256: 'd'.repeat(64),
        bytes: 42,
      };
      const targets = [
        'linux-x64',
        'linux-arm64',
        'darwin-x64',
        'darwin-arm64',
        'win32-x64',
        'win32-arm64',
      ];

      for (const releaseTarget of targets) {
        const archiveName = `wukong-${releaseTarget}.zip`;
        const archivePath = join(stagingDir, archiveName);
        await writeSingleEntryZip(
          archivePath,
          releaseTarget.startsWith('win32-') ? 'wukong.exe' : 'wukong',
        );
        await writeFile(
          `${archivePath}.sha256`,
          `${sha256(await readFile(archivePath))}  ${archiveName}\n`,
        );
        await writeFile(
          join(stagingDir, `wukong-${releaseTarget}.build.json`),
          `${JSON.stringify({
            schemaVersion: 1,
            target: releaseTarget,
            version: '0.1.0-rc.1',
            sourceRepository: 'wukong-code/wukong_cli',
            sourceSha,
            profile: 'release',
            macosSignedAndNotarized: false,
            builtInCatalog,
          })}\n`,
        );
      }

      await execFileAsync(
        process.execPath,
        [
          releaseStagingScript,
          stagingDir,
          'v0.1.0-rc.1',
          sourceSha,
          outputDir,
          'false',
        ],
        {
          cwd: appRoot,
          env: {
            ...process.env,
            WUKONG_RELEASE_DISTRIBUTION_SHA: distributionSha,
            WUKONG_RELEASE_WEBSITE_SHA: websiteSha,
          },
        },
      );

      const provenance = JSON.parse(
        await readFile(join(outputDir, 'release-provenance.json'), 'utf-8'),
      ) as {
        releaseTag: string;
        builtInCatalog: typeof builtInCatalog;
        publicTruth: {
          distributionSha: string;
          websiteSha: string;
        };
        artifacts: Array<{
          build: { macosSignedAndNotarized: boolean };
        }>;
      };
      expect(provenance.releaseTag).toBe('v0.1.0-rc.1');
      expect(provenance.builtInCatalog).toEqual(builtInCatalog);
      expect(provenance.publicTruth).toMatchObject({ distributionSha, websiteSha });
      expect(provenance.artifacts).toHaveLength(6);
      expect(
        provenance.artifacts.every(
          (artifact) => !artifact.build.macosSignedAndNotarized,
        ),
      ).toBe(true);

      const wrongRepositoryMetadataPath = join(stagingDir, 'wukong-linux-x64.build.json');
      const wrongRepositoryMetadata = JSON.parse(
        await readFile(wrongRepositoryMetadataPath, 'utf-8'),
      ) as Record<string, unknown>;
      wrongRepositoryMetadata['sourceRepository'] = 'attacker/fork';
      await writeFile(
        wrongRepositoryMetadataPath,
        `${JSON.stringify(wrongRepositoryMetadata)}\n`,
      );
      await expect(
        execFileAsync(
          process.execPath,
          [
            releaseStagingScript,
            stagingDir,
            'v0.1.0-rc.1',
            sourceSha,
            outputDir,
            'false',
          ],
          {
            cwd: appRoot,
            env: {
              ...process.env,
              WUKONG_RELEASE_DISTRIBUTION_SHA: distributionSha,
              WUKONG_RELEASE_WEBSITE_SHA: websiteSha,
            },
          },
        ),
      ).rejects.toThrow(/Build metadata does not match the release contract/u);
    },
  );
});
