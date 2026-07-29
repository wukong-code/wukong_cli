import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as importedFsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readSync,
  realpathSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

import type {
  CandidateProjectionEntryV1,
} from '@wukong/verification';

import {
  attestWindowsPrivateRootPathSecurity,
  inspectWindowsPrivateRootSecurityBackendCapability,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';
import {
  buildWindowsHandleRelativeRenameInfo,
  buildWindowsObjectAttributesLayout,
  buildWindowsUnicodeStringLayout,
} from './windows-handle-relative-layout';

const require = createRequire(import.meta.url);

const PROTECTED_SEGMENTS = new Set(['.git', '.wukong']);
const TRANSACTION_STAGE_NAME = 'stage';
const TRANSACTION_QUARANTINE_NAME = 'quarantine';
const TRANSACTION_OWNER_NAME = 'owner';
const TRANSACTION_IDENTITY_NAME = 'identity';
const TRANSACTION_COMMITTED_NAME = 'committed';
const TRANSACTION_CLEANUP_NAME = 'cleanup';
const TRANSACTION_CLEANUP_SUFFIX = '.cleanup';
const TRANSACTION_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const MAX_TRANSACTION_MARKER_BYTES = 4_096;

export type TargetPromotionWorkspaceBackendUnavailableReason =
  | 'target_promotion_atomic_backend_platform_unsupported'
  | 'target_promotion_atomic_backend_native_unavailable'
  | 'target_promotion_atomic_backend_windows_private_root_unavailable'
  | 'target_promotion_atomic_backend_windows_handle_unavailable';

export type TargetPromotionWorkspaceBackendCapabilityV1 =
  | Readonly<{
      available: true;
      platform: 'darwin' | 'linux' | 'win32';
      backend:
        | 'posix-openat-atomic-rename-v2'
        | 'windows-nt-handle-transaction-v1';
      reasonCode: null;
    }>
  | Readonly<{
      available: false;
      platform: NodeJS.Platform;
      backend: null;
      reasonCode: TargetPromotionWorkspaceBackendUnavailableReason;
    }>;

export interface TargetPromotionWorkspaceBackendProbeDependencies {
  readonly platform?: NodeJS.Platform;
  readonly resolveNative?: () => void;
  readonly resolveWindowsPrivateRootSecurity?: () => void;
  readonly resolveWindowsHandleNative?: () => void;
}

export interface TargetPromotionPathObservationV1 {
  readonly presence: 'present' | 'absent';
  readonly fileType: 'regular' | 'directory' | 'other' | null;
  readonly mode: number | null;
  readonly contentDigest: string | null;
}

interface KoffiLibrary {
  func(definition: string): (...args: readonly unknown[]) => unknown;
}

interface KoffiModule {
  load(path: string | null): KoffiLibrary;
  errno(value?: number): number;
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
  readonly renameAtomic: (
    oldDirectoryFd: number,
    oldPath: string,
    newDirectoryFd: number,
    newPath: string,
    flags: number,
  ) => number;
  readonly unlinkat: (
    directoryFd: number,
    path: string,
    flags: number,
  ) => number;
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
  readonly AT_REMOVEDIR: number;
  readonly RENAME_NOREPLACE: number;
  readonly RENAME_EXCHANGE: number;
}

interface WindowsTargetFunctions {
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
  readonly openOsFileHandle: (
    handleAddress: bigint,
    flags: number,
  ) => number;
  readonly getOsFileHandle: (fd: number) => bigint | number;
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
const WINDOWS_FILE_RENAME_INFO = 3;
const WINDOWS_FILE_DISPOSITION_INFO = 4;
const WINDOWS_O_RDONLY = 0;
const WINDOWS_O_WRONLY = 1;
const WINDOWS_O_BINARY = 0x8000;

interface TargetHandleNative {
  readonly replaceStrategy: 'exchange' | 'quarantine';
  openRoot(path: string): number;
  duplicateDirectory(fd: number): number;
  openDirectoryAt(directoryFd: number, name: string): number;
  openReadNodeAt(directoryFd: number, name: string): number;
  openMutationNodeAt(directoryFd: number, name: string): number;
  openExclusiveWritableFileAt(
    directoryFd: number,
    name: string,
    mode: number,
  ): number;
  mkdirAt(directoryFd: number, name: string, mode: number): void;
  renameNoReplace(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
    sourceFd?: number,
  ): void;
  renameExchange(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
  ): void;
  unlinkAt(directoryFd: number, name: string): void;
  removeDirectoryAt(directoryFd: number, name: string): void;
  assertTransactionDirectory(fd: number, created: boolean): void;
  isErrno(error: unknown, code: string): boolean;
}

interface OpenedParent {
  readonly fd: number;
  readonly leaf: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface SerializedFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

type TargetTransactionOperation =
  | 'create'
  | 'replace'
  | 'delete'
  | 'rename';

interface TargetTransactionBinding {
  readonly transactionId: string;
  readonly operation: TargetTransactionOperation;
  readonly sourceRelativePath: string | null;
  readonly targetRelativePath: string | null;
  readonly preimageEntryDigest: string | null;
  readonly postimageEntryDigest: string | null;
}

interface TargetTransactionIdentityMarkerV1
  extends TargetTransactionBinding {
  readonly schemaVersion: 1;
  readonly preimageIdentity: SerializedFileIdentity | null;
  readonly stageIdentity: SerializedFileIdentity | null;
}

type TargetTransactionCleanupArtifactName =
  | typeof TRANSACTION_STAGE_NAME
  | typeof TRANSACTION_QUARANTINE_NAME
  | typeof TRANSACTION_OWNER_NAME
  | typeof TRANSACTION_IDENTITY_NAME
  | typeof TRANSACTION_COMMITTED_NAME;

interface TargetTransactionCleanupArtifactV1 {
  readonly name: TargetTransactionCleanupArtifactName;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly sizeBytes: string;
  readonly contentDigest: string;
}

interface TargetTransactionCleanupMarkerV1 {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly artifacts:
    readonly TargetTransactionCleanupArtifactV1[];
}

interface ObservedLeaf {
  readonly observation: TargetPromotionPathObservationV1;
  readonly identity: FileIdentity | null;
}

interface TargetPromotionWorkspaceBackendOptions {
  readonly afterFinalLeafCheck?: () => Promise<void>;
  readonly afterAtomicMutation?: () => Promise<void>;
  /**
   * Synchronous crash seams used only by process-level cleanup recovery tests.
   * Production callers do not supply them.
   */
  readonly afterTransactionCleanupPrepared?: () => void;
  readonly afterTransactionCleanupQuarantined?: () => void;
  readonly afterTransactionCleanupArtifactRemoved?: (
    name: TargetTransactionCleanupArtifactName,
  ) => void;
  readonly afterTransactionCleanupMarkerRemoved?: () => void;
}

export class TargetPromotionWorkspaceBackendError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TargetPromotionWorkspaceBackendError';
  }
}

/**
 * Performs a zero-write probe of the native primitive set used by Target
 * Apply. Windows requires both the protected-root ACL primitives and the
 * handle-relative NT transaction backend before the experimental Loop may
 * create durable state. An available result proves native loadability, not
 * support from a particular mounted filesystem: every transaction proves
 * no-replace/exchange on its actual target and fails closed on that syscall.
 */
export function inspectTargetPromotionWorkspaceBackendCapability(
  dependencies: TargetPromotionWorkspaceBackendProbeDependencies = {},
): TargetPromotionWorkspaceBackendCapabilityV1 {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    const privateRoot =
      inspectWindowsPrivateRootSecurityBackendCapability({
        platform,
        resolveNative:
          dependencies.resolveWindowsPrivateRootSecurity,
      });
    if (!privateRoot.available) {
      return Object.freeze({
        available: false,
        platform,
        backend: null,
        reasonCode:
          'target_promotion_atomic_backend_windows_private_root_unavailable',
      });
    }
    try {
      (
        dependencies.resolveWindowsHandleNative
        ?? resolveWindowsTargetHandleNative
      )();
    } catch {
      return Object.freeze({
        available: false,
        platform,
        backend: null,
        reasonCode:
          'target_promotion_atomic_backend_windows_handle_unavailable',
      });
    }
    return Object.freeze({
      available: true,
      platform,
      backend: 'windows-nt-handle-transaction-v1',
      reasonCode: null,
    });
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    return Object.freeze({
      available: false,
      platform,
      backend: null,
      reasonCode:
        'target_promotion_atomic_backend_platform_unsupported',
    });
  }
  try {
    (dependencies.resolveNative ?? (() => PosixNative.create()))();
    return Object.freeze({
      available: true,
      platform,
      backend: 'posix-openat-atomic-rename-v2',
      reasonCode: null,
    });
  } catch {
    return Object.freeze({
      available: false,
      platform,
      backend: null,
      reasonCode: 'target_promotion_atomic_backend_native_unavailable',
    });
  }
}

function resolveWindowsTargetHandleNative(): void {
  WindowsTargetNative.create();
}

/**
 * One descriptor-rooted filesystem session. Every component is opened with
 * O_NOFOLLOW and every mutation is issued relative to the resulting parent
 * descriptor. The class does not claim to sandbox a malicious same-UID
 * process; it prevents string path re-resolution from escaping the selected
 * workspace through a swapped symlink parent.
 */
export class TargetPromotionWorkspaceBackend {
  private readonly native: TargetHandleNative;
  private readonly rootDirectory: string;
  private readonly rootFd: number;
  private readonly rootIdentity: BigIntStats;
  private readonly afterFinalLeafCheck: () => Promise<void>;
  private readonly afterAtomicMutation: () => Promise<void>;
  private readonly afterTransactionCleanupPrepared: () => void;
  private readonly afterTransactionCleanupQuarantined: () => void;
  private readonly afterTransactionCleanupArtifactRemoved: (
    name: TargetTransactionCleanupArtifactName,
  ) => void;
  private readonly afterTransactionCleanupMarkerRemoved: () => void;
  private closed = false;

  constructor(
    rootDirectory: string,
    options: TargetPromotionWorkspaceBackendOptions = {},
  ) {
    if (!isAbsolute(rootDirectory)
      || resolve(rootDirectory) !== rootDirectory) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_root_unsafe',
        'The Target promotion root must be an absolute normalized directory.',
      );
    }
    this.native = process.platform === 'win32'
      ? WindowsTargetNative.create()
      : PosixNative.create();
    this.rootDirectory = realpathSync(rootDirectory);
    this.rootFd = this.native.openRoot(this.rootDirectory);
    this.rootIdentity = fstatSync(this.rootFd, { bigint: true });
    this.afterFinalLeafCheck =
      options.afterFinalLeafCheck ?? (() => Promise.resolve());
    this.afterAtomicMutation =
      options.afterAtomicMutation ?? (() => Promise.resolve());
    this.afterTransactionCleanupPrepared =
      options.afterTransactionCleanupPrepared ?? (() => {});
    this.afterTransactionCleanupQuarantined =
      options.afterTransactionCleanupQuarantined ?? (() => {});
    this.afterTransactionCleanupArtifactRemoved =
      options.afterTransactionCleanupArtifactRemoved ?? (() => {});
    this.afterTransactionCleanupMarkerRemoved =
      options.afterTransactionCleanupMarkerRemoved ?? (() => {});
    if (!isControlledDirectory(this.rootIdentity)) {
      closeSync(this.rootFd);
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_root_unsafe',
        'The Target promotion root is not an owner-controlled directory.',
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.rootFd);
  }

  observe(relativePath: string): TargetPromotionPathObservationV1 {
    this.assertOpen();
    const segments = splitRelativePath(relativePath);
    let parent: OpenedParent;
    try {
      parent = this.openParent(segments, false);
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) {
        return absentObservation();
      }
      throw error;
    }
    try {
      let fd: number;
      try {
        fd = this.native.openReadNodeAt(parent.fd, parent.leaf);
      } catch (error) {
        if (this.native.isErrno(error, 'ENOENT')) {
          return absentObservation();
        }
        throw error;
      }
      try {
        const info = fstatSync(fd, { bigint: true });
        if (info.isFile() && info.nlink === 1n) {
          return Object.freeze({
            presence: 'present',
            fileType: 'regular',
            mode: targetObservedMode(info),
            contentDigest: digestExactRegularFile(fd, info),
          });
        }
        return Object.freeze({
          presence: 'present',
          fileType: info.isDirectory() ? 'directory' : 'other',
          mode: targetObservedMode(info),
          contentDigest: null,
        });
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent.fd);
    }
  }

  readExact(
    entry: CandidateProjectionEntryV1,
  ): Buffer {
    const parent = this.openParent(
      splitRelativePath(entry.canonicalRelativePath),
      false,
    );
    try {
      const fd = this.native.openReadNodeAt(parent.fd, parent.leaf);
      try {
        return readExactRegularFile(fd, entry);
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent.fd);
    }
  }

  async recoverReplace(
    entry: CandidateProjectionEntryV1,
    expectedPreimage: CandidateProjectionEntryV1 | null,
    transactionId: string,
  ): Promise<void> {
    let parent: OpenedParent;
    try {
      parent = this.openParent(
        splitRelativePath(entry.canonicalRelativePath),
        false,
      );
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const transactionName = transactionDirectoryName(transactionId);
    const binding = replaceTransactionBinding(
      entry,
      expectedPreimage,
      transactionId,
    );
    let transactionFd: number | null = null;
    try {
      transactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        false,
      );
      const target = this.observeLeafAt(parent.fd, parent.leaf);
      if (transactionFd === null) {
        const isPreimage = expectedPreimage === null
          ? target.observation.presence === 'absent'
          : matchesEntry(target.observation, expectedPreimage);
        if (isPreimage) return;
        if (matchesEntry(target.observation, entry)) {
          this.artifactConflict(
            'Target postimage has no durable replacement transaction receipt.',
          );
        }
        return;
      }
      const stage = this.observeLeafAt(
        transactionFd,
        TRANSACTION_STAGE_NAME,
      );
      const quarantine = this.observeLeafAt(
        transactionFd,
        TRANSACTION_QUARANTINE_NAME,
      );
      const marker = this.readTransactionIdentityMarker(
        transactionFd,
        binding,
      );
      if (marker === null) {
        this.assertTransactionCommittedAbsent(transactionFd);
        if (quarantine.observation.presence !== 'absent') {
          this.artifactConflict(
            'Replacement recovery found an unbound quarantine artifact.',
          );
        }
        if (expectedPreimage === null) {
          if (target.observation.presence === 'absent'
            && matchesEntry(stage.observation, entry)) {
            return;
          }
          if (target.observation.presence === 'absent'
            && stage.observation.presence === 'absent') {
            this.removeBareTransactionDirectory(
              parent.fd,
              transactionName,
              transactionFd,
              transactionId,
            );
            return;
          }
          this.artifactConflict(
            'Create recovery found an unbound Target transaction artifact.',
          );
        }
        if (matchesEntry(target.observation, expectedPreimage)
          && matchesEntry(stage.observation, entry)) {
          return;
        }
        if (matchesEntry(target.observation, expectedPreimage)
          && stage.observation.presence === 'absent') {
          this.removeBareTransactionDirectory(
              parent.fd,
              transactionName,
              transactionFd,
              transactionId,
          );
          return;
        }
        this.artifactConflict(
          'Update recovery found an unbound Target transaction artifact.',
        );
      }
      const committed = this.isTransactionCommitted(
        transactionFd,
        marker,
      );
      if (expectedPreimage === null) {
        if (quarantine.observation.presence !== 'absent') {
          this.artifactConflict(
            'Create recovery found an unexpected quarantine artifact.',
          );
        }
        if (!committed
          && target.observation.presence === 'absent'
          && matchesEntry(stage.observation, entry)
          && sameOptionalIdentity(
            stage.identity,
            marker.stageIdentity,
          )) {
          return;
        }
        if (matchesEntry(target.observation, entry)
          && sameOptionalIdentity(
            target.identity,
            marker.stageIdentity,
          )
          && stage.observation.presence === 'absent') {
          this.ensureTransactionCommitted(transactionFd, marker);
          return;
        }
        this.artifactConflict(
          'Create recovery found an ambiguous Target transaction artifact.',
        );
      }
      if (this.native.replaceStrategy === 'quarantine') {
        await this.recoverQuarantineReplace(
          parent,
          target,
          stage,
          quarantine,
          entry,
          expectedPreimage,
          marker,
          committed,
          transactionFd,
        );
        return;
      }
      if (!committed
        && matchesEntry(target.observation, expectedPreimage)
        && sameOptionalIdentity(
          target.identity,
          marker.preimageIdentity,
        )
        && matchesEntry(stage.observation, entry)
        && sameOptionalIdentity(
          stage.identity,
          marker.stageIdentity,
        )) {
        return;
      }
      if (matchesEntry(target.observation, entry)
        && sameOptionalIdentity(
          target.identity,
          marker.stageIdentity,
        )
        && matchesEntry(stage.observation, expectedPreimage)
        && sameOptionalIdentity(
          stage.identity,
          marker.preimageIdentity,
        )) {
        this.ensureTransactionCommitted(transactionFd, marker);
        return;
      }
      this.artifactConflict(
        'Update recovery found an ambiguous Target transaction artifact.',
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  async recoverDelete(
    entry: CandidateProjectionEntryV1,
    transactionId: string,
  ): Promise<void> {
    let parent: OpenedParent;
    try {
      parent = this.openParent(
        splitRelativePath(entry.canonicalRelativePath),
        false,
      );
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const transactionName = transactionDirectoryName(transactionId);
    const binding = deleteTransactionBinding(entry, transactionId);
    let transactionFd: number | null = null;
    try {
      transactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        false,
      );
      const target = this.observeLeafAt(parent.fd, parent.leaf);
      if (transactionFd === null) {
        if (matchesEntry(target.observation, entry)) return;
        if (target.observation.presence === 'absent') {
          this.artifactConflict(
            'Deleted Target postimage has no durable transaction receipt.',
          );
        }
        return;
      }
      const stage = this.observeLeafAt(
        transactionFd,
        TRANSACTION_STAGE_NAME,
      );
      const marker = this.readTransactionIdentityMarker(
        transactionFd,
        binding,
      );
      if (marker === null) {
        this.assertTransactionCommittedAbsent(transactionFd);
        if (matchesEntry(target.observation, entry)
          && stage.observation.presence === 'absent') {
          this.removeBareTransactionDirectory(
            parent.fd,
            transactionName,
            transactionFd,
            transactionId,
          );
          return;
        }
        this.artifactConflict(
          'Delete recovery found an unbound quarantine artifact.',
        );
      }
      const committed = this.isTransactionCommitted(
        transactionFd,
        marker,
      );
      if (!committed
        && matchesEntry(target.observation, entry)
        && sameOptionalIdentity(
          target.identity,
          marker.preimageIdentity,
        )
        && stage.observation.presence === 'absent') {
        return;
      }
      if (target.observation.presence === 'absent'
        && matchesEntry(stage.observation, entry)
        && sameOptionalIdentity(
          stage.identity,
          marker.preimageIdentity,
        )) {
        this.ensureTransactionCommitted(transactionFd, marker);
        return;
      }
      this.artifactConflict(
        'Delete recovery retained an ambiguous quarantine artifact.',
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  async recoverRename(
    source: CandidateProjectionEntryV1,
    targetRelativePath: string,
    transactionId: string,
  ): Promise<void> {
    let sourceParent: OpenedParent | null = null;
    let targetParent: OpenedParent | null = null;
    let transactionFd: number | null = null;
    try {
      try {
        sourceParent = this.openParent(
          splitRelativePath(source.canonicalRelativePath),
          false,
        );
      } catch (error) {
        if (!this.native.isErrno(error, 'ENOENT')) throw error;
      }
      try {
        targetParent = this.openParent(
          splitRelativePath(targetRelativePath),
          false,
        );
      } catch (error) {
        if (!this.native.isErrno(error, 'ENOENT')) throw error;
      }
      const sourceState = sourceParent === null
        ? absentLeaf()
        : this.observeLeafAt(sourceParent.fd, sourceParent.leaf);
      const targetState = targetParent === null
        ? absentLeaf()
        : this.observeLeafAt(targetParent.fd, targetParent.leaf);
      const isPreimage = matchesEntry(sourceState.observation, source)
        && targetState.observation.presence === 'absent';
      const isPostimage = sourceState.observation.presence === 'absent'
        && matchesEntry(targetState.observation, source);
      if (sourceParent === null) {
        if (isPostimage) {
          this.artifactConflict(
            'Renamed Target postimage has no reachable transaction receipt.',
          );
        }
        return;
      }
      const transactionName = transactionDirectoryName(transactionId);
      const binding = renameTransactionBinding(
        source,
        targetRelativePath,
        transactionId,
      );
      transactionFd = this.openTransactionDirectory(
        sourceParent.fd,
        transactionName,
        transactionId,
        false,
      );
      if (transactionFd === null) {
        if (isPreimage) return;
        if (isPostimage) {
          this.artifactConflict(
            'Renamed Target postimage has no durable transaction receipt.',
          );
        }
        return;
      }
      const marker = this.readTransactionIdentityMarker(
        transactionFd,
        binding,
      );
      if (marker === null) {
        this.assertTransactionCommittedAbsent(transactionFd);
        assertLeafAbsent(
          this.native,
          transactionFd,
          TRANSACTION_STAGE_NAME,
        );
        if (isPreimage) {
          this.removeBareTransactionDirectory(
            sourceParent.fd,
            transactionName,
            transactionFd,
            transactionId,
          );
          return;
        }
        this.artifactConflict(
          'Rename recovery found an unbound Target transaction.',
        );
      }
      const committed = this.isTransactionCommitted(
        transactionFd,
        marker,
      );
      if (!committed
        && isPreimage
        && sameOptionalIdentity(
          sourceState.identity,
          marker.preimageIdentity,
        )) {
        return;
      }
      if (isPostimage
        && sameOptionalIdentity(
          targetState.identity,
          marker.preimageIdentity,
        )) {
        this.ensureTransactionCommitted(transactionFd, marker);
      } else {
        this.artifactConflict(
          'Rename recovery found an ambiguous Target transaction.',
        );
      }
      if (sourceParent !== null) fsyncSync(sourceParent.fd);
      if (targetParent !== null
        && (sourceParent === null
          || !sameFileIdentity(
            fstatSync(sourceParent.fd, { bigint: true }),
            fstatSync(targetParent.fd, { bigint: true }),
          ))) {
        fsyncSync(targetParent.fd);
      }
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      if (targetParent !== null) closeSync(targetParent.fd);
      if (sourceParent !== null) closeSync(sourceParent.fd);
    }
  }

  async unlinkExact(
    entry: CandidateProjectionEntryV1,
    transactionId: string,
  ): Promise<void> {
    const parent = this.openParent(
      splitRelativePath(entry.canonicalRelativePath),
      false,
    );
    const transactionName = transactionDirectoryName(transactionId);
    const binding = deleteTransactionBinding(entry, transactionId);
    let transactionFd: number | null = null;
    let marker: TargetTransactionIdentityMarkerV1 | null = null;
    try {
      this.assertRootStillSelected();
      const openedTransactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        true,
      );
      if (openedTransactionFd === null) {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_artifact_unavailable',
          'The Target delete transaction directory could not be opened.',
        );
      }
      transactionFd = openedTransactionFd;
      assertLeafAbsent(
        this.native,
        openedTransactionFd,
        TRANSACTION_STAGE_NAME,
      );
      let movedIdentity: FileIdentity | undefined;
      await this.withExactLeaf(parent, entry, async (identity, sourceFd) => {
        movedIdentity = identity;
        marker = this.ensureTransactionIdentityMarker(
          openedTransactionFd,
          binding,
          identity,
          null,
        );
        await this.afterFinalLeafCheck();
        this.native.renameNoReplace(
          parent.fd,
          parent.leaf,
          openedTransactionFd,
          TRANSACTION_STAGE_NAME,
          sourceFd,
        );
      });
      await this.afterAtomicMutation();
      fsyncSync(parent.fd);
      fsyncSync(openedTransactionFd);
      try {
        this.assertExactLeafIdentity(
          openedTransactionFd,
          TRANSACTION_STAGE_NAME,
          entry,
          movedIdentity!,
        );
      } catch (error) {
        this.rollbackNoReplace(
          openedTransactionFd,
          TRANSACTION_STAGE_NAME,
          parent.fd,
          parent.leaf,
        );
        this.removeEmptyTransactionDirectory(
          parent.fd,
          transactionName,
          openedTransactionFd,
          marker!,
          false,
        );
        throw error;
      }
      this.ensureTransactionCommitted(
        openedTransactionFd,
        marker!,
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  async renameExact(
    source: CandidateProjectionEntryV1,
    targetRelativePath: string,
    transactionId: string,
  ): Promise<void> {
    const sourceParent = this.openParent(
      splitRelativePath(source.canonicalRelativePath),
      false,
    );
    let targetParent: OpenedParent | undefined;
    let transactionFd: number | null = null;
    try {
      targetParent = this.openParent(
        splitRelativePath(targetRelativePath),
        true,
      );
      this.assertRootStillSelected();
      const transactionName = transactionDirectoryName(transactionId);
      const binding = renameTransactionBinding(
        source,
        targetRelativePath,
        transactionId,
      );
      const openedTransactionFd = this.openTransactionDirectory(
        sourceParent.fd,
        transactionName,
        transactionId,
        true,
      );
      if (openedTransactionFd === null) {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_artifact_unavailable',
          'The Target rename transaction directory could not be opened.',
        );
      }
      transactionFd = openedTransactionFd;
      assertLeafAbsent(
        this.native,
        openedTransactionFd,
        TRANSACTION_STAGE_NAME,
      );
      let movedIdentity: FileIdentity | undefined;
      let marker: TargetTransactionIdentityMarkerV1 | null = null;
      await this.withExactLeaf(
        sourceParent,
        source,
        async (identity, sourceFd) => {
        movedIdentity = identity;
        marker = this.ensureTransactionIdentityMarker(
          openedTransactionFd,
          binding,
          identity,
          null,
        );
        assertLeafAbsent(this.native, targetParent!.fd, targetParent!.leaf);
        await this.afterFinalLeafCheck();
        this.native.renameNoReplace(
          sourceParent.fd,
          sourceParent.leaf,
          targetParent!.fd,
          targetParent!.leaf,
          sourceFd,
        );
        },
      );
      await this.afterAtomicMutation();
      fsyncSync(sourceParent.fd);
      if (!sameFileIdentity(
        fstatSync(sourceParent.fd, { bigint: true }),
        fstatSync(targetParent.fd, { bigint: true }),
      )) {
        fsyncSync(targetParent.fd);
      }
      try {
        this.assertExactLeafIdentity(
          targetParent.fd,
          targetParent.leaf,
          source,
          movedIdentity!,
        );
      } catch (error) {
        this.rollbackNoReplace(
          targetParent.fd,
          targetParent.leaf,
          sourceParent.fd,
          sourceParent.leaf,
        );
        this.removeEmptyTransactionDirectory(
          sourceParent.fd,
          transactionName,
          openedTransactionFd,
          marker!,
          false,
        );
        throw error;
      }
      this.ensureTransactionCommitted(
        openedTransactionFd,
        marker!,
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      if (targetParent !== undefined) closeSync(targetParent.fd);
      closeSync(sourceParent.fd);
    }
  }

  async replaceExact(
    entry: CandidateProjectionEntryV1,
    bytes: Uint8Array,
    expectedPreimage: CandidateProjectionEntryV1 | null,
    transactionId: string,
  ): Promise<void> {
    const parent = this.openParent(
      splitRelativePath(entry.canonicalRelativePath),
      true,
    );
    const transactionName = transactionDirectoryName(transactionId);
    const binding = replaceTransactionBinding(
      entry,
      expectedPreimage,
      transactionId,
    );
    let transactionFd: number | null = null;
    try {
      this.assertRootStillSelected();
      const openedTransactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        true,
      );
      if (openedTransactionFd === null) {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_artifact_unavailable',
          'The Target replacement transaction directory could not be opened.',
        );
      }
      transactionFd = openedTransactionFd;
      const stageIdentity = this.ensureStage(
        openedTransactionFd,
        entry,
        bytes,
      );
      let exchangedIdentity: FileIdentity | undefined;
      let marker: TargetTransactionIdentityMarkerV1 | null = null;
      if (expectedPreimage === null) {
        marker = this.ensureTransactionIdentityMarker(
          openedTransactionFd,
          binding,
          null,
          stageIdentity,
        );
        assertLeafAbsent(this.native, parent.fd, parent.leaf);
        await this.afterFinalLeafCheck();
        try {
          this.native.renameNoReplace(
            openedTransactionFd,
            TRANSACTION_STAGE_NAME,
            parent.fd,
            parent.leaf,
          );
        } catch (error) {
          if (this.native.isErrno(error, 'EEXIST')) {
            this.removeExactTransaction(
              parent.fd,
              transactionName,
              openedTransactionFd,
              entry,
              marker,
              stageIdentity,
              false,
            );
            this.leafChanged(
              'The Target create destination appeared before the atomic move.',
              { cause: error },
            );
          }
          throw error;
        }
      } else {
        if (this.native.replaceStrategy === 'quarantine') {
          await this.replaceExistingWithQuarantine({
            parent,
            transactionFd: openedTransactionFd,
            entry,
            expectedPreimage,
            binding,
            stageIdentity,
          });
          return;
        }
        await this.withExactLeaf(
          parent,
          expectedPreimage,
          async (identity) => {
            exchangedIdentity = identity;
            marker = this.ensureTransactionIdentityMarker(
              openedTransactionFd,
              binding,
              identity,
              stageIdentity,
            );
            await this.afterFinalLeafCheck();
            this.native.renameExchange(
              openedTransactionFd,
              TRANSACTION_STAGE_NAME,
              parent.fd,
              parent.leaf,
            );
          },
        );
      }
      await this.afterAtomicMutation();
      fsyncSync(parent.fd);
      fsyncSync(openedTransactionFd);
      if (expectedPreimage === null) {
        this.assertExactLeafIdentity(
          parent.fd,
          parent.leaf,
          entry,
          stageIdentity,
        );
        this.ensureTransactionCommitted(
          openedTransactionFd,
          marker!,
        );
        return;
      }
      try {
        this.assertExactLeafIdentity(
          parent.fd,
          parent.leaf,
          entry,
          stageIdentity,
        );
        this.assertExactLeafIdentity(
          openedTransactionFd,
          TRANSACTION_STAGE_NAME,
          expectedPreimage,
          exchangedIdentity!,
        );
      } catch (error) {
        this.native.renameExchange(
          openedTransactionFd,
          TRANSACTION_STAGE_NAME,
          parent.fd,
          parent.leaf,
        );
        fsyncSync(parent.fd);
        fsyncSync(openedTransactionFd);
        try {
          this.removeExactTransaction(
            parent.fd,
            transactionName,
            openedTransactionFd,
            entry,
            marker!,
            stageIdentity,
            false,
          );
        } catch {
          this.artifactConflict(
            'Update rollback retained an unknown transaction artifact.',
          );
        }
        throw error;
      }
      this.ensureTransactionCommitted(
        openedTransactionFd,
        marker!,
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  async finalizeReplace(
    entry: CandidateProjectionEntryV1,
    expectedPreimage: CandidateProjectionEntryV1 | null,
    transactionId: string,
  ): Promise<void> {
    let parent: OpenedParent;
    try {
      parent = this.openParent(
        splitRelativePath(entry.canonicalRelativePath),
        false,
      );
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const transactionName = transactionDirectoryName(transactionId);
    let transactionFd: number | null = null;
    try {
      transactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        false,
      );
      if (transactionFd === null) return;
      const marker = this.requireTransactionIdentityMarker(
        transactionFd,
        replaceTransactionBinding(
          entry,
          expectedPreimage,
          transactionId,
        ),
      );
      this.assertTransactionCommitted(transactionFd, marker);
      if (expectedPreimage === null) {
        this.removeEmptyTransactionDirectory(
          parent.fd,
          transactionName,
          transactionFd,
          marker,
          true,
        );
        return;
      }
      this.removeExactTransaction(
        parent.fd,
        transactionName,
        transactionFd,
        expectedPreimage,
        marker,
        deserializeFileIdentity(marker.preimageIdentity),
        true,
        this.native.replaceStrategy === 'quarantine'
          ? TRANSACTION_QUARANTINE_NAME
          : TRANSACTION_STAGE_NAME,
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  async finalizeDelete(
    entry: CandidateProjectionEntryV1,
    transactionId: string,
  ): Promise<void> {
    let parent: OpenedParent;
    try {
      parent = this.openParent(
        splitRelativePath(entry.canonicalRelativePath),
        false,
      );
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const transactionName = transactionDirectoryName(transactionId);
    let transactionFd: number | null = null;
    try {
      transactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        false,
      );
      if (transactionFd === null) return;
      const marker = this.requireTransactionIdentityMarker(
        transactionFd,
        deleteTransactionBinding(entry, transactionId),
      );
      this.assertTransactionCommitted(transactionFd, marker);
      this.removeExactTransaction(
        parent.fd,
        transactionName,
        transactionFd,
        entry,
        marker,
        deserializeFileIdentity(marker.preimageIdentity),
        true,
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  async finalizeRename(
    source: CandidateProjectionEntryV1,
    targetRelativePath: string,
    transactionId: string,
  ): Promise<void> {
    let parent: OpenedParent;
    try {
      parent = this.openParent(
        splitRelativePath(source.canonicalRelativePath),
        false,
      );
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const transactionName = transactionDirectoryName(transactionId);
    let transactionFd: number | null = null;
    try {
      transactionFd = this.openTransactionDirectory(
        parent.fd,
        transactionName,
        transactionId,
        false,
      );
      if (transactionFd === null) return;
      const marker = this.requireTransactionIdentityMarker(
        transactionFd,
        renameTransactionBinding(
          source,
          targetRelativePath,
          transactionId,
        ),
      );
      this.assertTransactionCommitted(transactionFd, marker);
      this.removeEmptyTransactionDirectory(
        parent.fd,
        transactionName,
        transactionFd,
        marker,
        true,
      );
    } finally {
      if (transactionFd !== null) closeSync(transactionFd);
      closeSync(parent.fd);
    }
  }

  private async recoverQuarantineReplace(
    parent: OpenedParent,
    target: ObservedLeaf,
    stage: ObservedLeaf,
    quarantine: ObservedLeaf,
    entry: CandidateProjectionEntryV1,
    expectedPreimage: CandidateProjectionEntryV1,
    marker: TargetTransactionIdentityMarkerV1,
    committed: boolean,
    transactionFd: number,
  ): Promise<void> {
    const preimageState =
      matchesEntry(target.observation, expectedPreimage)
      && sameOptionalIdentity(
        target.identity,
        marker.preimageIdentity,
      )
      && matchesEntry(stage.observation, entry)
      && sameOptionalIdentity(
        stage.identity,
        marker.stageIdentity,
      )
      && quarantine.observation.presence === 'absent';
    if (!committed && preimageState) return;

    const quarantinedState =
      target.observation.presence === 'absent'
      && matchesEntry(stage.observation, entry)
      && sameOptionalIdentity(
        stage.identity,
        marker.stageIdentity,
      )
      && matchesEntry(
        quarantine.observation,
        expectedPreimage,
      )
      && sameOptionalIdentity(
        quarantine.identity,
        marker.preimageIdentity,
      );
    if (!committed && quarantinedState) {
      await this.promoteQuarantinedStage({
        parent,
        transactionFd,
        entry,
        expectedPreimage,
        marker,
        stageIdentity: deserializeFileIdentity(
          marker.stageIdentity,
        ),
      });
      return;
    }

    const postimageState =
      matchesEntry(target.observation, entry)
      && sameOptionalIdentity(
        target.identity,
        marker.stageIdentity,
      )
      && stage.observation.presence === 'absent'
      && matchesEntry(
        quarantine.observation,
        expectedPreimage,
      )
      && sameOptionalIdentity(
        quarantine.identity,
        marker.preimageIdentity,
      );
    if (postimageState) {
      this.ensureTransactionCommitted(transactionFd, marker);
      return;
    }
    this.artifactConflict(
      'Windows update recovery found an ambiguous quarantine transaction.',
    );
  }

  private async replaceExistingWithQuarantine(input: {
    readonly parent: OpenedParent;
    readonly transactionFd: number;
    readonly entry: CandidateProjectionEntryV1;
    readonly expectedPreimage: CandidateProjectionEntryV1;
    readonly binding: TargetTransactionBinding;
    readonly stageIdentity: FileIdentity;
  }): Promise<void> {
    const {
      parent,
      transactionFd,
      entry,
      expectedPreimage,
      binding,
      stageIdentity,
    } = input;
    let marker: TargetTransactionIdentityMarkerV1;
    const quarantine = this.observeLeafAt(
      transactionFd,
      TRANSACTION_QUARANTINE_NAME,
    );
    if (quarantine.observation.presence === 'absent') {
      let createdMarker:
        TargetTransactionIdentityMarkerV1 | null = null;
      await this.withExactLeaf(
        parent,
        expectedPreimage,
        async (identity, sourceFd) => {
          createdMarker = this.ensureTransactionIdentityMarker(
            transactionFd,
            binding,
            identity,
            stageIdentity,
          );
          await this.afterFinalLeafCheck();
          this.native.renameNoReplace(
            parent.fd,
            parent.leaf,
            transactionFd,
            TRANSACTION_QUARANTINE_NAME,
            sourceFd,
          );
        },
      );
      marker = createdMarker!;
      await this.afterAtomicMutation();
      fsyncSync(parent.fd);
      fsyncSync(transactionFd);
    } else {
      marker = this.requireTransactionIdentityMarker(
        transactionFd,
        binding,
      );
      if (!matchesEntry(
        quarantine.observation,
        expectedPreimage,
      )
        || !sameOptionalIdentity(
          quarantine.identity,
          marker.preimageIdentity,
        )
        || !sameOptionalIdentity(
          stageIdentity,
          marker.stageIdentity,
        )) {
        this.artifactConflict(
          'Windows update found an invalid quarantine preimage.',
        );
      }
    }

    await this.promoteQuarantinedStage({
      parent,
      transactionFd,
      entry,
      expectedPreimage,
      marker,
      stageIdentity,
    });
  }

  private async promoteQuarantinedStage(input: {
    readonly parent: OpenedParent;
    readonly transactionFd: number;
    readonly entry: CandidateProjectionEntryV1;
    readonly expectedPreimage: CandidateProjectionEntryV1;
    readonly marker: TargetTransactionIdentityMarkerV1;
    readonly stageIdentity: FileIdentity;
  }): Promise<void> {
    const {
      parent,
      transactionFd,
      entry,
      expectedPreimage,
      marker,
      stageIdentity,
    } = input;
    assertLeafAbsent(this.native, parent.fd, parent.leaf);
    const stageFd = this.native.openMutationNodeAt(
      transactionFd,
      TRANSACTION_STAGE_NAME,
    );
    try {
      assertExactRegularFile(stageFd, entry);
      const stageInfo = fstatSync(stageFd, { bigint: true });
      if (stageInfo.dev !== stageIdentity.dev
        || stageInfo.ino !== stageIdentity.ino) {
        this.artifactConflict(
          'Windows update stage identity changed before promotion.',
        );
      }
      await this.afterFinalLeafCheck();
      try {
        this.native.renameNoReplace(
          transactionFd,
          TRANSACTION_STAGE_NAME,
          parent.fd,
          parent.leaf,
          stageFd,
        );
      } catch (error) {
        if (this.native.isErrno(error, 'EEXIST')) {
          this.leafChanged(
            'The Target update destination appeared before the no-replace move.',
            { cause: error },
          );
        }
        throw error;
      }
    } finally {
      closeSync(stageFd);
    }
    await this.afterAtomicMutation();
    fsyncSync(parent.fd);
    fsyncSync(transactionFd);
    this.assertExactLeafIdentity(
      parent.fd,
      parent.leaf,
      entry,
      stageIdentity,
    );
    this.assertExactLeafIdentity(
      transactionFd,
      TRANSACTION_QUARANTINE_NAME,
      expectedPreimage,
      deserializeFileIdentity(marker.preimageIdentity),
    );
    this.ensureTransactionCommitted(transactionFd, marker);
  }

  private async withExactLeaf(
    parent: OpenedParent,
    entry: CandidateProjectionEntryV1,
    callback: (
      identity: FileIdentity,
      fd: number,
    ) => Promise<void>,
  ): Promise<void> {
    const fd = this.native.openMutationNodeAt(
      parent.fd,
      parent.leaf,
    );
    try {
      assertExactRegularFile(fd, entry);
      const info = fstatSync(fd, { bigint: true });
      await callback({ dev: info.dev, ino: info.ino }, fd);
    } finally {
      closeSync(fd);
    }
  }

  private openTransactionDirectory(
    parentFd: number,
    name: string,
    transactionId: string,
    create: boolean,
  ): number | null {
    const cleanupName = transactionCleanupDirectoryName(name);
    let fd = this.openOptionalTransactionDirectory(parentFd, name);
    let cleanupFd = this.openOptionalTransactionDirectory(
      parentFd,
      cleanupName,
    );
    if (fd !== null && cleanupFd !== null) {
      closeSync(fd);
      closeSync(cleanupFd);
      this.artifactConflict(
        'The Target transaction and cleanup quarantine both exist.',
      );
    }
    if (cleanupFd !== null) {
      try {
        this.native.assertTransactionDirectory(cleanupFd, false);
        this.resumeTransactionDirectoryCleanup(
          parentFd,
          name,
          cleanupName,
          cleanupFd,
          transactionId,
          true,
        );
      } finally {
        closeSync(cleanupFd);
      }
      cleanupFd = null;
    }
    if (fd !== null) {
      try {
        this.native.assertTransactionDirectory(fd, false);
        if (this.readOptionalTransactionMarker(
          fd,
          TRANSACTION_CLEANUP_NAME,
        ) !== null) {
          this.resumeTransactionDirectoryCleanup(
            parentFd,
            name,
            cleanupName,
            fd,
            transactionId,
            false,
          );
          closeSync(fd);
          fd = null;
        } else {
          this.assertTransactionOwner(fd, transactionId);
          return fd;
        }
      } catch (error) {
        if (fd !== null) closeSync(fd);
        throw error;
      }
    }
    if (!create) return null;

    let created = false;
    try {
      this.native.mkdirAt(parentFd, name, 0o700);
      fsyncSync(parentFd);
      created = true;
    } catch (error) {
      if (!this.native.isErrno(error, 'EEXIST')) throw error;
    }
    fd = this.native.openDirectoryAt(parentFd, name);
    try {
      this.native.assertTransactionDirectory(fd, created);
      if (!created) {
        this.artifactConflict(
          'A Target transaction directory appeared after cleanup.',
        );
      }
      this.writeTransactionOwner(fd, transactionId);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private openOptionalTransactionDirectory(
    parentFd: number,
    name: string,
  ): number | null {
    try {
      return this.native.openDirectoryAt(parentFd, name);
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private writeTransactionOwner(
    transactionFd: number,
    transactionId: string,
  ): void {
    const bytes = transactionOwnerBytes(transactionId);
    const fd = this.native.openExclusiveWritableFileAt(
      transactionFd,
      TRANSACTION_OWNER_NAME,
      0o600,
    );
    try {
      writeAll(fd, bytes);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncSync(transactionFd);
  }

  private assertTransactionOwner(
    transactionFd: number,
    transactionId: string,
  ): void {
    const expected = transactionOwnerBytes(transactionId);
    const fd = this.native.openReadNodeAt(
      transactionFd,
      TRANSACTION_OWNER_NAME,
    );
    try {
      const info = fstatSync(fd, { bigint: true });
      const actual = readDescriptorBytes(fd, info.size);
      if (!info.isFile()
        || info.nlink !== 1n
        || (process.platform !== 'win32'
          && Number(info.mode & 0o777n) !== 0o600)
        || !actual.equals(expected)) {
        this.artifactConflict(
          'The deterministic Target transaction owner marker is invalid.',
        );
      }
    } finally {
      closeSync(fd);
    }
  }

  private ensureTransactionIdentityMarker(
    transactionFd: number,
    binding: TargetTransactionBinding,
    preimageIdentity: FileIdentity | null,
    stageIdentity: FileIdentity | null,
  ): TargetTransactionIdentityMarkerV1 {
    const marker = Object.freeze({
      schemaVersion: 1 as const,
      ...binding,
      preimageIdentity: serializeFileIdentity(preimageIdentity),
      stageIdentity: serializeFileIdentity(stageIdentity),
    });
    const expected = transactionIdentityBytes(marker);
    let fd: number;
    try {
      fd = this.native.openExclusiveWritableFileAt(
        transactionFd,
        TRANSACTION_IDENTITY_NAME,
        0o600,
      );
    } catch (error) {
      if (!this.native.isErrno(error, 'EEXIST')) throw error;
      this.assertExactTransactionMarker(
        transactionFd,
        TRANSACTION_IDENTITY_NAME,
        expected,
      );
      return marker;
    }
    try {
      writeAll(fd, expected);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncSync(transactionFd);
    return marker;
  }

  private readTransactionIdentityMarker(
    transactionFd: number,
    binding: TargetTransactionBinding,
  ): TargetTransactionIdentityMarkerV1 | null {
    const bytes = this.readOptionalTransactionMarker(
      transactionFd,
      TRANSACTION_IDENTITY_NAME,
    );
    if (bytes === null) return null;
    let marker: TargetTransactionIdentityMarkerV1;
    try {
      marker = parseTransactionIdentityMarker(bytes);
    } catch (error) {
      this.artifactConflict(
        `The Target transaction identity marker is invalid: ${
          error instanceof Error ? error.message : 'unknown'
        }.`,
      );
    }
    if (!sameTransactionBinding(marker, binding)) {
      this.artifactConflict(
        'The Target transaction identity marker is bound to another change.',
      );
    }
    return marker;
  }

  private requireTransactionIdentityMarker(
    transactionFd: number,
    binding: TargetTransactionBinding,
  ): TargetTransactionIdentityMarkerV1 {
    const marker = this.readTransactionIdentityMarker(
      transactionFd,
      binding,
    );
    if (marker === null) {
      this.artifactConflict(
        'The Target transaction has no durable identity marker.',
      );
    }
    return marker;
  }

  private ensureTransactionCommitted(
    transactionFd: number,
    marker: TargetTransactionIdentityMarkerV1,
  ): void {
    const expected = transactionCommittedBytes(marker);
    let fd: number;
    try {
      fd = this.native.openExclusiveWritableFileAt(
        transactionFd,
        TRANSACTION_COMMITTED_NAME,
        0o600,
      );
    } catch (error) {
      if (!this.native.isErrno(error, 'EEXIST')) throw error;
      this.assertExactTransactionMarker(
        transactionFd,
        TRANSACTION_COMMITTED_NAME,
        expected,
      );
      return;
    }
    try {
      writeAll(fd, expected);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncSync(transactionFd);
  }

  private isTransactionCommitted(
    transactionFd: number,
    marker: TargetTransactionIdentityMarkerV1,
  ): boolean {
    const actual = this.readOptionalTransactionMarker(
      transactionFd,
      TRANSACTION_COMMITTED_NAME,
    );
    if (actual === null) return false;
    if (!actual.equals(transactionCommittedBytes(marker))) {
      this.artifactConflict(
        'The Target transaction committed marker is invalid.',
      );
    }
    return true;
  }

  private assertTransactionCommitted(
    transactionFd: number,
    marker: TargetTransactionIdentityMarkerV1,
  ): void {
    if (!this.isTransactionCommitted(transactionFd, marker)) {
      this.artifactConflict(
        'The Target transaction has no durable committed receipt.',
      );
    }
  }

  private assertTransactionCommittedAbsent(
    transactionFd: number,
  ): void {
    if (this.readOptionalTransactionMarker(
      transactionFd,
      TRANSACTION_COMMITTED_NAME,
    ) !== null) {
      this.artifactConflict(
        'The Target transaction has a committed receipt without identity.',
      );
    }
  }

  private assertExactTransactionMarker(
    transactionFd: number,
    name: string,
    expected: Buffer,
  ): void {
    const actual = this.readOptionalTransactionMarker(
      transactionFd,
      name,
    );
    if (actual === null || !actual.equals(expected)) {
      this.artifactConflict(
        `The deterministic Target transaction ${name} marker is invalid.`,
      );
    }
  }

  private readOptionalTransactionMarker(
    transactionFd: number,
    name: string,
  ): Buffer | null {
    let fd: number;
    try {
      fd = this.native.openReadNodeAt(transactionFd, name);
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return null;
      throw error;
    }
    try {
      const info = fstatSync(fd, { bigint: true });
      if (!info.isFile()
        || info.nlink !== 1n
        || (process.platform !== 'win32'
          && Number(info.mode & 0o777n) !== 0o600)
        || info.size > BigInt(MAX_TRANSACTION_MARKER_BYTES)) {
        this.artifactConflict(
          `The deterministic Target transaction ${name} marker is unsafe.`,
        );
      }
      return readDescriptorBytes(fd, info.size);
    } finally {
      closeSync(fd);
    }
  }

  private ensureStage(
    transactionFd: number,
    entry: CandidateProjectionEntryV1,
    bytes: Uint8Array,
  ): FileIdentity {
    let fd: number;
    try {
      fd = this.native.openExclusiveWritableFileAt(
        transactionFd,
        TRANSACTION_STAGE_NAME,
        0o600,
      );
    } catch (error) {
      if (!this.native.isErrno(error, 'EEXIST')) throw error;
      this.assertExactLeaf(
        transactionFd,
        TRANSACTION_STAGE_NAME,
        entry,
      );
      return this.readLeafIdentity(
        transactionFd,
        TRANSACTION_STAGE_NAME,
        entry,
      );
    }
    try {
      writeAll(fd, bytes);
      fchmodSync(fd, entry.mode & 0o777);
      fsyncSync(fd);
      const info = fstatSync(fd, { bigint: true });
      return { dev: info.dev, ino: info.ino };
    } finally {
      closeSync(fd);
      fsyncSync(transactionFd);
    }
  }

  private observeAt(
    directoryFd: number,
    leaf: string,
  ): TargetPromotionPathObservationV1 {
    return this.observeLeafAt(directoryFd, leaf).observation;
  }

  private observeLeafAt(
    directoryFd: number,
    leaf: string,
  ): ObservedLeaf {
    let fd: number;
    try {
      fd = this.native.openReadNodeAt(directoryFd, leaf);
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) {
        return absentLeaf();
      }
      throw error;
    }
    try {
      const info = fstatSync(fd, { bigint: true });
      if (info.isFile() && info.nlink === 1n) {
        return Object.freeze({
          observation: Object.freeze({
            presence: 'present' as const,
            fileType: 'regular' as const,
            mode: targetObservedMode(info),
            contentDigest: digestExactRegularFile(fd, info),
          }),
          identity: Object.freeze({
            dev: info.dev,
            ino: info.ino,
          }),
        });
      }
      return Object.freeze({
        observation: Object.freeze({
          presence: 'present' as const,
          fileType: info.isDirectory()
            ? 'directory' as const
            : 'other' as const,
          mode: targetObservedMode(info),
          contentDigest: null,
        }),
        identity: null,
      });
    } finally {
      closeSync(fd);
    }
  }

  private readLeafIdentity(
    directoryFd: number,
    leaf: string,
    entry: CandidateProjectionEntryV1,
  ): FileIdentity {
    const fd = this.native.openReadNodeAt(directoryFd, leaf);
    try {
      assertExactRegularFile(fd, entry);
      const info = fstatSync(fd, { bigint: true });
      return { dev: info.dev, ino: info.ino };
    } finally {
      closeSync(fd);
    }
  }

  private assertExactLeaf(
    directoryFd: number,
    leaf: string,
    entry: CandidateProjectionEntryV1,
  ): void {
    const fd = this.native.openReadNodeAt(directoryFd, leaf);
    try {
      assertExactRegularFile(fd, entry);
    } finally {
      closeSync(fd);
    }
  }

  private assertExactLeafIdentity(
    directoryFd: number,
    leaf: string,
    entry: CandidateProjectionEntryV1,
    identity: FileIdentity,
  ): void {
    const fd = this.native.openReadNodeAt(directoryFd, leaf);
    try {
      assertExactRegularFile(fd, entry);
      const info = fstatSync(fd, { bigint: true });
      if (info.dev !== identity.dev || info.ino !== identity.ino) {
        this.leafChanged(
          'The Target mutation moved a replacement inode instead of the checked preimage.',
        );
      }
    } finally {
      closeSync(fd);
    }
  }

  private removeExactTransaction(
    parentFd: number,
    transactionName: string,
    transactionFd: number,
    expectedStage: CandidateProjectionEntryV1,
    marker: TargetTransactionIdentityMarkerV1,
    expectedStageIdentity: FileIdentity,
    committed: boolean,
    stageName: TargetTransactionCleanupArtifactName =
      TRANSACTION_STAGE_NAME,
  ): void {
    this.assertExactLeafIdentity(
      transactionFd,
      stageName,
      expectedStage,
      expectedStageIdentity,
    );
    assertLeafAbsent(
      this.native,
      transactionFd,
      stageName === TRANSACTION_STAGE_NAME
        ? TRANSACTION_QUARANTINE_NAME
        : TRANSACTION_STAGE_NAME,
    );
    this.assertExactTransactionMarker(
      transactionFd,
      TRANSACTION_IDENTITY_NAME,
      transactionIdentityBytes(marker),
    );
    if (committed) {
      this.assertTransactionCommitted(transactionFd, marker);
    } else {
      this.assertTransactionCommittedAbsent(transactionFd);
    }
    this.quarantineTransactionDirectoryForCleanup(
      parentFd,
      transactionName,
      transactionFd,
      marker.transactionId,
      [
        stageName,
        ...(committed
          ? [TRANSACTION_COMMITTED_NAME] as const
          : []),
        TRANSACTION_IDENTITY_NAME,
        TRANSACTION_OWNER_NAME,
      ],
    );
  }

  private removeEmptyTransactionDirectory(
    parentFd: number,
    transactionName: string,
    transactionFd: number,
    marker: TargetTransactionIdentityMarkerV1,
    committed: boolean,
  ): void {
    assertLeafAbsent(
      this.native,
      transactionFd,
      TRANSACTION_STAGE_NAME,
    );
    assertLeafAbsent(
      this.native,
      transactionFd,
      TRANSACTION_QUARANTINE_NAME,
    );
    this.assertExactTransactionMarker(
      transactionFd,
      TRANSACTION_IDENTITY_NAME,
      transactionIdentityBytes(marker),
    );
    if (committed) {
      this.assertTransactionCommitted(transactionFd, marker);
    } else {
      this.assertTransactionCommittedAbsent(transactionFd);
    }
    this.quarantineTransactionDirectoryForCleanup(
      parentFd,
      transactionName,
      transactionFd,
      marker.transactionId,
      [
        ...(committed
          ? [TRANSACTION_COMMITTED_NAME] as const
          : []),
        TRANSACTION_IDENTITY_NAME,
        TRANSACTION_OWNER_NAME,
      ],
    );
  }

  private removeBareTransactionDirectory(
    parentFd: number,
    transactionName: string,
    transactionFd: number,
    transactionId: string,
  ): void {
    assertLeafAbsent(
      this.native,
      transactionFd,
      TRANSACTION_STAGE_NAME,
    );
    assertLeafAbsent(
      this.native,
      transactionFd,
      TRANSACTION_QUARANTINE_NAME,
    );
    if (this.readOptionalTransactionMarker(
      transactionFd,
      TRANSACTION_IDENTITY_NAME,
    ) !== null) {
      this.artifactConflict(
        'A bare Target transaction unexpectedly has an identity marker.',
      );
    }
    this.assertTransactionCommittedAbsent(transactionFd);
    this.quarantineTransactionDirectoryForCleanup(
      parentFd,
      transactionName,
      transactionFd,
      transactionId,
      [TRANSACTION_OWNER_NAME],
    );
  }

  private quarantineTransactionDirectoryForCleanup(
    parentFd: number,
    transactionName: string,
    transactionFd: number,
    transactionId: string,
    artifactNames: readonly TargetTransactionCleanupArtifactName[],
  ): void {
    if (this.readOptionalTransactionMarker(
      transactionFd,
      TRANSACTION_CLEANUP_NAME,
    ) !== null) {
      this.artifactConflict(
        'The Target transaction already has a cleanup manifest.',
      );
    }
    const marker = Object.freeze({
      schemaVersion: 1 as const,
      transactionId,
      artifacts: Object.freeze(artifactNames.map((name) =>
        this.readRequiredCleanupArtifact(transactionFd, name))),
    });
    const markerBytes = transactionCleanupBytes(marker);
    const markerFd = this.native.openExclusiveWritableFileAt(
      transactionFd,
      TRANSACTION_CLEANUP_NAME,
      0o600,
    );
    try {
      writeAll(markerFd, markerBytes);
      fchmodSync(markerFd, 0o600);
      fsyncSync(markerFd);
    } finally {
      closeSync(markerFd);
    }
    fsyncSync(transactionFd);
    this.afterTransactionCleanupPrepared();
    this.resumeTransactionDirectoryCleanup(
      parentFd,
      transactionName,
      transactionCleanupDirectoryName(transactionName),
      transactionFd,
      transactionId,
      false,
    );
  }

  private resumeTransactionDirectoryCleanup(
    parentFd: number,
    transactionName: string,
    cleanupName: string,
    transactionFd: number,
    transactionId: string,
    alreadyQuarantined: boolean,
  ): void {
    const markerBytes = this.readOptionalTransactionMarker(
      transactionFd,
      TRANSACTION_CLEANUP_NAME,
    );
    if (markerBytes === null) {
      if (!alreadyQuarantined) {
        this.artifactConflict(
          'A Target transaction cleanup intent disappeared before quarantine.',
        );
      }
      try {
        this.native.removeDirectoryAt(parentFd, cleanupName);
      } catch (error) {
        if (this.native.isErrno(error, 'ENOTEMPTY')) {
          this.artifactConflict(
            'An unowned Target cleanup quarantine is not empty.',
          );
        }
        throw error;
      }
      fsyncSync(parentFd);
      return;
    }
    let marker: TargetTransactionCleanupMarkerV1;
    try {
      marker = parseTransactionCleanupMarker(markerBytes);
    } catch (error) {
      this.artifactConflict(
        `The Target transaction cleanup manifest is invalid: ${
          error instanceof Error ? error.message : 'unknown'
        }.`,
      );
    }
    if (marker.transactionId !== transactionId) {
      this.artifactConflict(
        'The Target transaction cleanup manifest belongs to another transaction.',
      );
    }
    if (!alreadyQuarantined) {
      const collision = this.openOptionalTransactionDirectory(
        parentFd,
        cleanupName,
      );
      if (collision !== null) {
        closeSync(collision);
        this.artifactConflict(
          'The Target transaction cleanup quarantine already exists.',
        );
      }
      const identity = fstatSync(transactionFd, { bigint: true });
      this.native.renameNoReplace(
        parentFd,
        transactionName,
        parentFd,
        cleanupName,
      );
      fsyncSync(parentFd);
      const quarantined = this.native.openDirectoryAt(
        parentFd,
        cleanupName,
      );
      try {
        if (!sameFileIdentity(
          identity,
          fstatSync(quarantined, { bigint: true }),
        )) {
          this.artifactConflict(
            'The Target cleanup quarantine is not the validated transaction directory.',
          );
        }
      } finally {
        closeSync(quarantined);
      }
      this.afterTransactionCleanupQuarantined();
    }
    for (const expected of marker.artifacts) {
      const actual = this.readOptionalCleanupArtifact(
        transactionFd,
        expected.name,
      );
      if (actual === null) continue;
      if (!sameTransactionCleanupArtifact(actual, expected)) {
        this.artifactConflict(
          `The Target cleanup artifact ${expected.name} changed before removal.`,
        );
      }
      this.native.unlinkAt(transactionFd, expected.name);
      fsyncSync(transactionFd);
      this.afterTransactionCleanupArtifactRemoved(expected.name);
    }
    this.assertExactTransactionMarker(
      transactionFd,
      TRANSACTION_CLEANUP_NAME,
      markerBytes,
    );
    this.native.unlinkAt(transactionFd, TRANSACTION_CLEANUP_NAME);
    fsyncSync(transactionFd);
    this.afterTransactionCleanupMarkerRemoved();
    try {
      this.native.removeDirectoryAt(parentFd, cleanupName);
    } catch (error) {
      if (this.native.isErrno(error, 'ENOTEMPTY')) {
        this.artifactConflict(
          'The Target cleanup quarantine contains an unknown artifact.',
        );
      }
      throw error;
    }
    fsyncSync(parentFd);
  }

  private readRequiredCleanupArtifact(
    transactionFd: number,
    name: TargetTransactionCleanupArtifactName,
  ): TargetTransactionCleanupArtifactV1 {
    const artifact = this.readOptionalCleanupArtifact(transactionFd, name);
    if (artifact === null) {
      this.artifactConflict(
        `The Target cleanup artifact ${name} is missing.`,
      );
    }
    return artifact;
  }

  private readOptionalCleanupArtifact(
    transactionFd: number,
    name: TargetTransactionCleanupArtifactName,
  ): TargetTransactionCleanupArtifactV1 | null {
    let fd: number;
    try {
      fd = this.native.openReadNodeAt(transactionFd, name);
    } catch (error) {
      if (this.native.isErrno(error, 'ENOENT')) return null;
      throw error;
    }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        this.artifactConflict(
          `The Target cleanup artifact ${name} is unsafe.`,
        );
      }
      const bytes = readDescriptorBytes(fd, before.size);
      const after = fstatSync(fd, { bigint: true });
      if (!sameStableFile(before, after)) {
        this.artifactConflict(
          `The Target cleanup artifact ${name} changed during inspection.`,
        );
      }
      return Object.freeze({
        name,
        dev: before.dev.toString(10),
        ino: before.ino.toString(10),
        mode: targetObservedMode(before),
        sizeBytes: before.size.toString(10),
        contentDigest: cleanupArtifactContentDigest(bytes),
      });
    } finally {
      closeSync(fd);
    }
  }

  private rollbackNoReplace(
    oldDirectoryFd: number,
    oldLeaf: string,
    newDirectoryFd: number,
    newLeaf: string,
  ): void {
    try {
      this.native.renameNoReplace(
        oldDirectoryFd,
        oldLeaf,
        newDirectoryFd,
        newLeaf,
      );
      fsyncSync(oldDirectoryFd);
      fsyncSync(newDirectoryFd);
    } catch (error) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_rollback_preserved',
        'Atomic rollback could not restore the original path; both conflicting leaves were preserved.',
        { cause: error },
      );
    }
  }

  private leafChanged(
    message: string,
    options?: ErrorOptions,
  ): never {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_leaf_changed',
      message,
      options,
    );
  }

  private artifactConflict(message: string): never {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_artifact_conflict',
      message,
    );
  }

  private openParent(
    segments: readonly string[],
    createMissing: boolean,
  ): OpenedParent {
    this.assertOpen();
    const leaf = segments.at(-1);
    if (leaf === undefined) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_path_unsafe',
        'A Target promotion path must have a file leaf.',
      );
    }
    let current = this.native.duplicateDirectory(this.rootFd);
    try {
      for (const segment of segments.slice(0, -1)) {
        let next: number;
        try {
          next = this.native.openDirectoryAt(current, segment);
        } catch (error) {
          if (!createMissing || !this.native.isErrno(error, 'ENOENT')) {
            throw error;
          }
          this.native.mkdirAt(current, segment, directoryMode());
          fsyncSync(current);
          next = this.native.openDirectoryAt(current, segment);
        }
        closeSync(current);
        current = next;
      }
      return { fd: current, leaf };
    } catch (error) {
      closeSync(current);
      throw error;
    }
  }

  private assertRootStillSelected(): void {
    const selected = this.native.openRoot(this.rootDirectory);
    try {
      const info = fstatSync(selected, { bigint: true });
      if (!sameFileIdentity(this.rootIdentity, info)) {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_root_changed',
          'The selected Target promotion root changed before mutation.',
        );
      }
    } finally {
      closeSync(selected);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_closed',
        'The Target promotion filesystem session is closed.',
      );
    }
  }
}

class WindowsTargetNative implements TargetHandleNative {
  readonly replaceStrategy = 'quarantine' as const;

  private constructor(
    private readonly koffi: KoffiModule,
    private readonly functions: WindowsTargetFunctions,
  ) {}

  static create(): WindowsTargetNative {
    if (process.platform !== 'win32') {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_platform_unsupported',
        'The Windows Target backend is available only on Windows.',
      );
    }
    const koffi = require('koffi') as KoffiModule;
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    const ucrt = koffi.load('ucrtbase.dll');
    const functions: WindowsTargetFunctions = {
      createFile: kernel32.func(
        'void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)',
      ) as WindowsTargetFunctions['createFile'],
      closeHandle: kernel32.func(
        'int __stdcall CloseHandle(void *)',
      ) as WindowsTargetFunctions['closeHandle'],
      getLastError: kernel32.func(
        'uint32_t __stdcall GetLastError()',
      ) as WindowsTargetFunctions['getLastError'],
      getFinalPathName: kernel32.func(
        'uint32_t __stdcall GetFinalPathNameByHandleW(void *, uint16_t *, uint32_t, uint32_t)',
      ) as WindowsTargetFunctions['getFinalPathName'],
      getFileInformation: kernel32.func(
        'int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)',
      ) as WindowsTargetFunctions['getFileInformation'],
      setFileInformation: kernel32.func(
        'int __stdcall SetFileInformationByHandle(void *, int, void *, uint32_t)',
      ) as WindowsTargetFunctions['setFileInformation'],
      flushFileBuffers: kernel32.func(
        'int __stdcall FlushFileBuffers(void *)',
      ) as WindowsTargetFunctions['flushFileBuffers'],
      ntCreateFile: ntdll.func(
        'int32_t __stdcall NtCreateFile(_Out_ void **, uint32_t, const void *, void *, const int64_t *, uint32_t, uint32_t, uint32_t, uint32_t, void *, uint32_t)',
      ) as WindowsTargetFunctions['ntCreateFile'],
      rtlNtStatusToDosError: ntdll.func(
        'uint32_t __stdcall RtlNtStatusToDosError(uint32_t)',
      ) as WindowsTargetFunctions['rtlNtStatusToDosError'],
      openOsFileHandle: ucrt.func(
        'int _open_osfhandle(intptr_t, int)',
      ) as WindowsTargetFunctions['openOsFileHandle'],
      getOsFileHandle: ucrt.func(
        'intptr_t _get_osfhandle(int)',
      ) as WindowsTargetFunctions['getOsFileHandle'],
    };
    for (const [name, value] of Object.entries(functions)) {
      if (typeof value !== 'function') {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_backend_native_unavailable',
          `The required Windows Target function ${name} is unavailable.`,
        );
      }
    }
    return new WindowsTargetNative(koffi, functions);
  }

  openRoot(path: string): number {
    const canonicalRoot = realpathSync(path);
    let handle: unknown = this.functions.createFile(
      canonicalRoot,
      WINDOWS_GENERIC_READ
        | WINDOWS_GENERIC_WRITE
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_SHARE_ALL,
      null,
      WINDOWS_OPEN_EXISTING,
      WINDOWS_FILE_FLAG_BACKUP_SEMANTICS
        | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
      null,
    );
    if (isInvalidWindowsTargetHandle(this.koffi, handle)) {
      throw this.win32Error(
        'CreateFileW',
        this.functions.getLastError(),
      );
    }
    try {
      this.assertDirectoryHandle(
        handle,
        canonicalRoot,
      );
      const fd = this.adoptHandle(
        handle,
        WINDOWS_O_RDONLY | WINDOWS_O_BINARY,
      );
      handle = null;
      return fd;
    } finally {
      if (!isInvalidWindowsTargetHandle(this.koffi, handle)) {
        this.functions.closeHandle(handle);
      }
    }
  }

  duplicateDirectory(fd: number): number {
    return this.openDirectoryAt(fd, '.');
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
      this.assertDirectoryHandle(handle);
      return this.adoptHandle(
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
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_path_unsafe',
          'A Windows Target path resolved to a reparse point.',
        );
      }
      return this.adoptHandle(
        handle,
        WINDOWS_O_RDONLY | WINDOWS_O_BINARY,
      );
    } catch (error) {
      this.functions.closeHandle(handle);
      throw error;
    }
  }

  openMutationNodeAt(directoryFd: number, name: string): number {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_FILE_READ_DATA
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_DELETE
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_OPEN,
      WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
      if ((this.queryAttributes(handle)
          & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_path_unsafe',
          'A Windows Target mutation resolved to a reparse point.',
        );
      }
      return this.adoptHandle(
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
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_path_unsafe',
          'A Windows Target temporary is a reparse point.',
        );
      }
      return this.adoptHandle(
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
      this.flush(handle);
    } finally {
      this.functions.closeHandle(handle);
    }
  }

  renameNoReplace(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
    sourceFd?: number,
  ): void {
    let ownedHandle: unknown = null;
    const handle = sourceFd === undefined
      ? (
          ownedHandle = this.openRelativeHandle(
            oldDirectoryFd,
            oldName,
            WINDOWS_DELETE
              | WINDOWS_FILE_READ_ATTRIBUTES
              | WINDOWS_SYNCHRONIZE,
            WINDOWS_FILE_OPEN,
            WINDOWS_FILE_OPEN_REPARSE_POINT
              | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
          )
        )
      : this.rawHandle(sourceFd);
    try {
      const renameInfo = buildWindowsHandleRelativeRenameInfo(
        this.rawHandleAddress(newDirectoryFd),
        newName,
        {
          replace: false,
          pointerBytes: process.arch === 'ia32' ? 4 : 8,
        },
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
      if (ownedHandle !== null) {
        this.functions.closeHandle(ownedHandle);
      }
    }
  }

  renameExchange(): void {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_backend_native_unavailable',
      'Windows Target replacement requires the quarantine transaction.',
    );
  }

  unlinkAt(directoryFd: number, name: string): void {
    this.removeNodeAt(directoryFd, name, false);
  }

  removeDirectoryAt(directoryFd: number, name: string): void {
    this.removeNodeAt(directoryFd, name, true);
  }

  assertTransactionDirectory(fd: number, created: boolean): void {
    const before = fstatSync(fd, { bigint: true });
    const path = usableWindowsPath(
      this.finalPath(this.rawHandle(fd)),
    );
    try {
      if (created) {
        protectWindowsPrivateRootSecurity(path);
      } else {
        attestWindowsPrivateRootPathSecurity(path);
      }
    } catch (error) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_artifact_unsafe',
        'The Windows Target transaction directory ACL is unsafe.',
        { cause: error },
      );
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(before, after)) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_artifact_unsafe',
        'The Windows Target transaction directory changed during ACL validation.',
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
    assertWindowsTargetLeaf(name, options?.allowSelf === true);
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
    if (isInvalidWindowsTargetHandle(this.koffi, handle)) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_native_unavailable',
        'NtCreateFile returned an invalid Windows Target handle.',
      );
    }
    return handle;
  }

  private removeNodeAt(
    directoryFd: number,
    name: string,
    directory: boolean,
  ): void {
    const handle = this.openRelativeHandle(
      directoryFd,
      name,
      WINDOWS_DELETE
        | WINDOWS_FILE_READ_ATTRIBUTES
        | WINDOWS_SYNCHRONIZE,
      WINDOWS_FILE_OPEN,
      (directory
        ? WINDOWS_FILE_DIRECTORY_FILE
        : WINDOWS_FILE_NON_DIRECTORY_FILE)
        | WINDOWS_FILE_OPEN_REPARSE_POINT
        | WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT,
    );
    try {
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

  private assertDirectoryHandle(
    handle: unknown,
    expectedPath?: string,
  ): void {
    const attributes = this.queryAttributes(handle);
    if ((attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) === 0
      || (attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0
      || (expectedPath !== undefined
        && normalizeWindowsTargetPath(this.finalPath(handle))
          !== normalizeWindowsTargetPath(expectedPath))) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_path_unsafe',
        'A Windows Target directory handle is unsafe.',
      );
    }
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

  private flush(handle: unknown): void {
    if (this.functions.flushFileBuffers(handle) === 0) {
      throw this.win32Error(
        'FlushFileBuffers',
        this.functions.getLastError(),
      );
    }
  }

  private adoptHandle(handle: unknown, flags: number): number {
    const fd = this.functions.openOsFileHandle(
      this.koffi.address(handle),
      flags,
    );
    if (!Number.isInteger(fd) || fd < 0) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_native_unavailable',
        'The Windows Target handle could not become a Node descriptor.',
      );
    }
    return fd;
  }

  private rawHandle(fd: number): unknown {
    return this.rawHandleAddress(fd);
  }

  private rawHandleAddress(fd: number): bigint {
    const value = this.functions.getOsFileHandle(fd);
    const address = typeof value === 'bigint'
      ? value
      : BigInt(value);
    if (address <= 0n
      || address === invalidWindowsTargetHandleAddress()) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_native_unavailable',
        'The Node descriptor has no valid Windows Target handle.',
      );
    }
    return address;
  }

  private ntStatusError(
    syscall: string,
    status: number,
  ): NodeJS.ErrnoException {
    return this.win32Error(
      syscall,
      this.functions.rtlNtStatusToDosError(status >>> 0),
    );
  }

  private win32Error(
    syscall: string,
    windowsCode: number,
  ): NodeJS.ErrnoException {
    const code = windowsTargetErrorName(windowsCode);
    return Object.assign(
      new Error(`${syscall} failed with ${code}.`),
      { code, errno: windowsCode, syscall },
    );
  }
}

class PosixNative implements TargetHandleNative {
  readonly replaceStrategy = 'exchange' as const;

  private constructor(
    private readonly koffi: KoffiModule,
    private readonly functions: PosixFunctions,
    private readonly errnoNames: ReadonlyMap<number, string>,
    private readonly openConstants: PosixOpenConstants,
  ) {}

  static create(): PosixNative {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_platform_unsupported',
        'Target promotion requires the POSIX openat backend.',
      );
    }
    const koffi = require('koffi') as KoffiModule;
    const libc = koffi.load(null);
    const asNumber = (
      definition: string,
    ): ((...args: readonly unknown[]) => number) => {
      const fn = libc.func(definition);
      return (...args) => Number(fn(...args));
    };
    const functions: PosixFunctions = {
      open: asNumber(
        'int open(const char *pathname, int flags, unsigned int mode)',
      ),
      openat: asNumber(
        'int openat(int dirfd, const char *pathname, int flags, unsigned int mode)',
      ),
      mkdirat: asNumber(
        'int mkdirat(int dirfd, const char *pathname, unsigned int mode)',
      ),
      renameAtomic: process.platform === 'linux'
        ? asNumber(
            'int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)',
          )
        : asNumber(
            'int renameatx_np(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)',
          ),
      unlinkat: asNumber(
        'int unlinkat(int dirfd, const char *pathname, int flags)',
      ),
    };
    const errnoNames = new Map<number, string>();
    for (const [name, value] of Object.entries(koffi.os.errno)) {
      if (!errnoNames.has(value)) errnoNames.set(value, name);
    }
    return new PosixNative(
      koffi,
      functions,
      errnoNames,
      loadPosixOpenConstants(),
    );
  }

  openRoot(path: string): number {
    return this.checkedFd(
      'open',
      this.functions.open(
        path,
        this.openConstants.O_RDONLY
          | this.openConstants.O_DIRECTORY
          | this.openConstants.O_NOFOLLOW
          | this.openConstants.O_CLOEXEC,
        0,
      ),
    );
  }

  duplicateDirectory(fd: number): number {
    return this.openDirectoryAt(fd, '.');
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
    if (!isControlledDirectory(info)) {
      closeSync(fd);
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_path_unsafe',
        'A Target promotion path component is not an owner-controlled directory.',
      );
    }
    return fd;
  }

  openReadNodeAt(directoryFd: number, name: string): number {
    return this.checkedFd(
      'openat',
      this.functions.openat(
        directoryFd,
        name,
        this.openConstants.O_RDONLY
          | this.openConstants.O_NONBLOCK
          | this.openConstants.O_NOFOLLOW
          | this.openConstants.O_CLOEXEC,
        0,
      ),
    );
  }

  openMutationNodeAt(directoryFd: number, name: string): number {
    return this.openReadNodeAt(directoryFd, name);
  }

  openExclusiveWritableFileAt(
    directoryFd: number,
    name: string,
    mode: number,
  ): number {
    return this.checkedFd(
      'openat',
      this.functions.openat(
        directoryFd,
        name,
        this.openConstants.O_WRONLY
          | this.openConstants.O_CREAT
          | this.openConstants.O_EXCL
          | this.openConstants.O_NOFOLLOW
          | this.openConstants.O_CLOEXEC,
        mode,
      ),
    );
  }

  mkdirAt(directoryFd: number, name: string, mode: number): void {
    this.checkedZero(
      'mkdirat',
      this.functions.mkdirat(directoryFd, name, mode),
    );
  }

  renameNoReplace(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
    _sourceFd?: number,
  ): void {
    this.checkedAtomicRename(
      process.platform === 'linux' ? 'renameat2' : 'renameatx_np',
      this.functions.renameAtomic(
        oldDirectoryFd,
        oldName,
        newDirectoryFd,
        newName,
        this.openConstants.RENAME_NOREPLACE,
      ),
    );
  }

  renameExchange(
    oldDirectoryFd: number,
    oldName: string,
    newDirectoryFd: number,
    newName: string,
  ): void {
    this.checkedAtomicRename(
      process.platform === 'linux' ? 'renameat2' : 'renameatx_np',
      this.functions.renameAtomic(
        oldDirectoryFd,
        oldName,
        newDirectoryFd,
        newName,
        this.openConstants.RENAME_EXCHANGE,
      ),
    );
  }

  unlinkAt(directoryFd: number, name: string): void {
    this.checkedZero(
      'unlinkat',
      this.functions.unlinkat(directoryFd, name, 0),
    );
  }

  removeDirectoryAt(directoryFd: number, name: string): void {
    this.checkedZero(
      'unlinkat',
      this.functions.unlinkat(
        directoryFd,
        name,
        this.openConstants.AT_REMOVEDIR,
      ),
    );
  }

  assertTransactionDirectory(fd: number, _created: boolean): void {
    const info = fstatSync(fd, { bigint: true });
    if ((info.mode & 0o777n) !== 0o700n) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_artifact_unsafe',
        'The deterministic Target transaction directory is not private.',
      );
    }
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

  private checkedAtomicRename(
    syscall: string,
    result: number,
  ): void {
    try {
      this.checkedZero(syscall, result);
    } catch (error) {
      if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EXDEV']
        .some((code) => this.isErrno(error, code))) {
        throw new TargetPromotionWorkspaceBackendError(
          'target_promotion_atomic_backend_filesystem_unavailable',
          'The selected Target filesystem does not support the required atomic rename semantics.',
          { cause: error },
        );
      }
      throw error;
    }
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

function isInvalidWindowsTargetHandle(
  koffi: KoffiModule,
  handle: unknown,
): boolean {
  if (handle === null || handle === undefined) return true;
  try {
    const address = koffi.address(handle);
    return address === 0n
      || address === invalidWindowsTargetHandleAddress();
  } catch {
    return true;
  }
}

function invalidWindowsTargetHandleAddress(): bigint {
  return process.arch === 'ia32'
    ? 0xffff_ffffn
    : 0xffff_ffff_ffff_ffffn;
}

function normalizeWindowsTargetPath(value: string): string {
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

function assertWindowsTargetLeaf(
  value: string,
  allowSelf = false,
): void {
  if (allowSelf && value === '.') return;
  if (value === ''
    || value === '.'
    || value === '..'
    || value !== value.normalize('NFC')
    || /[\u0000-\u001F<>:"/\\|?*]/u.test(value)
    || value.endsWith('.')
    || value.endsWith(' ')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
      .test(value)
    || Buffer.byteLength(value, 'utf16le') > 510) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_path_unsafe',
      'The Windows Target handle-relative leaf is unsafe.',
    );
  }
}

function windowsTargetErrorName(windowsCode: number): string {
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

function splitRelativePath(relativePath: string): readonly string[] {
  if (relativePath === ''
    || relativePath.startsWith('/')
    || relativePath.endsWith('/')
    || relativePath.includes('\\')
    || relativePath.includes('\0')) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_path_unsafe',
      'The Target promotion path is not a canonical relative path.',
    );
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) =>
    segment === ''
    || segment === '.'
    || segment === '..'
    || PROTECTED_SEGMENTS.has(segment))) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_path_unsafe',
      'The Target promotion path contains a protected segment.',
    );
  }
  return segments;
}

function absentObservation(): TargetPromotionPathObservationV1 {
  return Object.freeze({
    presence: 'absent',
    fileType: null,
    mode: null,
    contentDigest: null,
  });
}

function absentLeaf(): ObservedLeaf {
  return Object.freeze({
    observation: absentObservation(),
    identity: null,
  });
}

function assertLeafAbsent(
  native: TargetHandleNative,
  parentFd: number,
  leaf: string,
): void {
  let fd: number | undefined;
  try {
    fd = native.openReadNodeAt(parentFd, leaf);
  } catch (error) {
    if (native.isErrno(error, 'ENOENT')) return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  throw new TargetPromotionWorkspaceBackendError(
    'target_promotion_atomic_leaf_changed',
    'The Target promotion destination appeared before mutation.',
  );
}

function assertExactRegularFile(
  fd: number,
  entry: CandidateProjectionEntryV1,
): void {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile()
    || before.nlink !== 1n
    || before.size !== BigInt(entry.sizeBytes)
    || targetObservedMode(before) !== (entry.mode & 0o777)
    || digestExactRegularFile(fd, before) !== entry.contentDigest) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_leaf_changed',
      'The Target promotion file no longer matches its exact preimage.',
    );
  }
}

function readExactRegularFile(
  fd: number,
  entry: CandidateProjectionEntryV1,
): Buffer {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile()
    || before.nlink !== 1n
    || before.size !== BigInt(entry.sizeBytes)
    || targetObservedMode(before) !== (entry.mode & 0o777)) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_leaf_changed',
      'The promotion file no longer matches its exact metadata.',
    );
  }
  const bytes = readDescriptorBytes(fd, before.size);
  const after = fstatSync(fd, { bigint: true });
  if (!sameStableFile(before, after)
    || bytes.byteLength !== entry.sizeBytes
    || digestBytes(bytes) !== entry.contentDigest) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_leaf_changed',
      'The promotion file changed while it was being read.',
    );
  }
  return Buffer.from(bytes);
}

function digestExactRegularFile(
  fd: number,
  before: BigIntStats,
): string {
  const bytes = readDescriptorBytes(fd, before.size);
  const after = fstatSync(fd, { bigint: true });
  if (!sameStableFile(before, after)
    || BigInt(bytes.byteLength) !== before.size) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_leaf_changed',
      'The promotion file changed while it was being hashed.',
    );
  }
  return digestBytes(bytes);
}

function readDescriptorBytes(fd: number, size: bigint): Buffer {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_file_oversized',
      'The promotion file is too large for an exact local read.',
    );
  }
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = readSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (read <= 0) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_leaf_changed',
        'The promotion file ended during an exact read.',
      );
    }
    offset += read;
  }
  return bytes;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update('wukong/candidate-projection-file/v1')
    .update('\0')
    .update(bytes)
    .digest('hex')}`;
}

function writeAll(fd: number, bytes: Uint8Array): void {
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
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_write_failed',
        'The Target promotion write made no progress.',
      );
    }
    offset += written;
  }
}

function loadPosixOpenConstants(): PosixOpenConstants {
  const values = importedFsConstants as unknown as
    Readonly<Record<string, unknown>>;
  for (const name of [
    'O_RDONLY',
    'O_WRONLY',
    'O_CREAT',
    'O_EXCL',
    'O_NONBLOCK',
    'O_DIRECTORY',
    'O_NOFOLLOW',
  ]) {
    if (!Number.isInteger(values[name])) {
      throw new TargetPromotionWorkspaceBackendError(
        'target_promotion_atomic_backend_native_unavailable',
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
    AT_REMOVEDIR: process.platform === 'darwin' ? 0x80 : 0x200,
    RENAME_NOREPLACE:
      process.platform === 'darwin' ? 0x04 : 0x01,
    RENAME_EXCHANGE: 0x02,
  };
}

function directoryMode(): number {
  return 0o755;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function targetObservedMode(info: BigIntStats): number {
  if (process.platform === 'win32') {
    return info.isDirectory() ? 0o755 : 0o644;
  }
  return Number(info.mode & 0o777n);
}

function isControlledDirectory(info: BigIntStats): boolean {
  if (!info.isDirectory()) return false;
  if (process.platform === 'win32') return true;
  return (info.mode & 0o022n) === 0n
    && (typeof process.getuid !== 'function'
      || info.uid === BigInt(process.getuid()));
}

function matchesEntry(
  observation: TargetPromotionPathObservationV1,
  entry: CandidateProjectionEntryV1,
): boolean {
  return observation.presence === 'present'
    && observation.fileType === 'regular'
    && observation.mode === (entry.mode & 0o777)
    && observation.contentDigest === entry.contentDigest;
}

function transactionDirectoryName(transactionId: string): string {
  const matched = TRANSACTION_DIGEST_PATTERN.exec(transactionId);
  if (matched?.[1] === undefined) {
    throw new TargetPromotionWorkspaceBackendError(
      'target_promotion_atomic_transaction_invalid',
      'The Target promotion transaction id is invalid.',
    );
  }
  return `.wukong-apply-${matched[1]}.txn`;
}

function transactionCleanupDirectoryName(
  transactionName: string,
): string {
  return `${transactionName}${TRANSACTION_CLEANUP_SUFFIX}`;
}

function transactionOwnerBytes(transactionId: string): Buffer {
  return Buffer.from(
    `wukong/target-apply-transaction/v1\n${transactionId}\n`,
    'utf8',
  );
}

function transactionCleanupBytes(
  marker: TargetTransactionCleanupMarkerV1,
): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: marker.schemaVersion,
    transactionId: marker.transactionId,
    artifacts: marker.artifacts.map((artifact) => ({
      name: artifact.name,
      dev: artifact.dev,
      ino: artifact.ino,
      mode: artifact.mode,
      sizeBytes: artifact.sizeBytes,
      contentDigest: artifact.contentDigest,
    })),
  })}\n`, 'utf8');
}

function parseTransactionCleanupMarker(
  bytes: Buffer,
): TargetTransactionCleanupMarkerV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8').trimEnd());
  } catch {
    throw new TypeError('JSON could not be parsed');
  }
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)) {
    throw new TypeError('the root is not an object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).toSorted())
    !== JSON.stringify([
      'artifacts',
      'schemaVersion',
      'transactionId',
    ])
    || record['schemaVersion'] !== 1
    || typeof record['transactionId'] !== 'string'
    || !TRANSACTION_DIGEST_PATTERN.test(record['transactionId'])
    || !Array.isArray(record['artifacts'])
    || record['artifacts'].length === 0
    || record['artifacts'].length > 5) {
    throw new TypeError('the cleanup manifest fields are invalid');
  }
  const artifacts =
    record['artifacts'].map(parseTransactionCleanupArtifact);
  if (new Set(artifacts.map((artifact) => artifact.name)).size
    !== artifacts.length) {
    throw new TypeError('the cleanup artifact names are not unique');
  }
  const marker: TargetTransactionCleanupMarkerV1 = Object.freeze({
    schemaVersion: 1,
    transactionId: record['transactionId'],
    artifacts: Object.freeze(artifacts),
  });
  if (!transactionCleanupBytes(marker).equals(bytes)) {
    throw new TypeError('the cleanup manifest is not canonical');
  }
  return marker;
}

function parseTransactionCleanupArtifact(
  value: unknown,
): TargetTransactionCleanupArtifactV1 {
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)) {
    throw new TypeError('a cleanup artifact is not an object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).toSorted())
    !== JSON.stringify([
      'contentDigest',
      'dev',
      'ino',
      'mode',
      'name',
      'sizeBytes',
    ])) {
    throw new TypeError('a cleanup artifact has unknown fields');
  }
  const name = record['name'];
  if ((name !== TRANSACTION_STAGE_NAME
      && name !== TRANSACTION_QUARANTINE_NAME
      && name !== TRANSACTION_OWNER_NAME
      && name !== TRANSACTION_IDENTITY_NAME
      && name !== TRANSACTION_COMMITTED_NAME)
    || typeof record['dev'] !== 'string'
    || !isCanonicalUnsignedInteger(record['dev'])
    || typeof record['ino'] !== 'string'
    || !isCanonicalUnsignedInteger(record['ino'])
    || !Number.isInteger(record['mode'])
    || (record['mode'] as number) < 0
    || (record['mode'] as number) > 0o777
    || typeof record['sizeBytes'] !== 'string'
    || !isCanonicalUnsignedInteger(record['sizeBytes'])
    || typeof record['contentDigest'] !== 'string'
    || !TRANSACTION_DIGEST_PATTERN.test(record['contentDigest'])) {
    throw new TypeError('a cleanup artifact has invalid values');
  }
  return Object.freeze({
    name,
    dev: record['dev'],
    ino: record['ino'],
    mode: record['mode'] as number,
    sizeBytes: record['sizeBytes'],
    contentDigest: record['contentDigest'],
  });
}

function sameTransactionCleanupArtifact(
  left: TargetTransactionCleanupArtifactV1,
  right: TargetTransactionCleanupArtifactV1,
): boolean {
  return left.name === right.name
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.sizeBytes === right.sizeBytes
    && left.contentDigest === right.contentDigest;
}

function cleanupArtifactContentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update('wukong/target-apply-cleanup-artifact/v1')
    .update('\0')
    .update(bytes)
    .digest('hex')}`;
}

function replaceTransactionBinding(
  entry: CandidateProjectionEntryV1,
  expectedPreimage: CandidateProjectionEntryV1 | null,
  transactionId: string,
): TargetTransactionBinding {
  return Object.freeze({
    transactionId,
    operation: expectedPreimage === null ? 'create' : 'replace',
    sourceRelativePath:
      expectedPreimage?.canonicalRelativePath ?? null,
    targetRelativePath: entry.canonicalRelativePath,
    preimageEntryDigest: expectedPreimage?.entryDigest ?? null,
    postimageEntryDigest: entry.entryDigest,
  });
}

function deleteTransactionBinding(
  entry: CandidateProjectionEntryV1,
  transactionId: string,
): TargetTransactionBinding {
  return Object.freeze({
    transactionId,
    operation: 'delete',
    sourceRelativePath: entry.canonicalRelativePath,
    targetRelativePath: null,
    preimageEntryDigest: entry.entryDigest,
    postimageEntryDigest: null,
  });
}

function renameTransactionBinding(
  source: CandidateProjectionEntryV1,
  targetRelativePath: string,
  transactionId: string,
): TargetTransactionBinding {
  return Object.freeze({
    transactionId,
    operation: 'rename',
    sourceRelativePath: source.canonicalRelativePath,
    targetRelativePath,
    preimageEntryDigest: source.entryDigest,
    postimageEntryDigest: null,
  });
}

function serializeFileIdentity(
  identity: FileIdentity | null,
): SerializedFileIdentity | null {
  if (identity === null) return null;
  return Object.freeze({
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
  });
}

function deserializeFileIdentity(
  identity: SerializedFileIdentity | null,
): FileIdentity {
  if (identity === null) {
    throw new TypeError('A Target transaction file identity is required.');
  }
  return Object.freeze({
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino),
  });
}

function sameOptionalIdentity(
  actual: FileIdentity | null,
  expected: SerializedFileIdentity | null,
): boolean {
  if (actual === null || expected === null) {
    return actual === null && expected === null;
  }
  return actual.dev === BigInt(expected.dev)
    && actual.ino === BigInt(expected.ino);
}

function transactionIdentityBytes(
  marker: TargetTransactionIdentityMarkerV1,
): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: marker.schemaVersion,
    transactionId: marker.transactionId,
    operation: marker.operation,
    sourceRelativePath: marker.sourceRelativePath,
    targetRelativePath: marker.targetRelativePath,
    preimageEntryDigest: marker.preimageEntryDigest,
    postimageEntryDigest: marker.postimageEntryDigest,
    preimageIdentity: marker.preimageIdentity,
    stageIdentity: marker.stageIdentity,
  })}\n`, 'utf8');
}

function transactionCommittedBytes(
  marker: TargetTransactionIdentityMarkerV1,
): Buffer {
  const digest = createHash('sha256')
    .update('wukong/target-apply-committed/v1')
    .update('\0')
    .update(transactionIdentityBytes(marker))
    .digest('hex');
  return Buffer.from(
    `wukong/target-apply-committed/v1\nsha256:${digest}\n`,
    'utf8',
  );
}

function parseTransactionIdentityMarker(
  bytes: Buffer,
): TargetTransactionIdentityMarkerV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8').trimEnd());
  } catch {
    throw new TypeError('JSON could not be parsed');
  }
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)) {
    throw new TypeError('the root is not an object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'operation',
    'postimageEntryDigest',
    'preimageEntryDigest',
    'preimageIdentity',
    'schemaVersion',
    'sourceRelativePath',
    'stageIdentity',
    'targetRelativePath',
    'transactionId',
  ];
  if (JSON.stringify(Object.keys(record).toSorted())
    !== JSON.stringify(expectedKeys)) {
    throw new TypeError('the object fields are not exact');
  }
  const operation = record['operation'];
  if (record['schemaVersion'] !== 1
    || typeof record['transactionId'] !== 'string'
    || !TRANSACTION_DIGEST_PATTERN.test(record['transactionId'])
    || (operation !== 'create'
      && operation !== 'replace'
      && operation !== 'delete'
      && operation !== 'rename')
    || !isNullableString(record['sourceRelativePath'])
    || !isNullableString(record['targetRelativePath'])
    || !isNullableDigest(record['preimageEntryDigest'])
    || !isNullableDigest(record['postimageEntryDigest'])
    || !isNullableFileIdentity(record['preimageIdentity'])
    || !isNullableFileIdentity(record['stageIdentity'])) {
    throw new TypeError('the field values are invalid');
  }
  const marker: TargetTransactionIdentityMarkerV1 = Object.freeze({
    schemaVersion: 1,
    transactionId: record['transactionId'],
    operation,
    sourceRelativePath: record['sourceRelativePath'],
    targetRelativePath: record['targetRelativePath'],
    preimageEntryDigest: record['preimageEntryDigest'],
    postimageEntryDigest: record['postimageEntryDigest'],
    preimageIdentity: record['preimageIdentity'],
    stageIdentity: record['stageIdentity'],
  });
  const identitiesMatchOperation = operation === 'create'
    ? marker.preimageIdentity === null
      && marker.stageIdentity !== null
    : operation === 'replace'
      ? marker.preimageIdentity !== null
        && marker.stageIdentity !== null
      : marker.preimageIdentity !== null
        && marker.stageIdentity === null;
  if (!identitiesMatchOperation
    || !transactionIdentityBytes(marker).equals(bytes)) {
    throw new TypeError('the marker is not canonical');
  }
  return marker;
}

function sameTransactionBinding(
  marker: TargetTransactionIdentityMarkerV1,
  binding: TargetTransactionBinding,
): boolean {
  return marker.transactionId === binding.transactionId
    && marker.operation === binding.operation
    && marker.sourceRelativePath === binding.sourceRelativePath
    && marker.targetRelativePath === binding.targetRelativePath
    && marker.preimageEntryDigest === binding.preimageEntryDigest
    && marker.postimageEntryDigest === binding.postimageEntryDigest;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string'
      && TRANSACTION_DIGEST_PATTERN.test(value));
}

function isNullableFileIdentity(
  value: unknown,
): value is SerializedFileIdentity | null {
  if (value === null) return true;
  if (typeof value !== 'object'
    || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).toSorted())
    !== JSON.stringify(['dev', 'ino'])
    || typeof record['dev'] !== 'string'
    || typeof record['ino'] !== 'string') {
    return false;
  }
  return isCanonicalUnsignedInteger(record['dev'])
    && isCanonicalUnsignedInteger(record['ino']);
}

function isCanonicalUnsignedInteger(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= 18_446_744_073_709_551_615n
    && parsed.toString(10) === value;
}
