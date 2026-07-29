import { randomBytes } from 'node:crypto';
import {
  closeSync as closeNodeDescriptor,
  constants as importedFsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { StatResult } from '@wukong/kaos';
import { canonicalDigest } from '@wukong/verification';

import {
  injectDurableBoundaryTestFault,
  type DurableBoundaryTestFaultCapabilityV1,
  validateDurableBoundaryTestFaultCapability,
} from '../../durable-boundary-test-fault';
import {
  buildWindowsCandidateHandleRelativeReplaceInfo,
  buildWindowsObjectAttributesLayout,
  buildWindowsUnicodeStringLayout,
  parseWindowsHandleDirectoryEntries,
} from '../../windows-handle-relative-layout';
import {
  assertExactWindowsPrivateRootSddl,
  assertWindowsPrivateRootSecurityProof,
  attestWindowsPrivateRootSecurity,
  type WindowsPrivateRootSecurityObservationV1,
} from '../../windows-private-root-security';

const require = createRequire(import.meta.url);
const candidateDescriptorClosers = new Map<number, () => void>();

function closeSync(fd: number): void {
  const close = candidateDescriptorClosers.get(fd);
  if (close === undefined) {
    closeNodeDescriptor(fd);
    return;
  }
  candidateDescriptorClosers.delete(fd);
  close();
}

const PROTECTED_SEGMENTS = new Set(['.git', '.wukong']);
const MAX_ATOMIC_FILE_BYTES = 16 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const TEMPORARY_ATTEMPTS = 32;
const MAX_SEARCH_FILES = 100_000;
const MAX_SEARCH_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = MAX_ATOMIC_FILE_BYTES;
const MAX_SEARCH_DEPTH = 128;
const MAX_PORTABLE_PATH_BYTES = 4_096;
const MAX_PORTABLE_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_CHARACTERS = /[\u0000-\u001F<>:"/\\|?*]/u;
const WINDOWS_RESERVED_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
export const CANDIDATE_WRITER_FIXED_DENIED_SEGMENTS = Object.freeze([
  'node_modules',
  '.venv',
  'target',
  'vendor',
  '.wukong-bootstrap',
]);
const GENERATED_DENIED_DIRECTORIES = new Set(
  CANDIDATE_WRITER_FIXED_DENIED_SEGMENTS,
);
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);
type TextErrors = 'strict' | 'replace' | 'ignore';

export type CandidateWorkspaceFileOperation = 'read' | 'write' | 'search';

export interface CandidateWorkspaceFileIO {
  stat(
    path: string,
    options?: { followSymlinks?: boolean },
  ): Promise<StatResult>;
  readBytes(path: string, n?: number): Promise<Buffer>;
  readText(
    path: string,
    options?: {
      encoding?: BufferEncoding;
      errors?: TextErrors;
    },
  ): Promise<string>;
  readLines(
    path: string,
    options?: {
      encoding?: BufferEncoding;
      errors?: TextErrors;
    },
  ): AsyncGenerator<string>;
  writeBytes(path: string, data: Buffer): Promise<number>;
  writeText(
    path: string,
    data: string,
    options?: {
      mode?: 'w' | 'a';
      encoding?: BufferEncoding;
    },
  ): Promise<number>;
  mkdir(
    path: string,
    options?: {
      parents?: boolean;
      existOk?: boolean;
    },
  ): Promise<void>;
  listFiles(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly includeIgnored?: boolean;
    },
  ): Promise<readonly CandidateWorkspaceFileEntry[]>;
}

export interface CandidateWorkspaceFileEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly stat: StatResult;
}

interface KoffiLibrary {
  func(definition: string): (...args: readonly unknown[]) => unknown;
}

interface KoffiModule {
  load(path: string | null): KoffiLibrary;
  errno(value?: number): number;
  struct(definition: Readonly<Record<string, unknown>>): unknown;
  array(type: string, length: number, hint?: string): unknown;
  decode(value: unknown, type: unknown): unknown;
  address(value: unknown): bigint;
  readonly os: {
    readonly errno: Readonly<Record<string, number>>;
  };
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
  readonly mkdirat: (
    directoryFd: number,
    path: string,
    mode: number,
  ) => number;
  readonly renameat: (
    oldDirectoryFd: number,
    oldPath: string,
    newDirectoryFd: number,
    newPath: string,
  ) => number;
  readonly unlinkat: (
    directoryFd: number,
    path: string,
    flags: number,
  ) => number;
  readonly dup: (fd: number) => number;
  readonly fdopendir: (fd: number) => unknown;
  readonly readdir: (directory: unknown) => unknown;
  readonly closedir: (directory: unknown) => number;
}

interface OpenedNode {
  readonly fd: number;
  info: BigIntStats;
  bytes?: Buffer;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PosixOpenConstants {
  readonly O_RDONLY: number;
  readonly O_WRONLY: number;
  readonly O_CREAT: number;
  readonly O_EXCL: number;
  readonly O_NONBLOCK: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
}

interface WindowsFunctions {
  readonly createFile: (
    path: string,
    desiredAccess: number,
    shareAccess: number,
    securityAttributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ) => unknown;
  readonly closeHandle: (handle: unknown) => number;
  readonly getLastError: () => number;
  readonly getFinalPathName: (
    handle: unknown,
    output: Buffer,
    outputCharacters: number,
    flags: number,
  ) => number;
  readonly getFileInformation: (
    handle: unknown,
    informationClass: number,
    output: Buffer,
    outputBytes: number,
  ) => number;
  readonly getFileInformationByHandle: (
    handle: unknown,
    output: Buffer,
  ) => number;
  readonly setFileInformation: (
    handle: unknown,
    informationClass: number,
    input: Buffer,
    inputBytes: number,
  ) => number;
  readonly flushFileBuffers: (handle: unknown) => number;
  readonly ntCreateFile: (
    outputHandle: unknown[],
    desiredAccess: number,
    objectAttributes: Buffer,
    ioStatusBlock: Buffer,
    allocationSize: null,
    fileAttributes: number,
    shareAccess: number,
    createDisposition: number,
    createOptions: number,
    eaBuffer: null,
    eaLength: number,
  ) => number;
  readonly rtlNtStatusToDosError: (status: number) => number;
  readonly getSecurityInfo: (
    handle: unknown,
    objectType: number,
    securityInformation: number,
    ownerSid: unknown[],
    groupSid: null,
    dacl: unknown[],
    sacl: null,
    securityDescriptor: unknown[],
  ) => number;
  readonly securityDescriptorToString: (
    securityDescriptor: unknown,
    revision: number,
    securityInformation: number,
    output: unknown[],
    outputCharacters: unknown[],
  ) => number;
  readonly openProcessToken: (
    process: unknown,
    desiredAccess: number,
    outputToken: unknown[],
  ) => number;
  readonly getCurrentProcess: () => unknown;
  readonly getTokenInformation: (
    token: unknown,
    informationClass: number,
    output: Buffer | null,
    outputBytes: number,
    requiredBytes: unknown[],
  ) => number;
  readonly sidToString: (
    sid: unknown,
    output: unknown[],
  ) => number;
  readonly localFree: (value: unknown) => unknown;
}

const WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const WINDOWS_FILE_ATTRIBUTE_NORMAL = 0x0000_0080;
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const WINDOWS_FILE_LIST_DIRECTORY = 0x0000_0001;
const WINDOWS_FILE_READ_DATA = 0x0000_0001;
const WINDOWS_FILE_WRITE_DATA = 0x0000_0002;
const WINDOWS_FILE_TRAVERSE = 0x0000_0020;
const WINDOWS_FILE_READ_ATTRIBUTES = 0x0000_0080;
const WINDOWS_DELETE = 0x0001_0000;
const WINDOWS_READ_CONTROL = 0x0002_0000;
const WINDOWS_SYNCHRONIZE = 0x0010_0000;
const WINDOWS_GENERIC_READ = 0x8000_0000;
const WINDOWS_GENERIC_WRITE = 0x4000_0000;
const WINDOWS_SHARE_ALL = 0x0000_0007;
const WINDOWS_FILE_OPEN = 1;
const WINDOWS_FILE_CREATE = 2;
const WINDOWS_OPEN_EXISTING = 3;
const WINDOWS_FILE_DIRECTORY_FILE = 0x0000_0001;
const WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT = 0x0000_0020;
const WINDOWS_FILE_NON_DIRECTORY_FILE = 0x0000_0040;
const WINDOWS_FILE_OPEN_REPARSE_POINT = 0x0020_0000;
const WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const WINDOWS_FILE_ATTRIBUTE_TAG_INFO = 9;
const WINDOWS_FILE_ID_BOTH_DIRECTORY_INFO = 10;
const WINDOWS_FILE_ID_BOTH_DIRECTORY_RESTART_INFO = 11;
const WINDOWS_FILE_RENAME_INFO = 3;
const WINDOWS_FILE_DISPOSITION_INFO = 4;
const WINDOWS_O_RDONLY = 0;
const WINDOWS_O_WRONLY = 1;
const WINDOWS_O_BINARY = 0x8000;
const WINDOWS_ERROR_NO_MORE_FILES = 18;
const WINDOWS_SE_FILE_OBJECT = 1;
const WINDOWS_OWNER_SECURITY_INFORMATION = 0x0000_0001;
const WINDOWS_DACL_SECURITY_INFORMATION = 0x0000_0004;
const WINDOWS_SDDL_REVISION_1 = 1;
const WINDOWS_TOKEN_QUERY = 0x0000_0008;
const WINDOWS_TOKEN_USER = 1;
const WINDOWS_DIRECTORY_BUFFER_BYTES = 64 * 1024;

interface SearchWalkState {
  readonly entries: CandidateWorkspaceFileEntry[];
  readonly portablePaths: Map<string, string>;
  readonly includeIgnored: boolean;
  readonly signal?: AbortSignal;
  totalBytes: number;
}

interface CandidateHandleNative {
  openRoot(rootDirectory: string, expectedRootIdentity: string): number;
  openDirectoryAt(directoryFd: number, name: string): number;
  openReadNodeAt(directoryFd: number, name: string): number;
  openExclusiveWritableFileAt(
    directoryFd: number,
    name: string,
    mode: number,
  ): number;
  mkdirAt(directoryFd: number, name: string, mode: number): void;
  renameAt(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
  ): void;
  unlinkAt(directoryFd: number, name: string): void;
  readDirectory(directoryFd: number): readonly string[];
  syncDirectory(directoryFd: number): void;
  isErrno(error: unknown, code: string): boolean;
}

export class CandidateWorkspaceFileBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CandidateWorkspaceFileBackendError';
    this.code = code;
  }
}

/**
 * Local candidate I/O is rooted in a verified directory descriptor and every
 * path component is opened relative to that descriptor with O_NOFOLLOW.
 *
 * Node's public fs API cannot express openat(2), so the already-shipped Koffi
 * native runtime is used only for the five descriptor-relative POSIX syscalls
 * below. File contents and metadata continue through Node-owned descriptors.
 * Platforms without that capability fail closed before a Candidate tool can
 * touch a pathname.
 */
export class CandidateWorkspaceFileBackend {
  private readonly rootDirectory: string;
  private readonly expectedRootIdentity: string;
  private readonly generatedPathScopes: readonly string[];
  private readonly native: CandidateHandleNative | null;
  private readonly unavailableCause: unknown;
  private readonly testFault:
    DurableBoundaryTestFaultCapabilityV1 | undefined;

  constructor(input: {
    readonly rootDirectory: string;
    readonly expectedRootIdentity: string;
    readonly generatedPathScopes?: readonly string[];
    /**
     * Process-crash test seam. Production callers must never supply this.
     */
    readonly testFault?: DurableBoundaryTestFaultCapabilityV1;
  }) {
    if (input.testFault !== undefined
      && !validateDurableBoundaryTestFaultCapability(input.testFault)) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_invalid_input',
        'The Candidate file backend test fault capability is invalid.',
      );
    }
    this.rootDirectory = resolve(input.rootDirectory);
    this.expectedRootIdentity = input.expectedRootIdentity;
    this.generatedPathScopes = Object.freeze([
      ...(input.generatedPathScopes ?? []),
    ]);
    this.testFault = input.testFault;
    let native: CandidateHandleNative | null = null;
    let unavailableCause: unknown;
    try {
      native = process.platform === 'win32'
        ? WindowsHandleNative.create()
        : PosixNative.create();
    } catch (error) {
      unavailableCause = error;
    }
    this.native = native;
    this.unavailableCause = unavailableCause;
  }

  async run<Result>(
    path: string,
    operation: CandidateWorkspaceFileOperation,
    callback: (io: CandidateWorkspaceFileIO) => Promise<Result>,
  ): Promise<Result> {
    if (this.native === null) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_backend_unavailable',
        'Candidate file I/O requires a local handle-relative backend.',
        { cause: this.unavailableCause },
      );
    }
    const relativePath = checkedRelativePath(this.rootDirectory, path);
    const rootFd = this.native.openRoot(
      this.rootDirectory,
      this.expectedRootIdentity,
    );
    const scope = new PosixCandidateWorkspaceFileIO(
      this.native,
      rootFd,
      this.rootDirectory,
      relativePath,
      operation,
      this.generatedPathScopes,
      this.testFault,
    );
    try {
      return await callback(scope);
    } finally {
      scope.close();
    }
  }
}

/**
 * Resolves the exact packaged Windows primitive set without opening or
 * mutating a path. Candidate preflight uses this before any durable state is
 * persisted.
 */
export function resolveWindowsCandidateHandleNativeCapability(): void {
  WindowsHandleNative.create();
}

class PosixNative implements CandidateHandleNative {
  private constructor(
    private readonly koffi: KoffiModule,
    private readonly functions: PosixFunctions,
    private readonly errnoNames: ReadonlyMap<number, string>,
    private readonly direntType: unknown,
    private readonly openConstants: PosixOpenConstants,
  ) {}

  static create(): PosixNative {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_backend_unsupported',
        'The POSIX openat backend is available only on macOS and Linux.',
      );
    }
    const openConstants = loadPosixOpenConstants();
    const koffi = require('koffi') as KoffiModule;
    const libc = koffi.load(null);
    const asNumber = (
      definition: string,
    ): ((...args: readonly unknown[]) => number) => {
      const fn = libc.func(definition);
      return (...args) => Number(fn(...args));
    };
    const functions: PosixFunctions = {
      open: asNumber('int open(const char *pathname, int flags, unsigned int mode)'),
      openat: asNumber(
        'int openat(int dirfd, const char *pathname, int flags, unsigned int mode)',
      ),
      mkdirat: asNumber(
        'int mkdirat(int dirfd, const char *pathname, unsigned int mode)',
      ),
      renameat: asNumber(
        'int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath)',
      ),
      unlinkat: asNumber(
        'int unlinkat(int dirfd, const char *pathname, int flags)',
      ),
      dup: asNumber('int dup(int fd)'),
      fdopendir: libc.func('void *fdopendir(int fd)') as (
        fd: number,
      ) => unknown,
      readdir: libc.func('void *readdir(void *dirp)') as (
        directory: unknown,
      ) => unknown,
      closedir: asNumber('int closedir(void *dirp)') as (
        directory: unknown,
      ) => number,
    };
    const errnoNames = new Map<number, string>();
    for (const [name, value] of Object.entries(koffi.os.errno)) {
      if (!errnoNames.has(value)) errnoNames.set(value, name);
    }
    const direntType = process.platform === 'darwin'
      ? koffi.struct({
          d_ino: 'uint64_t',
          d_seekoff: 'uint64_t',
          d_reclen: 'uint16_t',
          d_namlen: 'uint16_t',
          d_type: 'uint8_t',
          d_name: koffi.array('char', 1024, 'String'),
        })
      : koffi.struct({
          d_ino: 'uint64_t',
          d_off: 'int64_t',
          d_reclen: 'uint16_t',
          d_type: 'uint8_t',
          d_name: koffi.array('char', 256, 'String'),
        });
    return new PosixNative(
      koffi,
      functions,
      errnoNames,
      direntType,
      openConstants,
    );
  }

  openRoot(rootDirectory: string, expectedRootIdentity: string): number {
    const canonicalRoot = realpathSync(rootDirectory);
    const fd = this.checkedFd(
      'open',
      this.functions.open(
        canonicalRoot,
        this.openConstants.O_RDONLY
          | this.openConstants.O_DIRECTORY
          | this.openConstants.O_NOFOLLOW
          | this.openConstants.O_CLOEXEC,
        0,
      ),
    );
    try {
      const info = fstatSync(fd, { bigint: true });
      const actualIdentity = canonicalDigest(
        'wukong/candidate-path-identity/v1',
        {
          pathDigest: canonicalDigest(
            'wukong/private-path/v1',
            canonicalRoot,
          ),
          device: info.dev.toString(),
          inode: info.ino.toString(),
        },
      );
      if (!info.isDirectory()
        || actualIdentity !== expectedRootIdentity
        || (info.mode & 0o777n) !== 0o700n
        || (typeof process.getuid === 'function'
          && info.uid !== BigInt(process.getuid()))) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_root_identity_changed',
          'The directory descriptor does not identify the authorized candidate root.',
        );
      }
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  openDirectoryAt(directoryFd: number, name: string): number {
    const fd = this.checkedFd(
      'openat',
      this.functions.openat(
        directoryFd,
        name,
        this.openConstants.O_RDONLY
          | this.openConstants.O_DIRECTORY
          | this.openConstants.O_NOFOLLOW
          | this.openConstants.O_CLOEXEC,
        0,
      ),
    );
    const info = fstatSync(fd, { bigint: true });
    if (!info.isDirectory()) {
      closeSync(fd);
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'A candidate path component is not a directory.',
      );
    }
    return fd;
  }

  openFileAt(
    directoryFd: number,
    name: string,
    flags: number,
    mode = 0,
  ): number {
    return this.checkedFd(
      'openat',
      this.functions.openat(
        directoryFd,
        name,
        flags
          | this.openConstants.O_NOFOLLOW
          | this.openConstants.O_CLOEXEC,
        mode,
      ),
    );
  }

  openReadNodeAt(directoryFd: number, name: string): number {
    return this.openFileAt(
      directoryFd,
      name,
      this.openConstants.O_RDONLY | this.openConstants.O_NONBLOCK,
    );
  }

  openExclusiveWritableFileAt(
    directoryFd: number,
    name: string,
    mode: number,
  ): number {
    return this.openFileAt(
      directoryFd,
      name,
      this.openConstants.O_WRONLY
        | this.openConstants.O_CREAT
        | this.openConstants.O_EXCL,
      mode,
    );
  }

  mkdirAt(directoryFd: number, name: string, mode: number): void {
    this.checkedZero(
      'mkdirat',
      this.functions.mkdirat(directoryFd, name, mode),
    );
  }

  renameAt(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
  ): void {
    this.checkedZero(
      'renameat',
      this.functions.renameat(
        oldDirectoryFd,
        oldName,
        newDirectoryFd,
        newName,
      ),
    );
  }

  unlinkAt(directoryFd: number, name: string): void {
    this.checkedZero(
      'unlinkat',
      this.functions.unlinkat(directoryFd, name, 0),
    );
  }

  readDirectory(directoryFd: number): readonly string[] {
    const duplicate = this.checkedFd(
      'dup',
      this.functions.dup(directoryFd),
    );
    let directory: unknown;
    try {
      directory = this.functions.fdopendir(duplicate);
      if (directory === null || directory === undefined) {
        throw this.error('fdopendir');
      }
    } catch (error) {
      closeSync(duplicate);
      throw error;
    }
    const names: string[] = [];
    let readError: unknown;
    try {
      while (true) {
        this.koffi.errno(0);
        const entry = this.functions.readdir(directory);
        if (entry === null || entry === undefined) {
          const errno = this.koffi.errno();
          if (errno !== 0) readError = this.error('readdir');
          break;
        }
        const decoded = this.koffi.decode(
          entry,
          this.direntType,
        ) as { readonly d_name?: unknown };
        const name = decoded.d_name;
        if (typeof name !== 'string'
          || name.includes('\0')
          || name.includes('/')
          || name === '') {
          readError = new CandidateWorkspaceFileBackendError(
            'candidate_atomic_directory_unsafe',
            'The candidate directory contains an invalid entry name.',
          );
          break;
        }
        if (name !== '.' && name !== '..') names.push(name);
      }
    } catch (error) {
      readError = error;
    }
    let closeError: unknown;
    try {
      this.checkedZero(
        'closedir',
        this.functions.closedir(directory),
      );
    } catch (error) {
      closeError = error;
    }
    if (readError !== undefined) throw toError(readError);
    if (closeError !== undefined) throw toError(closeError);
    return names.toSorted(comparePortableNames);
  }

  syncDirectory(directoryFd: number): void {
    fsyncSync(directoryFd);
  }

  isErrno(error: unknown, code: string): boolean {
    return error instanceof Error
      && 'code' in error
      && error.code === code;
  }

  private checkedFd(syscall: string, result: number): number {
    if (result >= 0) return result;
    throw this.error(syscall);
  }

  private checkedZero(syscall: string, result: number): void {
    if (result === 0) return;
    throw this.error(syscall);
  }

  private error(syscall: string): NodeJS.ErrnoException {
    const errno = this.koffi.errno();
    const code = this.errnoNames.get(errno) ?? `ERRNO_${String(errno)}`;
    return Object.assign(
      new Error(`${syscall} failed with ${code}.`),
      { code, errno, syscall },
    );
  }
}

class WindowsHandleNative implements CandidateHandleNative {
  private readonly rawHandles = new Map<number, bigint>();

  private constructor(
    private readonly koffi: KoffiModule,
    private readonly functions: WindowsFunctions,
  ) {}

  static create(): WindowsHandleNative {
    if (process.platform !== 'win32') {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_backend_unsupported',
        'The Windows handle-relative backend is available only on Windows.',
      );
    }
    const koffi = require('koffi') as KoffiModule;
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    const advapi32 = koffi.load('advapi32.dll');
    const functions: WindowsFunctions = {
      createFile: kernel32.func(
        'void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)',
      ) as WindowsFunctions['createFile'],
      closeHandle: kernel32.func(
        'int __stdcall CloseHandle(void *)',
      ) as WindowsFunctions['closeHandle'],
      getLastError: kernel32.func(
        'uint32_t __stdcall GetLastError()',
      ) as WindowsFunctions['getLastError'],
      getFinalPathName: kernel32.func(
        'uint32_t __stdcall GetFinalPathNameByHandleW(void *, uint16_t *, uint32_t, uint32_t)',
      ) as WindowsFunctions['getFinalPathName'],
      getFileInformation: kernel32.func(
        'int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)',
      ) as WindowsFunctions['getFileInformation'],
      getFileInformationByHandle: kernel32.func(
        'int __stdcall GetFileInformationByHandle(void *, void *)',
      ) as WindowsFunctions['getFileInformationByHandle'],
      setFileInformation: kernel32.func(
        'int __stdcall SetFileInformationByHandle(void *, int, void *, uint32_t)',
      ) as WindowsFunctions['setFileInformation'],
      flushFileBuffers: kernel32.func(
        'int __stdcall FlushFileBuffers(void *)',
      ) as WindowsFunctions['flushFileBuffers'],
      ntCreateFile: ntdll.func(
        'int32_t __stdcall NtCreateFile(_Out_ void **, uint32_t, const void *, void *, const int64_t *, uint32_t, uint32_t, uint32_t, uint32_t, void *, uint32_t)',
      ) as WindowsFunctions['ntCreateFile'],
      rtlNtStatusToDosError: ntdll.func(
        'uint32_t __stdcall RtlNtStatusToDosError(uint32_t)',
      ) as WindowsFunctions['rtlNtStatusToDosError'],
      getSecurityInfo: advapi32.func(
        'uint32_t __stdcall GetSecurityInfo(void *, uint32_t, uint32_t, _Out_ void **, void **, _Out_ void **, void **, _Out_ void **)',
      ) as WindowsFunctions['getSecurityInfo'],
      securityDescriptorToString: advapi32.func(
        'int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *, uint32_t, uint32_t, _Out_ void **, _Out_ uint32_t *)',
      ) as WindowsFunctions['securityDescriptorToString'],
      openProcessToken: advapi32.func(
        'int __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)',
      ) as WindowsFunctions['openProcessToken'],
      getCurrentProcess: kernel32.func(
        'void * __stdcall GetCurrentProcess()',
      ) as WindowsFunctions['getCurrentProcess'],
      getTokenInformation: advapi32.func(
        'int __stdcall GetTokenInformation(void *, uint32_t, void *, uint32_t, _Out_ uint32_t *)',
      ) as WindowsFunctions['getTokenInformation'],
      sidToString: advapi32.func(
        'int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)',
      ) as WindowsFunctions['sidToString'],
      localFree: kernel32.func(
        'void * __stdcall LocalFree(void *)',
      ) as WindowsFunctions['localFree'],
    };
    for (const [name, fn] of Object.entries(functions)) {
      if (typeof fn !== 'function') {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_backend_unavailable',
          `The required Windows handle function ${name} is unavailable.`,
        );
      }
    }
    return new WindowsHandleNative(koffi, functions);
  }

  openRoot(
    rootDirectory: string,
    expectedRootIdentity: string,
  ): number {
    const canonicalRoot = realpathSync(rootDirectory);
    let handle: unknown = this.functions.createFile(
      canonicalRoot,
      WINDOWS_GENERIC_READ
        | WINDOWS_GENERIC_WRITE
        | WINDOWS_READ_CONTROL
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_SHARE_ALL,
      null,
      WINDOWS_OPEN_EXISTING,
      WINDOWS_FILE_FLAG_BACKUP_SEMANTICS
        | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
      null,
    );
    if (isInvalidWindowsHandle(this.koffi, handle)) {
      throw this.win32Error(
        'CreateFileW',
        this.functions.getLastError(),
      );
    }
    let fd: number | null = null;
    try {
      const attributes = this.queryAttributes(handle);
      const finalPath = this.finalPath(handle);
      const finalPathMatches =
        normalizeWindowsPath(finalPath)
          === normalizeWindowsPath(canonicalRoot);
      if ((attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) === 0
        || (attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0
        || !finalPathMatches) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_root_identity_changed',
          'The Windows root handle resolved to an unsafe or different directory.',
        );
      }
      const observation = this.privateRootObservation(
        handle,
      );
      const proof = attestWindowsPrivateRootSecurity(
        canonicalRoot,
        observation,
      );
      assertWindowsPrivateRootSecurityProof(proof, canonicalRoot);
      fd = this.bindNodeDescriptor(
        handle,
        WINDOWS_O_RDONLY | WINDOWS_O_BINARY,
      );
      handle = null;
      const info = fstatSync(fd, { bigint: true });
      const actualIdentity = canonicalDigest(
        'wukong/candidate-path-identity/v1',
        {
          pathDigest: canonicalDigest(
            'wukong/private-path/v1',
            canonicalRoot,
          ),
          device: info.dev.toString(),
          inode: info.ino.toString(),
        },
      );
      if (!info.isDirectory()
        || actualIdentity !== expectedRootIdentity) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_root_identity_changed',
          'The Windows directory handle does not identify the authorized candidate root.',
        );
      }
      return fd;
    } catch (error) {
      if (fd !== null) {
        closeSync(fd);
      } else if (!isInvalidWindowsHandle(this.koffi, handle)) {
        this.functions.closeHandle(handle);
      }
      throw error;
    }
  }

  openDirectoryAt(directoryFd: number, name: string): number {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_FILE_LIST_DIRECTORY
        | WINDOWS_FILE_WRITE_DATA
        | WINDOWS_FILE_TRAVERSE
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_OPEN,
      WINDOWS_FILE_DIRECTORY_FILE
        | WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
      { allowSelf: name === '.' },
    );
    try {
      const attributes = this.queryAttributes(handle);
      if ((attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) === 0
        || (attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_path_unsafe',
          'A Windows candidate path component is not a non-reparse directory.',
        );
      }
      return this.bindNodeDescriptor(
        handle,
        WINDOWS_O_RDONLY | WINDOWS_O_BINARY,
      );
    } catch (error) {
      this.functions.closeHandle(handle);
      throw error;
    }
  }

  openReadNodeAt(directoryFd: number, name: string): number {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_FILE_READ_DATA
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_OPEN,
      WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
      if ((this.queryAttributes(handle)
          & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_path_unsafe',
          'A Windows candidate path resolved to a reparse point.',
        );
      }
      return this.bindNodeDescriptor(
        handle,
        WINDOWS_O_RDONLY | WINDOWS_O_BINARY,
      );
    } catch (error) {
      this.functions.closeHandle(handle);
      throw error;
    }
  }

  openExclusiveWritableFileAt(
    directoryFd: number,
    name: string,
    _mode: number,
  ): number {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_FILE_WRITE_DATA
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_CREATE,
      WINDOWS_FILE_NON_DIRECTORY_FILE
        | WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
      if ((this.queryAttributes(handle)
          & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_path_unsafe',
          'A Windows candidate temporary is a reparse point.',
        );
      }
      return this.bindNodeDescriptor(
        handle,
        WINDOWS_O_WRONLY | WINDOWS_O_BINARY,
      );
    } catch (error) {
      this.functions.closeHandle(handle);
      throw error;
    }
  }

  mkdirAt(directoryFd: number, name: string, _mode: number): void {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_FILE_LIST_DIRECTORY
        | WINDOWS_FILE_WRITE_DATA
        | WINDOWS_FILE_TRAVERSE
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_CREATE,
      WINDOWS_FILE_DIRECTORY_FILE
        | WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
      if (this.functions.flushFileBuffers(handle) === 0) {
        throw this.win32Error(
          'FlushFileBuffers',
          this.functions.getLastError(),
        );
      }
    } finally {
      this.functions.closeHandle(handle);
    }
  }

  renameAt(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
  ): void {
    const handle = this.openRelativeHandle(
      oldDirectoryFd,
      oldName,
      WINDOWS_DELETE
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_OPEN,
      WINDOWS_FILE_NON_DIRECTORY_FILE
        | WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
      if ((this.queryAttributes(handle)
          & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_path_unsafe',
          'A Windows candidate rename source is a reparse point.',
        );
      }
      const renameInfo =
        buildWindowsCandidateHandleRelativeReplaceInfo(
          this.rawHandleAddress(newDirectoryFd),
          newName,
        );
      if (this.functions.setFileInformation(
        handle,
        WINDOWS_FILE_RENAME_INFO,
        renameInfo,
        renameInfo.byteLength,
      ) === 0) {
        throw this.win32Error(
          'SetFileInformationByHandle(FileRenameInfo)',
          this.functions.getLastError(),
        );
      }
    } finally {
      this.functions.closeHandle(handle);
    }
  }

  unlinkAt(directoryFd: number, name: string): void {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_DELETE
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_OPEN,
      WINDOWS_FILE_NON_DIRECTORY_FILE
        | WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
      if ((this.queryAttributes(handle)
          & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_path_unsafe',
          'A Windows candidate unlink target is a reparse point.',
        );
      }
      const disposition = Buffer.from([1]);
      if (this.functions.setFileInformation(
        handle,
        WINDOWS_FILE_DISPOSITION_INFO,
        disposition,
        disposition.byteLength,
      ) === 0) {
        throw this.win32Error(
          'SetFileInformationByHandle(FileDispositionInfo)',
          this.functions.getLastError(),
        );
      }
    } finally {
      this.functions.closeHandle(handle);
    }
  }

  readDirectory(directoryFd: number): readonly string[] {
    const handle = this.rawHandle(directoryFd);
    const names: string[] = [];
    let informationClass =
      WINDOWS_FILE_ID_BOTH_DIRECTORY_RESTART_INFO;
    while (true) {
      const output = Buffer.alloc(WINDOWS_DIRECTORY_BUFFER_BYTES);
      if (this.functions.getFileInformation(
        handle,
        informationClass,
        output,
        output.byteLength,
      ) === 0) {
        const errorCode = this.functions.getLastError();
        if (errorCode === WINDOWS_ERROR_NO_MORE_FILES) break;
        throw this.win32Error(
          'GetFileInformationByHandleEx(FileIdBothDirectoryInfo)',
          errorCode,
        );
      }
      const entries =
        parseWindowsHandleDirectoryEntries(output);
      for (const entry of entries) {
        if (entry.reparsePoint) {
          throw new CandidateWorkspaceFileBackendError(
            'candidate_atomic_directory_unsafe',
            'The Windows candidate directory contains a reparse point.',
          );
        }
        names.push(entry.name);
      }
      informationClass = WINDOWS_FILE_ID_BOTH_DIRECTORY_INFO;
    }
    return names.toSorted(comparePortableNames);
  }

  syncDirectory(directoryFd: number): void {
    if (this.functions.flushFileBuffers(
      this.rawHandle(directoryFd),
    ) === 0) {
      throw this.win32Error(
        'FlushFileBuffers',
        this.functions.getLastError(),
      );
    }
  }

  isErrno(error: unknown, code: string): boolean {
    return error instanceof Error
      && 'code' in error
      && error.code === code;
  }

  private openRelativeHandle(
    directoryFd: number,
    name: string,
    desiredAccess: number,
    createDisposition: number,
    createOptions: number,
    options?: {
      readonly allowSelf?: boolean;
    },
  ): unknown {
    assertWindowsHandleLeaf(
      name,
      options?.allowSelf === true,
    );
    const nameBytes = Buffer.from(`${name}\0`, 'utf16le');
    const unicodeString = buildWindowsUnicodeStringLayout(
      nameBytes,
      this.koffi.address(nameBytes),
    );
    const objectAttributes = buildWindowsObjectAttributesLayout(
      this.rawHandleAddress(directoryFd),
      this.koffi.address(unicodeString),
    );
    const ioStatusBlock = Buffer.alloc(
      process.arch === 'ia32' ? 8 : 16,
    );
    const outputHandle: unknown[] = [null];
    const status = this.functions.ntCreateFile(
      outputHandle,
      desiredAccess,
      objectAttributes,
      ioStatusBlock,
      null,
      WINDOWS_FILE_ATTRIBUTE_NORMAL,
      WINDOWS_SHARE_ALL,
      createDisposition,
      createOptions,
      null,
      0,
    );
    if (status < 0) {
      throw this.ntStatusError('NtCreateFile', status);
    }
    const handle = outputHandle[0];
    if (isInvalidWindowsHandle(this.koffi, handle)) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_backend_unavailable',
        'NtCreateFile returned an invalid Windows handle.',
      );
    }
    return handle;
  }

  private bindNodeDescriptor(handle: unknown, flags: number): number {
    const identity = this.rawHandleIdentity(handle);
    const handleAddress = this.koffi.address(handle);
    const fd = openSync(
      usableWindowsPath(this.finalPath(handle)),
      flags,
    );
    const selected = fstatSync(fd, { bigint: true });
    if (selected.dev !== identity.dev
      || selected.ino !== identity.ino) {
      closeNodeDescriptor(fd);
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The Windows candidate path changed while binding its descriptor.',
      );
    }
    this.rawHandles.set(fd, handleAddress);
    candidateDescriptorClosers.set(fd, () => {
      this.rawHandles.delete(fd);
      try {
        closeNodeDescriptor(fd);
      } finally {
        this.functions.closeHandle(handleAddress);
      }
    });
    return fd;
  }

  private rawHandle(fd: number): unknown {
    const handle = this.rawHandles.get(fd);
    if (handle === undefined
      || handle <= 0n
      || handle === windowsInvalidHandleAddress()) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_backend_unavailable',
        'The Node descriptor has no bound Windows handle.',
      );
    }
    return handle;
  }

  private rawHandleAddress(fd: number): bigint {
    return this.rawHandle(fd) as bigint;
  }

  private rawHandleIdentity(handle: unknown): FileIdentity {
    const output = Buffer.alloc(52);
    if (this.functions.getFileInformationByHandle(
      handle,
      output,
    ) === 0) {
      throw this.win32Error(
        'GetFileInformationByHandle',
        this.functions.getLastError(),
      );
    }
    return {
      dev: BigInt(output.readUInt32LE(28)),
      ino: (
        BigInt(output.readUInt32LE(44)) << 32n
      ) | BigInt(output.readUInt32LE(48)),
    };
  }

  private queryAttributes(handle: unknown): number {
    const output = Buffer.alloc(8);
    if (this.functions.getFileInformation(
      handle,
      WINDOWS_FILE_ATTRIBUTE_TAG_INFO,
      output,
      output.byteLength,
    ) === 0) {
      throw this.win32Error(
        'GetFileInformationByHandleEx(FileAttributeTagInfo)',
        this.functions.getLastError(),
      );
    }
    return output.readUInt32LE(0);
  }

  private finalPath(handle: unknown): string {
    const output = Buffer.alloc(65_536);
    const characters = this.functions.getFinalPathName(
      handle,
      output,
      output.byteLength / 2,
      0,
    );
    if (characters <= 0
      || characters >= output.byteLength / 2) {
      throw this.win32Error(
        'GetFinalPathNameByHandleW',
        this.functions.getLastError(),
      );
    }
    return output.toString('utf16le', 0, characters * 2);
  }

  private privateRootObservation(
    handle: unknown,
  ): WindowsPrivateRootSecurityObservationV1 {
    const currentUserSid = this.currentUserSid();
    const ownerSid: unknown[] = [null];
    const dacl: unknown[] = [null];
    const descriptor: unknown[] = [null];
    const result = this.functions.getSecurityInfo(
      handle,
      WINDOWS_SE_FILE_OBJECT,
      WINDOWS_OWNER_SECURITY_INFORMATION
        | WINDOWS_DACL_SECURITY_INFORMATION,
      ownerSid,
      null,
      dacl,
      null,
      descriptor,
    );
    if (result !== 0) {
      throw this.win32Error('GetSecurityInfo', result);
    }
    const descriptorValue = descriptor[0];
    try {
      const sddl = this.securityDescriptorSddl(
        descriptorValue,
      );
      const ownerSidValue = this.sidString(ownerSid[0]);
      assertExactWindowsPrivateRootSddl({
        sddl,
        currentUserSid,
        ownerSid: ownerSidValue,
        daclPresent: dacl[0] !== null
          && dacl[0] !== undefined,
      });
      return Object.freeze({
        openedHandleRelative: true,
        finalPathMatches: true,
        fileType: 'directory',
        reparsePoint: false,
        ownerSidMatchesCurrentUser: true,
        daclPresent: true,
        daclNull: false,
        daclProtected: true,
        allowedPrincipals: [
          'CURRENT_USER',
          'LOCAL_SYSTEM',
        ] as const,
        inheritableToChildren: true,
      });
    } finally {
      if (descriptorValue !== null
        && descriptorValue !== undefined) {
        this.functions.localFree(descriptorValue);
      }
    }
  }

  private currentUserSid(): string {
    const token: unknown[] = [null];
    if (this.functions.openProcessToken(
      this.functions.getCurrentProcess(),
      WINDOWS_TOKEN_QUERY,
      token,
    ) === 0) {
      throw this.win32Error(
        'OpenProcessToken',
        this.functions.getLastError(),
      );
    }
    try {
      const required: unknown[] = [0];
      this.functions.getTokenInformation(
        token[0],
        WINDOWS_TOKEN_USER,
        null,
        0,
        required,
      );
      const requiredBytes = Number(required[0]);
      if (!Number.isSafeInteger(requiredBytes)
        || requiredBytes <= 0
        || requiredBytes > 64 * 1024) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_root_identity_changed',
          'The Windows token user record size is invalid.',
        );
      }
      const output = Buffer.alloc(requiredBytes);
      if (this.functions.getTokenInformation(
        token[0],
        WINDOWS_TOKEN_USER,
        output,
        output.byteLength,
        required,
      ) === 0) {
        throw this.win32Error(
          'GetTokenInformation(TokenUser)',
          this.functions.getLastError(),
        );
      }
      const sid = this.koffi.decode(output, 'void *');
      return this.sidString(sid);
    } finally {
      if (token[0] !== null && token[0] !== undefined) {
        this.functions.closeHandle(token[0]);
      }
    }
  }

  private sidString(sid: unknown): string {
    const output: unknown[] = [null];
    if (this.functions.sidToString(sid, output) === 0) {
      throw this.win32Error(
        'ConvertSidToStringSidW',
        this.functions.getLastError(),
      );
    }
    try {
      const value = this.koffi.decode(output[0], 'str16');
      if (typeof value !== 'string' || value === '') {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_root_identity_changed',
          'The Windows current-user SID is invalid.',
        );
      }
      return value;
    } finally {
      this.functions.localFree(output[0]);
    }
  }

  private securityDescriptorSddl(
    descriptor: unknown,
  ): string {
    const output: unknown[] = [null];
    const characters: unknown[] = [0];
    if (this.functions.securityDescriptorToString(
      descriptor,
      WINDOWS_SDDL_REVISION_1,
      WINDOWS_OWNER_SECURITY_INFORMATION
        | WINDOWS_DACL_SECURITY_INFORMATION,
      output,
      characters,
    ) === 0) {
      throw this.win32Error(
        'ConvertSecurityDescriptorToStringSecurityDescriptorW',
        this.functions.getLastError(),
      );
    }
    try {
      const value = this.koffi.decode(output[0], 'str16');
      if (typeof value !== 'string' || value === '') {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_root_identity_changed',
          'The Windows private-root SDDL is invalid.',
        );
      }
      return value;
    } finally {
      this.functions.localFree(output[0]);
    }
  }

  private ntStatusError(
    syscall: string,
    status: number,
  ): NodeJS.ErrnoException {
    const unsignedStatus = status >>> 0;
    const windowsCode =
      this.functions.rtlNtStatusToDosError(unsignedStatus);
    return this.win32Error(syscall, windowsCode);
  }

  private win32Error(
    syscall: string,
    windowsCode: number,
  ): NodeJS.ErrnoException {
    const code = windowsErrorName(windowsCode);
    return Object.assign(
      new Error(`${syscall} failed with ${code}.`),
      { code, errno: windowsCode, syscall },
    );
  }
}

class PosixCandidateWorkspaceFileIO implements CandidateWorkspaceFileIO {
  private readonly openedNodes = new Map<string, OpenedNode>();
  private readonly listedFiles = new Map<string, BigIntStats>();
  private readonly mutatedPaths = new Set<string>();
  private closed = false;

  constructor(
    private readonly native: CandidateHandleNative,
    private readonly rootFd: number,
    private readonly rootDirectory: string,
    private readonly requestedRelativePath: string,
    private readonly operation: CandidateWorkspaceFileOperation,
    private readonly generatedPathScopes: readonly string[],
    private readonly testFault:
      DurableBoundaryTestFaultCapabilityV1 | undefined,
  ) {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let validationError: unknown;
    let closeError: unknown;
    for (const [path, node] of this.openedNodes) {
      if (validationError === undefined
        && !this.mutatedPaths.has(path)) {
        try {
          const current = fstatSync(node.fd, { bigint: true });
          if (node.info.isFile() && !sameStableFile(node.info, current)) {
            validationError = new CandidateWorkspaceFileBackendError(
              'candidate_atomic_file_changed',
              'A descriptor-bound candidate file changed before the operation completed.',
            );
          } else if (node.info.isDirectory()
            && !sameStableDirectory(node.info, current)) {
            validationError = new CandidateWorkspaceFileBackendError(
              'candidate_atomic_directory_changed',
              'A descriptor-bound candidate directory changed before the operation completed.',
            );
          }
        } catch (error) {
          validationError = error;
        }
      }
      try {
        closeSync(node.fd);
      } catch (error) {
        if (closeError === undefined) closeError = error;
      }
    }
    try {
      closeSync(this.rootFd);
    } catch (error) {
      if (closeError === undefined) closeError = error;
    }
    if (validationError !== undefined) throw toError(validationError);
    if (closeError !== undefined) throw toError(closeError);
  }

  async stat(path: string): Promise<StatResult> {
    const relativePath = this.relative(path);
    const listed = this.listedFiles.get(relativePath);
    if (this.operation === 'search' && listed !== undefined) {
      return toStatResult(
        this.withStableListedFile(relativePath, listed, (fd) =>
          fstatSync(fd, { bigint: true })),
      );
    }
    const node = this.openNode(relativePath);
    return toStatResult(node.info);
  }

  async readBytes(path: string, n?: number): Promise<Buffer> {
    if (n !== undefined
      && (!Number.isSafeInteger(n) || n < 0)) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_invalid_input',
        'The requested candidate read length is invalid.',
      );
    }
    const bytes = this.readExactFile(this.relative(path));
    return n === undefined ? Buffer.from(bytes) : Buffer.from(bytes.subarray(0, n));
  }

  async readText(
    path: string,
    options?: {
      encoding?: BufferEncoding;
      errors?: TextErrors;
    },
  ): Promise<string> {
    return decodeText(
      this.readExactFile(this.relative(path)),
      options?.encoding ?? 'utf8',
      options?.errors ?? 'strict',
    );
  }

  async *readLines(
    path: string,
    options?: {
      encoding?: BufferEncoding;
      errors?: TextErrors;
    },
  ): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.codePointAt(index) !== 10) continue;
      yield text.slice(start, index + 1);
      start = index + 1;
    }
    if (start < text.length) yield text.slice(start);
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    await this.atomicReplace(this.relative(path), data, false);
    return data.byteLength;
  }

  async writeText(
    path: string,
    data: string,
    options?: {
      mode?: 'w' | 'a';
      encoding?: BufferEncoding;
    },
  ): Promise<number> {
    const bytes = Buffer.from(data, options?.encoding ?? 'utf8');
    await this.atomicReplace(
      this.relative(path),
      bytes,
      options?.mode === 'a',
    );
    return data.length;
  }

  async mkdir(
    path: string,
    options?: {
      parents?: boolean;
      existOk?: boolean;
    },
  ): Promise<void> {
    const relativePath = this.relative(path);
    const segments = splitRelative(relativePath);
    if (segments.length === 0) {
      if (options?.existOk === true) return;
      throw nodeError('EEXIST', 'mkdirat');
    }
    if (options?.parents === true) {
      const descriptors: number[] = [];
      let current = this.rootFd;
      let currentRelativePath = '';
      try {
        for (const segment of segments) {
          let next: number;
          let created = false;
          try {
            next = this.native.openDirectoryAt(current, segment);
          } catch (error) {
            if (!this.native.isErrno(error, 'ENOENT')) throw error;
            try {
              this.native.mkdirAt(
                current,
                segment,
                directoryMode(),
              );
              created = true;
            } catch (mkdirError) {
              if (!this.native.isErrno(mkdirError, 'EEXIST')) {
                throw mkdirError;
              }
            }
            if (created) {
              this.refreshOpenedDirectory(currentRelativePath, current);
            }
            next = this.native.openDirectoryAt(current, segment);
          }
          descriptors.push(next);
          current = next;
          currentRelativePath = appendRelativePath(
            currentRelativePath,
            segment,
          );
        }
      } finally {
        for (const descriptor of descriptors.toReversed()) {
          closeSync(descriptor);
        }
      }
      return;
    }
    this.withParent(
      relativePath,
      false,
      (parentFd, leaf, parentRelativePath) => {
        let created = false;
        try {
          this.native.mkdirAt(parentFd, leaf, directoryMode());
          created = true;
        } catch (error) {
          if (options?.existOk !== true
            || !this.native.isErrno(error, 'EEXIST')) {
            throw error;
          }
          const fd = this.native.openDirectoryAt(parentFd, leaf);
          closeSync(fd);
        }
        if (created) {
          this.refreshOpenedDirectory(parentRelativePath, parentFd);
        }
      },
    );
  }

  async listFiles(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly includeIgnored?: boolean;
    },
  ): Promise<readonly CandidateWorkspaceFileEntry[]> {
    const relativePath = this.relative(path);
    if (isGeneratedDeniedRelativePath(
      relativePath,
      this.generatedPathScopes,
    )) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_search_scope_denied',
        'Candidate search cannot enter generated or bootstrap-owned directories.',
      );
    }
    const root = this.openNode(relativePath);
    if (root.info.isFile()) {
      this.assertSearchFile(relativePath, root.info);
      assertPortableSearchPath(relativePath, new Map());
      this.listedFiles.set(relativePath, root.info);
      return [{
        path: resolve(this.rootDirectory, relativePath),
        relativePath,
        stat: toStatResult(root.info),
      }];
    }
    if (!root.info.isDirectory()) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate search root is not a regular file or directory.',
      );
    }
    const state: SearchWalkState = {
      entries: [],
      portablePaths: new Map(),
      totalBytes: 0,
      includeIgnored: options?.includeIgnored === true,
      signal: options?.signal,
    };
    const ancestry = new Set([fileIdentityKey(root.info)]);
    this.walkDirectory(
      root.fd,
      root.info,
      relativePath,
      0,
      ancestry,
      state,
    );
    return state.entries;
  }

  private relative(path: string): string {
    const relativePath = checkedRelativePath(this.rootDirectory, path);
    if (isGeneratedDeniedRelativePath(
      relativePath,
      this.generatedPathScopes,
    )) {
      throw new CandidateWorkspaceFileBackendError(
        this.operation === 'search'
          ? 'candidate_atomic_search_scope_denied'
          : 'candidate_atomic_generated_scope_denied',
        'Candidate Writer tools cannot access bootstrap-owned generated paths.',
      );
    }
    const inScope = this.operation === 'search'
      ? relativePath === this.requestedRelativePath
        || isParentOf(this.requestedRelativePath, relativePath)
      : relativePath === this.requestedRelativePath
        || isParentOf(relativePath, this.requestedRelativePath);
    if (!inScope) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_scope_violation',
        'A Candidate tool attempted I/O outside its descriptor-bound path scope.',
      );
    }
    return relativePath;
  }

  private walkDirectory(
    directoryFd: number,
    initialDirectoryInfo: BigIntStats,
    directoryRelativePath: string,
    depth: number,
    ancestry: ReadonlySet<string>,
    state: SearchWalkState,
  ): void {
    assertSearchActive(state.signal);
    if (depth > MAX_SEARCH_DEPTH) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_search_limit',
        'The candidate directory tree exceeds the atomic search depth limit.',
      );
    }
    for (const name of this.native.readDirectory(directoryFd)) {
      assertSearchActive(state.signal);
      const childRelativePath = directoryRelativePath === ''
        ? name
        : `${directoryRelativePath}${sep}${name}`;
      if (isProtectedSearchName(name)
        || isGeneratedDeniedRelativePath(
          childRelativePath,
          this.generatedPathScopes,
        )) {
        continue;
      }
      assertPortableSearchPath(childRelativePath, state.portablePaths);
      let childFd: number | null = null;
      try {
        childFd = this.native.openReadNodeAt(directoryFd, name);
        const info = fstatSync(childFd, { bigint: true });
        if (info.isFile()) {
          this.assertSearchFile(childRelativePath, info);
          state.totalBytes += Number(info.size);
          if (state.entries.length >= MAX_SEARCH_FILES
            || state.totalBytes > MAX_SEARCH_TOTAL_BYTES) {
            throw new CandidateWorkspaceFileBackendError(
              'candidate_atomic_search_limit',
              'The candidate tree exceeds the atomic search size limit.',
            );
          }
          const entry = {
            path: resolve(this.rootDirectory, childRelativePath),
            relativePath: childRelativePath,
            stat: toStatResult(info),
          };
          state.entries.push(entry);
          this.listedFiles.set(childRelativePath, info);
          continue;
        }
        if (!info.isDirectory()) {
          throw new CandidateWorkspaceFileBackendError(
            'candidate_atomic_path_unsafe',
            'The candidate search encountered an unsafe filesystem node.',
          );
        }
        if (!state.includeIgnored
          && DEFAULT_IGNORED_DIRECTORIES.has(name.toLowerCase())) {
          continue;
        }
        const identity = fileIdentityKey(info);
        if (ancestry.has(identity)) {
          throw new CandidateWorkspaceFileBackendError(
            'candidate_atomic_directory_cycle',
            'The candidate search encountered a directory identity cycle.',
          );
        }
        this.walkDirectory(
          childFd,
          info,
          childRelativePath,
          depth + 1,
          new Set([...ancestry, identity]),
          state,
        );
      } finally {
        if (childFd !== null) closeSync(childFd);
      }
    }
    const finalDirectoryInfo = fstatSync(directoryFd, { bigint: true });
    if (!sameStableDirectory(
      initialDirectoryInfo,
      finalDirectoryInfo,
    )) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_directory_changed',
        'The candidate directory tree changed during descriptor-bound traversal.',
      );
    }
  }

  private assertSearchFile(
    relativePath: string,
    info: BigIntStats,
  ): void {
    if (!info.isFile() || info.nlink !== 1n) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate search encountered a hardlinked or non-regular file.',
      );
    }
    if (info.size > BigInt(MAX_SEARCH_FILE_BYTES)) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_search_limit',
        `Candidate search files are limited to ${String(MAX_SEARCH_FILE_BYTES)} bytes: ${relativePath}.`,
      );
    }
  }

  private openNode(relativePath: string): OpenedNode {
    const cached = this.openedNodes.get(relativePath);
    if (cached !== undefined) return cached;
    let fd: number;
    if (relativePath === '') {
      fd = this.native.openDirectoryAt(this.rootFd, '.');
    } else {
      fd = this.withParent(relativePath, false, (parentFd, leaf) =>
        this.native.openReadNodeAt(parentFd, leaf));
    }
    const info = fstatSync(fd, { bigint: true });
    if ((!info.isDirectory() && !info.isFile())
      || (info.isFile() && info.nlink !== 1n)) {
      closeSync(fd);
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate path is not a private regular file or directory.',
      );
    }
    const listed = this.listedFiles.get(relativePath);
    if (listed !== undefined && !sameStableFile(listed, info)) {
      closeSync(fd);
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_file_changed',
        'A candidate search file changed after descriptor-bound enumeration.',
      );
    }
    const node = { fd, info };
    this.openedNodes.set(relativePath, node);
    return node;
  }

  private readExactFile(relativePath: string): Buffer {
    const listed = this.listedFiles.get(relativePath);
    if (this.operation === 'search' && listed !== undefined) {
      return this.withStableListedFile(
        relativePath,
        listed,
        (fd, before) => {
          if (before.size > BigInt(MAX_ATOMIC_FILE_BYTES)) {
            throw new CandidateWorkspaceFileBackendError(
              'candidate_atomic_file_oversized',
              `Candidate atomic reads are limited to ${String(MAX_ATOMIC_FILE_BYTES)} bytes.`,
            );
          }
          const bytes = readFileSync(fd);
          if (BigInt(bytes.byteLength) !== before.size) {
            throw new CandidateWorkspaceFileBackendError(
              'candidate_atomic_file_changed',
              'The candidate search file changed while it was being read.',
            );
          }
          return Buffer.from(bytes);
        },
      );
    }
    const node = this.openNode(relativePath);
    if (!node.info.isFile() || node.info.nlink !== 1n) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate read target is not a private regular file.',
      );
    }
    if (node.info.size > BigInt(MAX_ATOMIC_FILE_BYTES)) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_file_oversized',
        `Candidate atomic reads are limited to ${String(MAX_ATOMIC_FILE_BYTES)} bytes.`,
      );
    }
    if (node.bytes === undefined) {
      const bytes = readFileSync(node.fd);
      const after = fstatSync(node.fd, { bigint: true });
      if (!sameStableFile(node.info, after)
        || BigInt(bytes.byteLength) !== node.info.size) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_file_changed',
          'The candidate file changed while it was being read.',
        );
      }
      node.bytes = Buffer.from(bytes);
    }
    return node.bytes;
  }

  private withStableListedFile<Result>(
    relativePath: string,
    listed: BigIntStats,
    callback: (fd: number, before: BigIntStats) => Result,
  ): Result {
    return this.withParent(relativePath, false, (parentFd, leaf) => {
      const fd = this.native.openReadNodeAt(parentFd, leaf);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile()
          || before.nlink !== 1n
          || !sameStableFile(listed, before)) {
          throw new CandidateWorkspaceFileBackendError(
            'candidate_atomic_file_changed',
            'A candidate search file changed after descriptor-bound enumeration.',
          );
        }
        const result = callback(fd, before);
        const after = fstatSync(fd, { bigint: true });
        if (!sameStableFile(before, after)) {
          throw new CandidateWorkspaceFileBackendError(
            'candidate_atomic_file_changed',
            'A candidate search file changed during descriptor-bound access.',
          );
        }
        return result;
      } finally {
        closeSync(fd);
      }
    });
  }

  private async atomicReplace(
    relativePath: string,
    appendedBytes: Buffer,
    append: boolean,
  ): Promise<void> {
    if (relativePath === '') {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate root cannot be replaced as a file.',
      );
    }
    await this.withParentAsync(
      relativePath,
      true,
      async (parentFd, leaf, parentRelativePath) => {
        let previous: OpenedNode | null = null;
        try {
          previous = this.openNode(relativePath);
          if (!previous.info.isFile() || previous.info.nlink !== 1n) {
            throw new CandidateWorkspaceFileBackendError(
              'candidate_atomic_path_unsafe',
              'The candidate write target is not a private regular file.',
            );
          }
        } catch (error) {
          if (!this.native.isErrno(error, 'ENOENT')) throw error;
        }
        const mode = previous === null
          ? fileMode()
          : Number(previous.info.mode & 0o777n);
        const temporary = this.createTemporary(parentFd);
        let renamed = false;
        let operationFailed = false;
        let operationError: unknown;
        try {
          if (append && previous !== null) {
            if (previous.info.size > BigInt(MAX_ATOMIC_FILE_BYTES)) {
              throw new CandidateWorkspaceFileBackendError(
                'candidate_atomic_file_oversized',
                `Candidate atomic appends are limited to ${String(MAX_ATOMIC_FILE_BYTES)} existing bytes.`,
              );
            }
            copyFileDescriptor(previous.fd, temporary.fd);
            const afterCopy = fstatSync(previous.fd, { bigint: true });
            if (!sameStableFile(previous.info, afterCopy)) {
              throw new CandidateWorkspaceFileBackendError(
                'candidate_atomic_file_changed',
                'The candidate file changed while preparing an append.',
              );
            }
          }
          writeAll(temporary.fd, appendedBytes);
          fchmodSync(temporary.fd, mode);
          fsyncSync(temporary.fd);
          await injectDurableBoundaryTestFault(
            this.testFault,
            'candidate_writer_after_temporary_synced',
          );
          this.assertLeafUnchanged(parentFd, leaf, previous);
          await injectDurableBoundaryTestFault(
            this.testFault,
            'candidate_writer_after_final_leaf_check',
          );
          this.native.renameAt(parentFd, temporary.name, parentFd, leaf);
          renamed = true;
          this.mutatedPaths.add(relativePath);
          await injectDurableBoundaryTestFault(
            this.testFault,
            'candidate_writer_after_atomic_replace',
          );
          this.native.syncDirectory(parentFd);
        } catch (error) {
          operationFailed = true;
          operationError = error;
        }
        let cleanupError: unknown;
        try {
          closeSync(temporary.fd);
        } catch (error) {
          cleanupError = error;
        }
        if (!renamed) {
          try {
            this.native.unlinkAt(parentFd, temporary.name);
          } catch (error) {
            if (!this.native.isErrno(error, 'ENOENT')
              && cleanupError === undefined) {
              cleanupError = error;
            }
          }
        }
        try {
          this.refreshOpenedDirectory(parentRelativePath, parentFd);
        } catch (error) {
          if (cleanupError === undefined) cleanupError = error;
        }
        if (operationFailed) throw toError(operationError);
        if (cleanupError !== undefined) {
          throw toError(cleanupError);
        }
      },
    );
  }

  private assertLeafUnchanged(
    parentFd: number,
    leaf: string,
    previous: OpenedNode | null,
  ): void {
    let currentFd: number | null = null;
    try {
      currentFd = this.native.openReadNodeAt(parentFd, leaf);
      const current = fstatSync(currentFd, { bigint: true });
      if (previous === null || !sameFileIdentity(previous.info, current)) {
        throw new CandidateWorkspaceFileBackendError(
          'candidate_atomic_file_changed',
          'The candidate write target changed before atomic replacement.',
        );
      }
    } catch (error) {
      if (previous === null && this.native.isErrno(error, 'ENOENT')) return;
      throw error;
    } finally {
      if (currentFd !== null) closeSync(currentFd);
    }
  }

  private createTemporary(parentFd: number): {
    readonly fd: number;
    readonly name: string;
  } {
    for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS; attempt += 1) {
      const name = `.wukong-candidate-${randomBytes(16).toString('hex')}.tmp`;
      try {
        return {
          name,
          fd: this.native.openExclusiveWritableFileAt(
            parentFd,
            name,
            0o600,
          ),
        };
      } catch (error) {
        if (!this.native.isErrno(error, 'EEXIST')) throw error;
      }
    }
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_temporary_collision',
      'Unable to reserve an atomic candidate temporary file.',
    );
  }

  private async withParentAsync<Result>(
    relativePath: string,
    createMissing: boolean,
    callback: (
      parentFd: number,
      leaf: string,
      parentRelativePath: string,
    ) => Promise<Result>,
  ): Promise<Result> {
    const segments = splitRelative(relativePath);
    const leaf = segments.pop();
    if (leaf === undefined) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate root has no file leaf.',
      );
    }
    const descriptors: number[] = [];
    let current = this.rootFd;
    let currentRelativePath = '';
    try {
      for (const segment of segments) {
        let next: number;
        let created = false;
        try {
          next = this.native.openDirectoryAt(current, segment);
        } catch (error) {
          if (!createMissing || !this.native.isErrno(error, 'ENOENT')) {
            throw error;
          }
          try {
            this.native.mkdirAt(current, segment, directoryMode());
            created = true;
          } catch (mkdirError) {
            if (!this.native.isErrno(mkdirError, 'EEXIST')) {
              throw mkdirError;
            }
          }
          if (created) {
            this.refreshOpenedDirectory(currentRelativePath, current);
          }
          next = this.native.openDirectoryAt(current, segment);
        }
        descriptors.push(next);
        current = next;
        currentRelativePath = appendRelativePath(
          currentRelativePath,
          segment,
        );
      }
      return await callback(current, leaf, currentRelativePath);
    } finally {
      for (const descriptor of descriptors.toReversed()) {
        closeSync(descriptor);
      }
    }
  }

  private withParent<Result>(
    relativePath: string,
    createMissing: boolean,
    callback: (
      parentFd: number,
      leaf: string,
      parentRelativePath: string,
    ) => Result,
  ): Result {
    const segments = splitRelative(relativePath);
    const leaf = segments.pop();
    if (leaf === undefined) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate root has no file leaf.',
      );
    }
    const descriptors: number[] = [];
    let current = this.rootFd;
    let currentRelativePath = '';
    try {
      for (const segment of segments) {
        let next: number;
        let created = false;
        try {
          next = this.native.openDirectoryAt(current, segment);
        } catch (error) {
          if (!createMissing || !this.native.isErrno(error, 'ENOENT')) {
            throw error;
          }
          try {
            this.native.mkdirAt(current, segment, directoryMode());
            created = true;
          } catch (mkdirError) {
            if (!this.native.isErrno(mkdirError, 'EEXIST')) {
              throw mkdirError;
            }
          }
          if (created) {
            this.refreshOpenedDirectory(currentRelativePath, current);
          }
          next = this.native.openDirectoryAt(current, segment);
        }
        descriptors.push(next);
        current = next;
        currentRelativePath = appendRelativePath(
          currentRelativePath,
          segment,
        );
      }
      return callback(current, leaf, currentRelativePath);
    } finally {
      for (const descriptor of descriptors.toReversed()) {
        closeSync(descriptor);
      }
    }
  }

  private refreshOpenedDirectory(
    relativePath: string,
    fd: number,
  ): void {
    const node = this.openedNodes.get(relativePath);
    if (node === undefined) return;
    const current = fstatSync(fd, { bigint: true });
    if (!node.info.isDirectory()
      || !current.isDirectory()
      || !sameFileIdentity(node.info, current)) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_directory_changed',
        'A candidate parent directory changed identity during the operation.',
      );
    }
    node.info = current;
  }
}

function checkedRelativePath(root: string, path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_path_unsafe',
      'The candidate atomic path must be canonical and absolute.',
    );
  }
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..')
    || isAbsolute(relativePath)
    || relativePath.includes('\0')) {
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_path_unsafe',
      'The candidate atomic path escaped its authorized root.',
    );
  }
  splitRelative(relativePath);
  return relativePath;
}

function splitRelative(relativePath: string): string[] {
  if (relativePath === '') return [];
  const segments = relativePath.split(sep);
  if (segments.some((segment) =>
    segment === ''
    || segment === '.'
    || segment === '..'
    || segment.includes('\0')
    || PROTECTED_SEGMENTS.has(segment))) {
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_path_unsafe',
      'The candidate atomic path contains a protected or invalid segment.',
    );
  }
  return segments;
}

function isParentOf(parent: string, child: string): boolean {
  if (parent === '') return true;
  return child.startsWith(`${parent}${sep}`);
}

function appendRelativePath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}${sep}${child}`;
}

function fileMode(): number {
  return 0o666 & ~process.umask();
}

function directoryMode(): number {
  return 0o777 & ~process.umask();
}

function loadPosixOpenConstants(): PosixOpenConstants {
  const values = importedFsConstants as unknown as
    Readonly<Record<string, unknown>>;
  const required = [
    'O_RDONLY',
    'O_WRONLY',
    'O_CREAT',
    'O_EXCL',
    'O_NONBLOCK',
    'O_DIRECTORY',
    'O_NOFOLLOW',
  ] as const;
  for (const name of required) {
    if (!Number.isInteger(values[name])) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_backend_unavailable',
        `The runtime does not expose the required POSIX ${name} flag.`,
      );
    }
  }
  return {
    O_RDONLY: values['O_RDONLY'] as number,
    O_WRONLY: values['O_WRONLY'] as number,
    O_CREAT: values['O_CREAT'] as number,
    O_EXCL: values['O_EXCL'] as number,
    O_NONBLOCK: values['O_NONBLOCK'] as number,
    O_DIRECTORY: values['O_DIRECTORY'] as number,
    O_NOFOLLOW: values['O_NOFOLLOW'] as number,
    O_CLOEXEC: Number.isInteger(values['O_CLOEXEC'])
      ? values['O_CLOEXEC'] as number
      : 0,
  };
}

function isInvalidWindowsHandle(
  koffi: KoffiModule,
  handle: unknown,
): boolean {
  if (handle === null || handle === undefined) return true;
  try {
    const address = koffi.address(handle);
    return address === 0n
      || address === windowsInvalidHandleAddress();
  } catch {
    return true;
  }
}

function windowsInvalidHandleAddress(): bigint {
  return process.arch === 'ia32'
    ? 0xffff_ffffn
    : 0xffff_ffff_ffff_ffffn;
}

function normalizeWindowsPath(value: string): string {
  return usableWindowsPath(value).toLowerCase();
}

function usableWindowsPath(value: string): string {
  let normalized = value.replaceAll('/', '\\');
  if (normalized.startsWith('\\\\?\\UNC\\')) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }
  if (!/^[A-Za-z]:\\$/u.test(normalized)
    && !/^\\\\[^\\]+\\[^\\]+\\$/u.test(normalized)) {
    normalized = normalized.replace(/\\+$/u, '');
  }
  return normalized;
}

function assertWindowsHandleLeaf(
  value: string,
  allowSelf = false,
): void {
  if (allowSelf && value === '.') return;
  if (value === ''
    || value === '.'
    || value === '..'
    || value !== value.normalize('NFC')
    || value.endsWith('.')
    || value.endsWith(' ')
    || WINDOWS_RESERVED_CHARACTERS.test(value)
    || WINDOWS_RESERVED_DEVICE.test(value)
    || Buffer.byteLength(value, 'utf16le')
      > MAX_PORTABLE_SEGMENT_BYTES * 2) {
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_path_unsafe',
      'The Windows handle-relative leaf is unsafe.',
    );
  }
}

function windowsErrorName(windowsCode: number): string {
  switch (windowsCode) {
    case 2:
    case 3:
      return 'ENOENT';
    case 5:
      return 'EACCES';
    case 6:
      return 'EBADF';
    case 17:
      return 'EXDEV';
    case 32:
    case 33:
      return 'EBUSY';
    case 80:
    case 183:
      return 'EEXIST';
    case 87:
      return 'EINVAL';
    case 145:
      return 'ENOTEMPTY';
    case 267:
      return 'ENOTDIR';
    default:
      return `WIN32_${String(windowsCode)}`;
  }
}

function copyFileDescriptor(sourceFd: number, targetFd: number): void {
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = readFileChunk(sourceFd, buffer, position);
    if (bytesRead === 0) return;
    writeAll(targetFd, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function readFileChunk(
  fd: number,
  buffer: Buffer,
  position: number,
): number {
  return readSync(fd, buffer, 0, buffer.byteLength, position);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (written <= 0) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_write_failed',
        'The candidate atomic write made no progress.',
      );
    }
    offset += written;
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function sameStableDirectory(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return sameFileIdentity(left, right)
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileIdentityKey(info: BigIntStats): string {
  return `${info.dev.toString()}:${info.ino.toString()}`;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertPortableSearchPath(
  path: string,
  seen: Map<string, string>,
): void {
  if (path !== path.normalize('NFC')
    || Buffer.byteLength(path, 'utf8') > MAX_PORTABLE_PATH_BYTES) {
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_path_unsafe',
      'The candidate search encountered a non-portable path.',
    );
  }
  for (const segment of path.split(sep)) {
    if (segment === ''
      || segment === '.'
      || segment === '..'
      || segment.endsWith(' ')
      || segment.endsWith('.')
      || WINDOWS_RESERVED_CHARACTERS.test(segment)
      || WINDOWS_RESERVED_DEVICE.test(segment)
      || Buffer.byteLength(segment, 'utf8') > MAX_PORTABLE_SEGMENT_BYTES) {
      throw new CandidateWorkspaceFileBackendError(
        'candidate_atomic_path_unsafe',
        'The candidate search encountered a non-portable path segment.',
      );
    }
  }
  const key = path.normalize('NFC').toLowerCase();
  const previous = seen.get(key);
  if (previous !== undefined && previous !== path) {
    throw new CandidateWorkspaceFileBackendError(
      'candidate_atomic_portable_collision',
      'The candidate search encountered a portable path collision.',
    );
  }
  seen.set(key, path);
}

function isProtectedSearchName(name: string): boolean {
  const folded = name.toLowerCase();
  return PROTECTED_SEGMENTS.has(folded)
    || /^\.wukong-candidate-[a-f0-9]{32}\.tmp$/u.test(folded);
}

function isGeneratedDeniedRelativePath(
  relativePath: string,
  generatedPathScopes: readonly string[],
): boolean {
  if (relativePath === '') return false;
  const portablePath = relativePath.split(sep).join('/');
  const foldedPath = portablePath.normalize('NFC').toLowerCase();
  if (foldedPath.split('/').some((segment) =>
    GENERATED_DENIED_DIRECTORIES.has(segment))) {
    return true;
  }
  return generatedPathScopes.some((scope) => {
    const foldedScope = scope.normalize('NFC').toLowerCase();
    return foldedPath === foldedScope
      || foldedPath.startsWith(`${foldedScope}/`);
  });
}

function assertSearchActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Candidate search aborted.', 'AbortError');
  }
}

function comparePortableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toStatResult(info: BigIntStats): StatResult {
  return {
    stMode: Number(info.mode),
    stIno: Number(info.ino),
    stDev: Number(info.dev),
    stNlink: Number(info.nlink),
    stUid: Number(info.uid),
    stGid: Number(info.gid),
    stSize: Number(info.size),
    stAtime: Number(info.atimeNs) / 1_000_000_000,
    stMtime: Number(info.mtimeNs) / 1_000_000_000,
    stCtime: Number(info.ctimeNs) / 1_000_000_000,
  };
}

function decodeText(
  bytes: Buffer,
  encoding: BufferEncoding,
  errors: TextErrors,
): string {
  if (/^utf-?8$/iu.test(encoding)) {
    if (errors === 'strict') {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return errors === 'ignore' ? text.replaceAll('\uFFFD', '') : text;
  }
  return bytes.toString(encoding);
}

function nodeError(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`${syscall} failed with ${code}.`),
    { code, syscall },
  );
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new CandidateWorkspaceFileBackendError(
        'candidate_atomic_unexpected_failure',
        'Candidate atomic I/O failed with a non-Error value.',
        { cause: error },
      );
}
