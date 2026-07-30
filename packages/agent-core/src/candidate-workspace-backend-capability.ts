import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type CandidateWorkspaceBackendPlatform =
  | 'darwin'
  | 'linux'
  | 'win32';

export type CandidateWorkspaceBackendUnavailableReason =
  | 'candidate_atomic_backend_platform_unsupported'
  | 'candidate_atomic_backend_native_unavailable';

export type CandidateWorkspaceBackendCapabilityV1 =
  | Readonly<{
      available: true;
      platform: CandidateWorkspaceBackendPlatform;
      backend: 'posix-openat-v1';
      reasonCode: null;
    }>
  | Readonly<{
      available: false;
      platform: NodeJS.Platform;
      backend: null;
      reasonCode: CandidateWorkspaceBackendUnavailableReason;
    }>;

export interface CandidateWorkspaceBackendProbeDependencies {
  readonly platform?: NodeJS.Platform;
  /**
   * Controlled test injection. Product callers resolve the already-packaged
   * Koffi runtime and the exact descriptor-relative syscall set.
   */
  readonly resolveNative?: () => void;
}

interface KoffiLibrary {
  func(definition: string): (...args: readonly unknown[]) => unknown;
}

interface KoffiModule {
  load(path: string | null): KoffiLibrary;
  errno(value?: number): number;
  struct(
    definition: Readonly<Record<string, unknown>>,
  ): unknown;
  array(type: string, length: number, hint?: string): unknown;
  decode(value: unknown, type: unknown): unknown;
  readonly os: {
    readonly errno: Readonly<Record<string, number>>;
  };
}

/**
 * Checks the exact local primitive set required before isolated Loop state is
 * persisted. This does not claim a sandbox; it only proves that Candidate
 * pathname I/O can be rooted in directory descriptors and fail closed.
 */
export function inspectCandidateWorkspaceBackendCapability(
  dependencies: CandidateWorkspaceBackendProbeDependencies = {},
): CandidateWorkspaceBackendCapabilityV1 {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return Object.freeze({
      available: false,
      platform,
      backend: null,
      reasonCode: 'candidate_atomic_backend_platform_unsupported',
    });
  }
  try {
    (
      dependencies.resolveNative
      ?? (() => {
        resolvePosixNative(platform);
      })
    )();
    return Object.freeze({
      available: true,
      platform,
      backend: 'posix-openat-v1',
      reasonCode: null,
    });
  } catch {
    return Object.freeze({
      available: false,
      platform,
      backend: null,
      reasonCode: 'candidate_atomic_backend_native_unavailable',
    });
  }
}

function resolvePosixNative(
  platform: CandidateWorkspaceBackendPlatform,
): void {
  if (!Number.isInteger(fsConstants.O_DIRECTORY)
    || !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new TypeError(
      'The runtime does not expose directory/no-follow open flags.',
    );
  }
  const koffi = require('koffi') as KoffiModule;
  const libc = koffi.load(null);
  for (const definition of [
    'int open(const char *pathname, int flags, unsigned int mode)',
    'int openat(int dirfd, const char *pathname, int flags, unsigned int mode)',
    'int mkdirat(int dirfd, const char *pathname, unsigned int mode)',
    'int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath)',
    'int unlinkat(int dirfd, const char *pathname, int flags)',
    'int dup(int fd)',
    'void *fdopendir(int fd)',
    'void *readdir(void *dirp)',
    'int closedir(void *dirp)',
  ]) {
    if (typeof libc.func(definition) !== 'function') {
      throw new TypeError(
        'A required descriptor-relative syscall is missing.',
      );
    }
  }
  if (typeof koffi.errno !== 'function'
    || typeof koffi.decode !== 'function'
    || Object.keys(koffi.os.errno).length === 0) {
    throw new TypeError('Native errno metadata is unavailable.');
  }
  const name = koffi.array(
    'char',
    platform === 'darwin' ? 1024 : 256,
    'String',
  );
  koffi.struct(platform === 'darwin'
    ? {
        d_ino: 'uint64_t',
        d_seekoff: 'uint64_t',
        d_reclen: 'uint16_t',
        d_namlen: 'uint16_t',
        d_type: 'uint8_t',
        d_name: name,
      }
    : {
        d_ino: 'uint64_t',
        d_off: 'int64_t',
        d_reclen: 'uint16_t',
        d_type: 'uint8_t',
        d_name: name,
      });
}
