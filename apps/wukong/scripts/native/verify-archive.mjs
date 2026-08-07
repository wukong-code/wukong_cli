import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyArchiveChecksum(archivePath, checksumPath) {
  const resolvedArchive = resolve(archivePath);
  const archiveName = basename(resolvedArchive);
  const [archiveBytes, checksumText] = await Promise.all([
    readFile(resolvedArchive),
    readFile(resolve(checksumPath), 'utf8'),
  ]);
  const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  const match = checksumText.match(/^([a-f0-9]{64})\s+([^\s]+)\s*$/u);
  if (match?.[1] !== actualSha256 || match[2] !== archiveName) {
    throw new Error(`Checksum file does not exactly match ${archiveName}`);
  }
  return { archiveName, sha256: actualSha256 };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archivePath, checksumPath] = process.argv.slice(2);
  if (archivePath === undefined || checksumPath === undefined) {
    console.error('Usage: verify-archive.mjs <archive.zip> <archive.zip.sha256>');
    process.exit(1);
  }
  const verified = await verifyArchiveChecksum(archivePath, checksumPath);
  console.log(`Verified SHA-256 ${verified.sha256} for ${verified.archiveName}`);
}
