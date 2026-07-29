import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const READ_CHUNK_BYTES = 64 * 1024;

interface KoffiLibrary {
  func(definition: string): (...args: readonly unknown[]) => unknown;
}

interface KoffiModule {
  load(path: string | null): KoffiLibrary;
  errno(value?: number): number;
}

interface PosixFunctions {
  readonly open: (
    path: string,
    flags: number,
    mode: number,
  ) => number;
  readonly openat: (
    directoryFd: number,
    path: string,
    flags: number,
    mode: number,
  ) => number;
}

interface PosixOpenFlags {
  readonly O_RDONLY: number;
  readonly O_NONBLOCK: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
}

export interface ReviewSubjectFileBackendCapability {
  readonly supported: boolean;
  readonly reasonCode: 'available' | 'review_subject_backend_unavailable';
}

export class ReviewSubjectFileReadError extends Error {
  constructor(
    readonly reason:
      | 'unsafe-path'
      | 'changed'
      | 'oversize'
      | 'backend-unavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ReviewSubjectFileReadError';
  }
}

export interface ReviewSubjectReadTestHooks {
  readonly beforeDescriptorRead?: () => void | Promise<void>;
  readonly observeDescriptorBytes?: (bytes: Buffer) => void | Promise<void>;
}

export function reviewSubjectFileBackendCapability(
  platform: NodeJS.Platform = process.platform,
): ReviewSubjectFileBackendCapability {
  if (platform !== 'darwin' && platform !== 'linux') {
    return {
      supported: false,
      reasonCode: 'review_subject_backend_unavailable',
    };
  }
  try {
    loadPosixOpenFlags();
    loadPosixFunctions();
    return { supported: true, reasonCode: 'available' };
  } catch {
    return {
      supported: false,
      reasonCode: 'review_subject_backend_unavailable',
    };
  }
}

/**
 * Reads a bounded regular file through a descriptor rooted at the canonical
 * workspace directory. Every component is opened with openat(2) and
 * O_NOFOLLOW, so replacing an ancestor or the leaf with a symlink cannot turn
 * a previously checked path into an out-of-workspace content read.
 *
 * The test hooks are intentionally private to this non-exported module. They
 * let the regression suite perform a real rename/symlink replacement while
 * the safe file descriptor is held.
 */
export async function readReviewSubjectFileSecurely(
  workspaceRoot: string,
  logicalPath: string,
  maxBytes: number,
  testHooks: ReviewSubjectReadTestHooks = {},
): Promise<Buffer> {
  assertCanonicalLogicalPath(logicalPath);
  const capability = reviewSubjectFileBackendCapability();
  if (!capability.supported) {
    throw new ReviewSubjectFileReadError(
      'backend-unavailable',
      'Review subject file reads require the local POSIX openat backend.',
    );
  }

  const canonicalRoot = realpathSync(resolve(workspaceRoot));
  const native = loadPosixFunctions();
  const openFlags = loadPosixOpenFlags();
  const rootFd = checkedOpen(
    'workspace root',
    native.open(
      canonicalRoot,
      openFlags.O_RDONLY
        | openFlags.O_DIRECTORY
        | openFlags.O_NOFOLLOW
        | openFlags.O_CLOEXEC,
      0,
    ),
  );

  try {
    const rootBefore = checkedDirectory(rootFd, 'workspace root');
    assertRootPathIdentity(canonicalRoot, rootBefore);
    const fileFd = openLogicalPath(native, openFlags, rootFd, logicalPath);
    try {
      const before = checkedRegularFile(fileFd);
      if (before.size > BigInt(maxBytes)) {
        throw new ReviewSubjectFileReadError(
          'oversize',
          'Review subject file exceeds the frozen per-file limit.',
        );
      }
      await testHooks.beforeDescriptorRead?.();
      const bytes = readBounded(fileFd, maxBytes);
      await testHooks.observeDescriptorBytes?.(bytes);
      const after = checkedRegularFile(fileFd);
      if (
        bytes.byteLength !== Number(after.size)
        || !sameFileVersion(before, after)
      ) {
        throw new ReviewSubjectFileReadError(
          'changed',
          'Review subject file changed while its descriptor was being read.',
        );
      }

      const currentFd = openLogicalPath(
        native,
        openFlags,
        rootFd,
        logicalPath,
      );
      try {
        const current = checkedRegularFile(currentFd);
        if (!sameFileVersion(after, current)) {
          throw new ReviewSubjectFileReadError(
            'changed',
            'Review subject path identity changed while it was being read.',
          );
        }
      } catch (error) {
        throw new ReviewSubjectFileReadError(
          'changed',
          'Review subject path could not be revalidated after reading.',
          { cause: error },
        );
      } finally {
        closeSync(currentFd);
      }

      const rootAfter = checkedDirectory(rootFd, 'workspace root');
      if (!sameNodeIdentity(rootBefore, rootAfter)) {
        throw new ReviewSubjectFileReadError(
          'changed',
          'Review subject workspace identity changed while reading.',
        );
      }
      assertRootPathIdentity(canonicalRoot, rootAfter);
      return bytes;
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

function loadPosixFunctions(): PosixFunctions {
  try {
    const koffi = require('koffi') as KoffiModule;
    const libc = koffi.load(null);
    const numberFunction = (
      definition: string,
    ): ((...args: readonly unknown[]) => number) => {
      const fn = libc.func(definition);
      return (...args) => Number(fn(...args));
    };
    return {
      open: numberFunction(
        'int open(const char *pathname, int flags, unsigned int mode)',
      ) as PosixFunctions['open'],
      openat: numberFunction(
        'int openat(int dirfd, const char *pathname, int flags, unsigned int mode)',
      ) as PosixFunctions['openat'],
    };
  } catch (error) {
    throw new ReviewSubjectFileReadError(
      'backend-unavailable',
      'Review subject file reads require the local POSIX openat backend.',
      { cause: error },
    );
  }
}

function openLogicalPath(
  native: PosixFunctions,
  openFlags: PosixOpenFlags,
  rootFd: number,
  logicalPath: string,
): number {
  const segments = logicalPath.split('/');
  let directoryFd = rootFd;
  let ownsDirectoryFd = false;
  try {
    for (const segment of segments.slice(0, -1)) {
      const next = checkedOpen(
        'path component',
        native.openat(
          directoryFd,
          segment,
          openFlags.O_RDONLY
            | openFlags.O_DIRECTORY
            | openFlags.O_NOFOLLOW
            | openFlags.O_CLOEXEC,
          0,
        ),
      );
      try {
        checkedDirectory(next, 'path component');
      } catch (error) {
        closeSync(next);
        throw error;
      }
      if (ownsDirectoryFd) closeSync(directoryFd);
      directoryFd = next;
      ownsDirectoryFd = true;
    }
    return checkedOpen(
      'review subject file',
      native.openat(
        directoryFd,
        segments.at(-1)!,
        openFlags.O_RDONLY
          | openFlags.O_NONBLOCK
          | openFlags.O_NOFOLLOW
          | openFlags.O_CLOEXEC,
        0,
      ),
    );
  } catch (error) {
    if (error instanceof ReviewSubjectFileReadError) throw error;
    throw new ReviewSubjectFileReadError(
      'unsafe-path',
      'Review subject path is missing, linked, or not a regular workspace file.',
      { cause: error },
    );
  } finally {
    if (ownsDirectoryFd) closeSync(directoryFd);
  }
}

function checkedOpen(
  label: string,
  fd: number,
): number {
  if (fd >= 0) return fd;
  let errno: number | undefined;
  try {
    const koffi = require('koffi') as KoffiModule;
    errno = koffi.errno();
  } catch {
    // The stable public reason does not depend on a platform errno string.
  }
  throw new ReviewSubjectFileReadError(
    'unsafe-path',
    `${label} could not be opened safely${errno === undefined ? '' : ` (errno ${errno})`}.`,
  );
}

function checkedDirectory(fd: number, label: string): BigIntStats {
  const info = fstatSync(fd, { bigint: true });
  if (!info.isDirectory()) {
    throw new ReviewSubjectFileReadError(
      'unsafe-path',
      `${label} is not a directory.`,
    );
  }
  return info;
}

function checkedRegularFile(fd: number): BigIntStats {
  const info = fstatSync(fd, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) {
    throw new ReviewSubjectFileReadError(
      'unsafe-path',
      'Review subject descriptor is not a single-link regular file.',
    );
  }
  return info;
}

function assertRootPathIdentity(
  canonicalRoot: string,
  expected: BigIntStats,
): void {
  let current: BigIntStats;
  try {
    current = statSync(canonicalRoot, { bigint: true });
  } catch (error) {
    throw new ReviewSubjectFileReadError(
      'changed',
      'Review subject workspace path could not be revalidated.',
      { cause: error },
    );
  }
  if (!current.isDirectory() || !sameNodeIdentity(expected, current)) {
    throw new ReviewSubjectFileReadError(
      'changed',
      'Review subject workspace path identity changed.',
    );
  }
}

function readBounded(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total),
    );
    const count = readSync(fd, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > maxBytes) {
    throw new ReviewSubjectFileReadError(
      'oversize',
      'Review subject file exceeds the frozen per-file limit.',
    );
  }
  return Buffer.concat(chunks, total);
}

function sameNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameNodeIdentity(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function loadPosixOpenFlags(): PosixOpenFlags {
  const values = fsConstants as unknown as Readonly<Record<string, unknown>>;
  const required = [
    'O_RDONLY',
    'O_NONBLOCK',
    'O_DIRECTORY',
    'O_NOFOLLOW',
  ] as const;
  for (const name of required) {
    if (!Number.isInteger(values[name])) {
      throw new ReviewSubjectFileReadError(
        'backend-unavailable',
        `The runtime does not expose the required POSIX ${name} flag.`,
      );
    }
  }
  return {
    O_RDONLY: values['O_RDONLY'] as number,
    O_NONBLOCK: values['O_NONBLOCK'] as number,
    O_DIRECTORY: values['O_DIRECTORY'] as number,
    O_NOFOLLOW: values['O_NOFOLLOW'] as number,
    O_CLOEXEC: Number.isInteger(values['O_CLOEXEC'])
      ? values['O_CLOEXEC'] as number
      : 0,
  };
}

function assertCanonicalLogicalPath(logicalPath: string): void {
  const segments = logicalPath.split('/');
  if (
    logicalPath === ''
    || logicalPath.includes('\\')
    || isAbsolute(logicalPath)
    || segments.some((segment) =>
      segment === '' || segment === '.' || segment === '..')
    || /[\u0000-\u001F\u007F]/u.test(logicalPath)
  ) {
    throw new ReviewSubjectFileReadError(
      'unsafe-path',
      'Review subject path must be canonical and workspace-relative.',
    );
  }
}
