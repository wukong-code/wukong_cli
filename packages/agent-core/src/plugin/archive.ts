import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

export const MAX_PLUGIN_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_ENTRIES = 10_000;
export const MAX_PLUGIN_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_EXTRACTED_BYTES = 256 * 1024 * 1024;
export const MAX_PLUGIN_COMPRESSION_RATIO = 200;

export async function downloadZip(url: string, signal?: AbortSignal): Promise<Buffer> {
  const request = parseDownloadRequest(url);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, 5 * 60 * 1000);
  try {
    const requestSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    const resp = await fetch(request.url, { signal: requestSignal });
    if (!resp.ok) {
      throw new Error(`Failed to download zip: HTTP ${resp.status} ${resp.statusText}`);
    }
    validateFinalDownloadUrl(request.url, resp.url);
    const contentLength = resp.headers.get('content-length');
    if (contentLength !== null && /^\d+$/u.test(contentLength)) {
      const declaredBytes = Number(contentLength);
      if (declaredBytes > MAX_PLUGIN_DOWNLOAD_BYTES) {
        throw new Error(
          `Plugin archive is too large: ${String(declaredBytes)} bytes exceeds the ` +
          `${String(MAX_PLUGIN_DOWNLOAD_BYTES)} byte download limit`,
        );
      }
    }
    const buffer = await readResponseWithLimit(resp);
    if (request.expectedSha256 !== undefined) {
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== request.expectedSha256) {
        throw new Error(
          `Plugin archive SHA-256 mismatch: expected ${request.expectedSha256}, got ${actual}`,
        );
      }
    }
    return buffer;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function parseDownloadRequest(rawUrl: string): {
  readonly url: string;
  readonly expectedSha256?: string;
} {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw new Error('Plugin archive URLs must use HTTPS (HTTP is allowed only for loopback development).');
  }
  const expectedSha256 = new URLSearchParams(parsed.hash.slice(1)).get('sha256') ?? undefined;
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new Error('Plugin archive sha256 fragment must be 64 lowercase hexadecimal characters.');
  }
  parsed.hash = '';
  return { url: parsed.href, expectedSha256 };
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
}

function validateFinalDownloadUrl(requestedUrl: string, responseUrl: string): void {
  if (responseUrl.length === 0) return;
  const requested = new URL(requestedUrl);
  const final = new URL(responseUrl);
  if (final.protocol !== 'https:' && !(final.protocol === 'http:' && isLoopback(final.hostname))) {
    throw new Error(`Plugin archive redirected to an insecure URL: ${final.href}`);
  }
  const sameHost = requested.hostname === final.hostname;
  const githubArchiveRedirect =
    (requested.hostname === 'github.com' || requested.hostname === 'www.github.com') &&
    final.hostname === 'codeload.github.com';
  if (!sameHost && !githubArchiveRedirect) {
    throw new Error(
      `Plugin archive redirected to an untrusted host: ${requested.hostname} -> ${final.hostname}`,
    );
  }
}

async function readResponseWithLimit(resp: Response): Promise<Buffer> {
  if (resp.body === null) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_PLUGIN_DOWNLOAD_BYTES) {
        await reader.cancel('plugin archive exceeds download limit');
        throw new Error(
          `Plugin archive exceeds the ${String(MAX_PLUGIN_DOWNLOAD_BYTES)} byte download limit`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function extractZip(buffer: Buffer, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const destDirResolved = path.resolve(destDir);
  let settled = false;
  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    yauzlFromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(new Error(`Failed to open zip: ${openErr?.message ?? 'unknown error'}`));
        return;
      }
      if (zipfile.entryCount > MAX_PLUGIN_ARCHIVE_ENTRIES) {
        settled = true;
        reject(new Error(
          `Plugin archive has too many entries: ${String(zipfile.entryCount)} exceeds ` +
          String(MAX_PLUGIN_ARCHIVE_ENTRIES),
        ));
        zipfile.close();
        return;
      }

      const onEntry = (entry: Entry): void => {
        const fileName = entry.fileName;
        const destPath = path.resolve(destDir, fileName);

        try {
          declaredTotalBytes = validateArchiveEntry(entry, declaredTotalBytes);
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          zipfile.close();
          return;
        }

        if (destPath !== destDirResolved && !destPath.startsWith(destDirResolved + path.sep)) {
          if (!settled) {
            settled = true;
            reject(new Error(`Path traversal detected in zip entry: ${fileName}`));
          }
          zipfile.close();
          return;
        }

        if (fileName.endsWith('/')) {
          mkdir(destPath, { recursive: true })
            .then(() => {
              zipfile.readEntry();
            })
            .catch((error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
              zipfile.close();
            });
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null || stream === undefined) {
            if (!settled) {
              settled = true;
              reject(
                new Error(
                  `Failed to read ${fileName} from archive: ${streamErr?.message ?? 'unknown error'}`,
                ),
              );
            }
            zipfile.close();
            return;
          }

          mkdir(path.dirname(destPath), { recursive: true })
            .then(() => pipeline(
              stream,
              createExtractionLimitTransform((chunkBytes) => {
                actualTotalBytes += chunkBytes;
                return actualTotalBytes;
              }),
              createWriteStream(destPath),
            ))
            .then(() => restoreFilePermissions(destPath, entry))
            .then(() => {
              zipfile.readEntry();
            })
            .catch((error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
              zipfile.close();
            });
        });
      };

      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zipfile.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      zipfile.readEntry();
    });
  });

  return detectPluginRoot(destDir);
}

function createExtractionLimitTransform(addExtractedBytes: (chunkBytes: number) => number): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      const extractedBytes = addExtractedBytes(chunk.byteLength);
      if (extractedBytes > MAX_PLUGIN_EXTRACTED_BYTES) {
        callback(new Error(
          `Plugin archive exceeds the ${String(MAX_PLUGIN_EXTRACTED_BYTES)} byte extraction limit`,
        ));
        return;
      }
      callback(null, chunk);
    },
  });
}

function validateArchiveEntry(entry: Entry, currentTotalBytes: number): number {
  if (entry.uncompressedSize > MAX_PLUGIN_ENTRY_BYTES) {
    throw new Error(
      `Plugin archive entry ${entry.fileName} exceeds the ` +
      `${String(MAX_PLUGIN_ENTRY_BYTES)} byte per-file limit`,
    );
  }
  const nextTotalBytes = currentTotalBytes + entry.uncompressedSize;
  if (nextTotalBytes > MAX_PLUGIN_EXTRACTED_BYTES) {
    throw new Error(
      `Plugin archive exceeds the ${String(MAX_PLUGIN_EXTRACTED_BYTES)} byte extraction limit`,
    );
  }
  if (entry.uncompressedSize > 1024 * 1024) {
    const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
    if (ratio > MAX_PLUGIN_COMPRESSION_RATIO) {
      throw new Error(
        `Plugin archive entry ${entry.fileName} has a suspicious compression ratio ` +
        `(${ratio.toFixed(1)}:1)`,
      );
    }
  }
  return nextTotalBytes;
}

async function restoreFilePermissions(destPath: string, entry: Entry): Promise<void> {
  const mode = entry.externalFileAttributes >>> 16;
  if (mode === 0) return;
  const permissions = mode & 0o777;
  if (permissions === 0) return;
  await chmod(destPath, permissions);
}

async function detectPluginRoot(dir: string): Promise<string> {
  if (await hasManifest(dir)) return dir;

  const entries = await readdir(dir, { withFileTypes: true });
  const childDirs = entries.filter((entry) => entry.isDirectory());
  const childDir = childDirs.length === 1 ? childDirs[0] : undefined;
  if (childDir !== undefined) {
    const child = path.join(dir, childDir.name);
    if (await hasManifest(child)) return child;
  }

  return dir;
}

async function hasManifest(dir: string): Promise<boolean> {
  const rootManifest = path.join(dir, 'wukong.plugin.json');
  const dirManifest = path.join(dir, '.wukong-plugin', 'plugin.json');
  return (await isFile(rootManifest)) || (await isFile(dirManifest));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
