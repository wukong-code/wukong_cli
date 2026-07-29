import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  inspectSourceSnapshot,
  SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS,
  SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  validateSourceSnapshot,
  type SourceSnapshotV1,
} from '@wukong/verification';

import {
  SnapshotBlobLeaseBindingV1,
  SnapshotBlobLeaseStore,
  type VerifiedSnapshotPayloadViewV1,
} from './snapshot-blob-lease-store';
import {
  WorktreeLeaseBindingV1,
  WorktreeLeaseStore,
  type WorktreeLeaseAuthorityV1,
  type WorktreeMaterializationRecoveryInspectionV1,
} from './worktree-lease-store';
import {
  injectDurableBoundaryTestFault,
  type DurableBoundaryTestFaultCapabilityV1,
  validateDurableBoundaryTestFaultCapability,
} from './durable-boundary-test-fault';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_GIT_RUNTIME_MS = 60_000;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const CANDIDATE_RECORD_FILE = 'candidate.json';
const CANDIDATE_INTENT_FILE = 'candidate-intent.json';
const MAX_PORTABLE_PATH_BYTES = 4_096;
const MAX_PORTABLE_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export type SnapshotCandidateMaterializerErrorCode =
  | 'snapshot_candidate_invalid_input'
  | 'snapshot_candidate_repository_mismatch'
  | 'snapshot_candidate_root_unsafe'
  | 'snapshot_candidate_git_failed'
  | 'snapshot_candidate_tree_unsupported'
  | 'snapshot_candidate_limit'
  | 'snapshot_candidate_write_failed'
  | 'snapshot_candidate_verification_failed';

export class SnapshotCandidateMaterializerError extends Error {
  constructor(
    readonly reasonCode: SnapshotCandidateMaterializerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SnapshotCandidateMaterializerError';
  }
}

export interface SnapshotCandidateMaterializerOptions {
  readonly now?: () => Date;
  /**
   * Process-crash test seam. Production callers must never supply this.
   */
  readonly testFault?: DurableBoundaryTestFaultCapabilityV1;
}

export interface MaterializeSnapshotCandidateInputV1 {
  readonly sourceRepositoryRoot: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly leaseStore: SnapshotBlobLeaseStore;
  readonly confirmedBinding: SnapshotBlobLeaseBindingV1;
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly worktreeLeaseBinding: WorktreeLeaseBindingV1;
}

export interface MaterializedSnapshotCandidateRecordV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly state: 'materialized';
  readonly sourceSnapshotDigest: string;
  readonly snapshotBlobLeaseId: string;
  readonly confirmedBlobLeaseDigest: string;
  readonly worktreeLeaseId: string;
  readonly materializingWorktreeLeaseDigest: string;
  readonly manifestDigest: string;
  readonly materializationPolicyDigest: string;
  readonly repositoryIdentity: string;
  readonly baseCommit: string;
  readonly repositoryRelativeCwd: string;
  readonly candidateBranch: string;
  readonly candidatePathIdentity: string;
  readonly indexDigest: string;
  readonly trackedDeltaDigest: string | null;
  readonly includedUntrackedDigest: string;
  readonly materializedSourceDigest: string;
  readonly createdAt: string;
  readonly recordDigest: string;
}

export interface SnapshotCandidateIntentV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly state: 'creating';
  readonly sourceSnapshotDigest: string;
  readonly snapshotBlobLeaseId: string;
  readonly confirmedBlobLeaseDigest: string;
  readonly worktreeLeaseId: string;
  readonly materializingWorktreeLeaseDigest: string;
  readonly manifestDigest: string;
  readonly materializationPolicyDigest: string;
  readonly repositoryIdentity: string;
  readonly baseCommit: string;
  readonly repositoryRelativeCwd: string;
  readonly candidateBranch: string;
  readonly createdAt: string;
  readonly intentDigest: string;
}

export interface MaterializedSnapshotCandidateV1 {
  /** Trusted internal path. Do not place it in prompt, logs, or public records. */
  readonly candidateDirectory: string;
  readonly candidateRelativeCwd: string;
  readonly record: MaterializedSnapshotCandidateRecordV1;
  readonly worktreeLease: WorktreeLeaseAuthorityV1;
}

export type SnapshotCandidateRecoveryAssessmentV1 =
  | {
      readonly state: 'not_materializing' | 'incomplete' | 'invalid';
      readonly record: null;
    }
  | {
      readonly state: 'recoverable';
      readonly record: MaterializedSnapshotCandidateRecordV1;
    };

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

interface BaseTreeEntry {
  readonly mode: 0o100644 | 0o100755;
  readonly objectId: string;
  readonly sizeBytes: number;
  readonly path: string;
}

/**
 * Creates and verifies a detached candidate from a confirmed private snapshot.
 *
 * The blob is consumed and destroyed before this method returns. No Agent,
 * reviewer, Skill, bootstrap recipe, or user command runs inside the callback.
 */
export class SnapshotCandidateMaterializer {
  private readonly now: () => Date;
  private readonly testFault?: DurableBoundaryTestFaultCapabilityV1;

  constructor(options: SnapshotCandidateMaterializerOptions = {}) {
    if (!isRecord(options)
      || (options['now'] !== undefined && typeof options['now'] !== 'function')
      || (options['testFault'] !== undefined
        && !validateDurableBoundaryTestFaultCapability(
          options['testFault'],
        ))) {
      fail(
        'snapshot_candidate_invalid_input',
        'The candidate materializer options are invalid.',
      );
    }
    this.now = (options['now'] as (() => Date) | undefined) ?? (() => new Date());
    this.testFault = options['testFault'];
  }

  async materialize(
    input: MaterializeSnapshotCandidateInputV1,
  ): Promise<MaterializedSnapshotCandidateV1> {
    if (!isRecord(input)
      || typeof input.sourceRepositoryRoot !== 'string'
      || input.sourceRepositoryRoot.length === 0
      || !validateSourceSnapshot(input.sourceSnapshot)
      || input.sourceSnapshot.exclusions.length > 0
      || !(input.leaseStore instanceof SnapshotBlobLeaseStore)
      || !(input.confirmedBinding instanceof SnapshotBlobLeaseBindingV1)
      || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
      || !(input.worktreeLeaseBinding instanceof WorktreeLeaseBindingV1)) {
      fail(
        'snapshot_candidate_invalid_input',
        'The candidate materialization input is invalid.',
      );
    }
    const sourceRepositoryRoot = await this.assertSourceRepository(
      input.sourceRepositoryRoot,
      input.sourceSnapshot,
    );
    const materializingLease = await input.worktreeLeaseStore.beginMaterialization(
      input.worktreeLeaseBinding,
    );
    const candidateId = materializingLease.lease.candidateId;
    const candidateOwnerDirectory = materializingLease.candidateOwnerDirectory;
    const candidateDirectory = materializingLease.candidateDirectory;
    const createdAt = canonicalTimestamp(this.now());

    const consumed = await input.leaseStore.consumeAndDestroy(
      input.confirmedBinding,
      async (view) => {
        assertViewBinding(input.sourceSnapshot, view);
        await assertPrivateDirectory(candidateOwnerDirectory);
        const intent = createCandidateIntent({
          candidateId,
          sourceSnapshot: input.sourceSnapshot,
          snapshotBlobLeaseId: input.confirmedBinding.blobLeaseId,
          confirmedBlobLeaseDigest: input.confirmedBinding.leaseDigest,
          worktreeLeaseId: materializingLease.lease.leaseId,
          materializingWorktreeLeaseDigest: materializingLease.lease.leaseDigest,
          manifestDigest: view.manifest.manifestDigest,
          candidateBranch: materializingLease.candidateBranch,
          createdAt,
        });
        await writePrivateExclusive(
          join(candidateOwnerDirectory, CANDIDATE_INTENT_FILE),
          canonicalJson(intent),
        );
        await syncDirectory(dirname(candidateOwnerDirectory));
        await syncDirectory(candidateOwnerDirectory);

        await this.createDetachedCandidate(
          sourceRepositoryRoot,
          candidateDirectory,
          input.sourceSnapshot.baseCommit,
          materializingLease.candidateBranch,
        );
        if (process.platform === 'win32') {
          protectWindowsPrivateRootSecurity(candidateDirectory);
        } else {
          await chmod(candidateDirectory, PRIVATE_DIRECTORY_MODE);
        }
        await assertPrivateDirectory(candidateDirectory);
        await this.materializeBaseTree(
          sourceRepositoryRoot,
          candidateDirectory,
          input.sourceSnapshot.baseCommit,
        );
        await this.applyFrozenPostimages(candidateDirectory, view);
        const record = await this.createVerifiedRecord({
          candidateId,
          candidateDirectory,
          sourceSnapshot: input.sourceSnapshot,
          snapshotBlobLeaseId: input.confirmedBinding.blobLeaseId,
          confirmedBlobLeaseDigest: input.confirmedBinding.leaseDigest,
          worktreeLeaseId: materializingLease.lease.leaseId,
          materializingWorktreeLeaseDigest: materializingLease.lease.leaseDigest,
          manifestDigest: view.manifest.manifestDigest,
          createdAt,
          candidateBranch: materializingLease.candidateBranch,
        });
        await writePrivateExclusive(
          join(candidateOwnerDirectory, CANDIDATE_RECORD_FILE),
          canonicalJson(record),
        );
        await syncDirectory(candidateOwnerDirectory);
        await injectDurableBoundaryTestFault(
          this.testFault,
          'snapshot_candidate_after_record_synced',
        );
        return Object.freeze({
          candidateDirectory,
          candidateRelativeCwd: resolveCandidateCwd(
            candidateDirectory,
            input.sourceSnapshot.repositoryRelativeCwd,
          ),
          record,
        });
      },
    );
    const worktreeLease = await input.worktreeLeaseStore.completeMaterialization(
      materializingLease.binding,
      {
        candidatePathIdentity: consumed.result.record.candidatePathIdentity,
        materializedSourceDigest: consumed.result.record.materializedSourceDigest,
        bootstrapRequired: true,
      },
    );
    return {
      ...consumed.result,
      worktreeLease,
    };
  }

  async recoverMaterialized(input: {
    readonly snapshotBlobLeaseStore: SnapshotBlobLeaseStore;
    readonly worktreeLeaseStore: WorktreeLeaseStore;
    readonly worktreeLeaseBinding: WorktreeLeaseBindingV1;
    readonly sourceSnapshot: SourceSnapshotV1;
    readonly bootstrapRequired?: boolean;
  }): Promise<WorktreeLeaseAuthorityV1> {
    if (!isRecord(input)
      || !(input.snapshotBlobLeaseStore instanceof SnapshotBlobLeaseStore)
      || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
      || !(input.worktreeLeaseBinding instanceof WorktreeLeaseBindingV1)
      || !validateSourceSnapshot(input.sourceSnapshot)
      || input.sourceSnapshot.exclusions.length > 0
      || (input.bootstrapRequired !== undefined
        && typeof input.bootstrapRequired !== 'boolean')) {
      fail(
        'snapshot_candidate_invalid_input',
        'The candidate recovery input is invalid.',
      );
    }
    const inspection =
      await input.worktreeLeaseStore.inspectMaterializationRecovery(
        input.worktreeLeaseBinding.candidateId,
      );
    const assessment = assessSnapshotCandidateRecovery(inspection);
    if (assessment.state !== 'recoverable') {
      fail(
        'snapshot_candidate_verification_failed',
        `The candidate materialization is not recoverable (${assessment.state}).`,
      );
    }
    if (input.sourceSnapshot.snapshotDigest
      !== inspection.lease.sourceSnapshotDigest) {
      fail(
        'snapshot_candidate_verification_failed',
        'The recovery snapshot does not match the materializing lease.',
      );
    }
    await input.worktreeLeaseStore.withMaterializingCandidate(
      input.worktreeLeaseBinding,
      async (view) => {
        const verified = await this.createVerifiedRecord({
          candidateId: assessment.record.candidateId,
          candidateDirectory: view.candidateDirectory,
          sourceSnapshot: input.sourceSnapshot,
          snapshotBlobLeaseId: assessment.record.snapshotBlobLeaseId,
          confirmedBlobLeaseDigest:
            assessment.record.confirmedBlobLeaseDigest,
          worktreeLeaseId: assessment.record.worktreeLeaseId,
          materializingWorktreeLeaseDigest:
            assessment.record.materializingWorktreeLeaseDigest,
          manifestDigest: assessment.record.manifestDigest,
          createdAt: assessment.record.createdAt,
          candidateBranch: assessment.record.candidateBranch,
        });
        if (canonicalJson(verified) !== canonicalJson(assessment.record)) {
          fail(
            'snapshot_candidate_verification_failed',
            'The recovered candidate no longer matches its materialized record.',
          );
        }
      },
    );
    await input.snapshotBlobLeaseStore
      .recoverConsumedAfterMaterialization({
        blobLeaseId: assessment.record.snapshotBlobLeaseId,
        ownerRunId: inspection.lease.ownerRunId,
        expectedConfirmedLeaseDigest:
          assessment.record.confirmedBlobLeaseDigest,
        sourceSnapshotDigest: assessment.record.sourceSnapshotDigest,
        manifestDigest: assessment.record.manifestDigest,
      });
    return input.worktreeLeaseStore.completeMaterialization(
      input.worktreeLeaseBinding,
      {
        candidatePathIdentity: assessment.record.candidatePathIdentity,
        materializedSourceDigest: assessment.record.materializedSourceDigest,
        bootstrapRequired: input.bootstrapRequired ?? true,
      },
    );
  }

  private async assertSourceRepository(
    inputRoot: string,
    snapshot: SourceSnapshotV1,
  ): Promise<string> {
    let actualInputRoot: string;
    try {
      actualInputRoot = await realpath(resolve(inputRoot));
    } catch (error) {
      throw wrap(
        'snapshot_candidate_repository_mismatch',
        'The source repository root is unavailable.',
        error,
      );
    }
    const topLevel = await runGit(actualInputRoot, ['rev-parse', '--show-toplevel']);
    if (topLevel.exitCode !== 0) {
      fail(
        'snapshot_candidate_repository_mismatch',
        'The source repository is not a Git worktree.',
      );
    }
    const actualTopLevel = await realpath(singleLine(topLevel.stdout));
    if (actualTopLevel !== actualInputRoot) {
      fail(
        'snapshot_candidate_repository_mismatch',
        'The exact source repository root is required.',
      );
    }
    const repositoryIdentity = await computeRepositoryIdentity(actualTopLevel);
    if (repositoryIdentity !== snapshot.repositoryIdentity) {
      fail(
        'snapshot_candidate_repository_mismatch',
        'The source repository identity does not match the approved snapshot.',
      );
    }
    const commit = await runGit(actualTopLevel, [
      'cat-file', '-e', `${snapshot.baseCommit}^{commit}`,
    ]);
    if (commit.exitCode !== 0) {
      fail(
        'snapshot_candidate_repository_mismatch',
        'The approved base commit is unavailable.',
      );
    }
    return actualTopLevel;
  }

  private async createDetachedCandidate(
    sourceRepositoryRoot: string,
    candidateDirectory: string,
    baseCommit: string,
    candidateBranch: string,
  ): Promise<void> {
    const result = await runGit(sourceRepositoryRoot, [
      'worktree',
      'add',
      '--detach',
      '--no-checkout',
      candidateDirectory,
      baseCommit,
    ]);
    if (result.exitCode !== 0) {
      fail(
        'snapshot_candidate_git_failed',
        'Unable to create the detached candidate worktree.',
      );
    }
    const entries = await readdir(candidateDirectory);
    if (entries.length !== 1 || entries[0] !== '.git') {
      fail(
        'snapshot_candidate_tree_unsupported',
        'The no-checkout candidate was not empty.',
      );
    }
    const readTree = await runGit(candidateDirectory, ['read-tree', baseCommit]);
    if (readTree.exitCode !== 0) {
      fail(
        'snapshot_candidate_git_failed',
        'Unable to initialize the candidate index.',
      );
    }
    const candidateRef = `refs/heads/${candidateBranch}`;
    const createdRef = await runGit(candidateDirectory, [
      'update-ref', candidateRef, baseCommit,
    ]);
    const attachedHead = createdRef.exitCode === 0
      ? await runGit(candidateDirectory, ['symbolic-ref', 'HEAD', candidateRef])
      : createdRef;
    if (createdRef.exitCode !== 0 || attachedHead.exitCode !== 0) {
      fail(
        'snapshot_candidate_git_failed',
        'Unable to attach the internal candidate branch.',
      );
    }
  }

  private async materializeBaseTree(
    sourceRepositoryRoot: string,
    candidateDirectory: string,
    baseCommit: string,
  ): Promise<void> {
    const tree = await runGit(sourceRepositoryRoot, [
      'ls-tree', '-r', '-l', '-z', '--full-tree', baseCommit,
    ]);
    if (tree.exitCode !== 0) {
      fail('snapshot_candidate_git_failed', 'Unable to enumerate the base tree.');
    }
    const entries = parseBaseTree(tree.stdout);
    let totalBytes = 0;
    if (entries.length > SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS.maxBaseEntries) {
      fail('snapshot_candidate_limit', 'The base tree entry limit was exceeded.');
    }
    for (const entry of entries) {
      totalBytes += entry.sizeBytes;
      if (entry.sizeBytes
          > SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS.maxBaseBlobBytes
        || totalBytes
          > SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS.maxBaseTotalBytes) {
        fail('snapshot_candidate_limit', 'The base tree byte limit was exceeded.');
      }
    }
    for (const entry of entries) {
      const blob = await runGit(sourceRepositoryRoot, [
        'cat-file', 'blob', entry.objectId,
      ]);
      if (blob.exitCode !== 0
        || blob.stdout.byteLength !== entry.sizeBytes
        || digestGitBlob(blob.stdout, entry.objectId.length) !== entry.objectId) {
        fail('snapshot_candidate_git_failed', 'A base tree blob is unavailable.');
      }
      assertNotLfsPointer(blob.stdout);
      await writeCandidateFile(
        candidateDirectory,
        entry.path,
        entry.mode,
        blob.stdout,
        false,
      );
    }
  }

  private async applyFrozenPostimages(
    candidateDirectory: string,
    view: VerifiedSnapshotPayloadViewV1,
  ): Promise<void> {
    for (const entry of view.manifest.entries) {
      if (entry.selectedUntracked) {
        if (entry.worktreeImage === null) {
          fail(
            'snapshot_candidate_verification_failed',
            'A selected untracked entry has no worktree image.',
          );
        }
        await writeCandidateFile(
          candidateDirectory,
          entry.canonicalRelativePath,
          entry.worktreeImage.mode,
          view.readImage(entry.worktreeImage),
          true,
        );
        continue;
      }

      await applyIndexPostimage(candidateDirectory, entry.canonicalRelativePath, entry, view);
      if (entry.worktreeImage === null) {
        await removeCandidateFile(candidateDirectory, entry.canonicalRelativePath);
      } else {
        await writeCandidateFile(
          candidateDirectory,
          entry.canonicalRelativePath,
          entry.worktreeImage.mode,
          view.readImage(entry.worktreeImage),
          true,
        );
      }
    }
  }

  private async createVerifiedRecord(input: {
    readonly candidateId: string;
    readonly candidateDirectory: string;
    readonly sourceSnapshot: SourceSnapshotV1;
    readonly snapshotBlobLeaseId: string;
    readonly confirmedBlobLeaseDigest: string;
    readonly worktreeLeaseId: string;
    readonly materializingWorktreeLeaseDigest: string;
    readonly manifestDigest: string;
    readonly createdAt: string;
    readonly candidateBranch: string;
  }): Promise<MaterializedSnapshotCandidateRecordV1> {
    const candidateRelativeCwd = resolveCandidateCwd(
      input.candidateDirectory,
      input.sourceSnapshot.repositoryRelativeCwd,
    );
    const selectedUntrackedPaths = input.sourceSnapshot.includedUntracked.map(
      (entry) => entry.canonicalRelativePath,
    );
    const inspected = await inspectSourceSnapshot({
      cwd: candidateRelativeCwd,
      selectedUntrackedPaths,
      limits: input.sourceSnapshot.snapshotLimits,
    });
    const candidate = inspected.proposedSnapshot;
    if (inspected.status !== 'ready'
      || candidate === null
      || inspected.untrackedDiscoveryTruncated
      || inspected.untrackedCandidateCount !== selectedUntrackedPaths.length
      || candidate.branchName !== input.candidateBranch
      || candidate.repositoryIdentity !== input.sourceSnapshot.repositoryIdentity
      || candidate.repositoryRelativeCwd
        !== input.sourceSnapshot.repositoryRelativeCwd
      || candidate.baseCommit !== input.sourceSnapshot.baseCommit
      || candidate.headTreeDigest !== input.sourceSnapshot.headTreeDigest
      || candidate.indexDigest !== input.sourceSnapshot.indexDigest
      || candidate.trackedDeltaDigest !== input.sourceSnapshot.trackedDeltaDigest
      || canonicalJson(candidate.includedUntracked)
        !== canonicalJson(input.sourceSnapshot.includedUntracked)
      || candidate.exclusions.length > 0) {
      fail(
        'snapshot_candidate_verification_failed',
        'The candidate does not reproduce the approved source projection.',
      );
    }
    const candidatePathIdentity = await computeCandidatePathIdentity(
      input.candidateDirectory,
    );
    const includedUntrackedDigest = canonicalDigest(
      'wukong/materialized-source-untracked/v1',
      candidate.includedUntracked,
    );
    const materializedCore = {
      sourceSnapshotDigest: input.sourceSnapshot.snapshotDigest,
      snapshotBlobLeaseId: input.snapshotBlobLeaseId,
      confirmedBlobLeaseDigest: input.confirmedBlobLeaseDigest,
      worktreeLeaseId: input.worktreeLeaseId,
      materializingWorktreeLeaseDigest: input.materializingWorktreeLeaseDigest,
      manifestDigest: input.manifestDigest,
      materializationPolicyDigest: SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
      repositoryIdentity: candidate.repositoryIdentity,
      baseCommit: candidate.baseCommit,
      repositoryRelativeCwd: candidate.repositoryRelativeCwd,
      candidateBranch: input.candidateBranch,
      candidatePathIdentity,
      indexDigest: candidate.indexDigest,
      trackedDeltaDigest: candidate.trackedDeltaDigest,
      includedUntrackedDigest,
    };
    const recordCore = {
      schemaVersion: 1 as const,
      candidateId: input.candidateId,
      state: 'materialized' as const,
      ...materializedCore,
      materializedSourceDigest: canonicalDigest(
        'wukong/materialized-source/v1',
        materializedCore,
      ),
      createdAt: input.createdAt,
    };
    const record: MaterializedSnapshotCandidateRecordV1 = {
      ...recordCore,
      recordDigest: canonicalDigest(
        'wukong/materialized-source-record/v1',
        recordCore,
      ),
    };
    return Object.freeze(record);
  }
}

export function validateMaterializedSnapshotCandidateRecord(
  value: unknown,
): value is MaterializedSnapshotCandidateRecordV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'baseCommit',
      'candidateId',
      'candidatePathIdentity',
      'candidateBranch',
      'confirmedBlobLeaseDigest',
      'createdAt',
      'includedUntrackedDigest',
      'indexDigest',
      'manifestDigest',
      'materializationPolicyDigest',
      'materializingWorktreeLeaseDigest',
      'materializedSourceDigest',
      'recordDigest',
      'repositoryIdentity',
      'repositoryRelativeCwd',
      'schemaVersion',
      'snapshotBlobLeaseId',
      'sourceSnapshotDigest',
      'state',
      'trackedDeltaDigest',
      'worktreeLeaseId',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || value['state'] !== 'materialized'
    || !isUuid(value['candidateId'])
    || !isUuid(value['snapshotBlobLeaseId'])
    || !isUuid(value['worktreeLeaseId'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['confirmedBlobLeaseDigest'])
    || !isDigest(value['materializingWorktreeLeaseDigest'])
    || !isDigest(value['manifestDigest'])
    || value['materializationPolicyDigest'] !== SNAPSHOT_MATERIALIZATION_POLICY_DIGEST
    || !isDigest(value['repositoryIdentity'])
    || !isGitObjectId(value['baseCommit'])
    || typeof value['repositoryRelativeCwd'] !== 'string'
    || (value['repositoryRelativeCwd'] !== '.'
      && !isPortableRelativePath(value['repositoryRelativeCwd']))
    || typeof value['candidateBranch'] !== 'string'
    || value['candidateBranch'] !== `wukong/candidate/${value['candidateId']}`
    || !isDigest(value['candidatePathIdentity'])
    || !isDigest(value['indexDigest'])
    || (value['trackedDeltaDigest'] !== null
      && !isDigest(value['trackedDeltaDigest']))
    || !isDigest(value['includedUntrackedDigest'])
    || !isDigest(value['materializedSourceDigest'])
    || !isCanonicalTimestamp(value['createdAt'])
    || !isDigest(value['recordDigest'])) {
    return false;
  }
  const materializedCore = {
    sourceSnapshotDigest: value['sourceSnapshotDigest'],
    snapshotBlobLeaseId: value['snapshotBlobLeaseId'],
    confirmedBlobLeaseDigest: value['confirmedBlobLeaseDigest'],
    worktreeLeaseId: value['worktreeLeaseId'],
    materializingWorktreeLeaseDigest: value['materializingWorktreeLeaseDigest'],
    manifestDigest: value['manifestDigest'],
    materializationPolicyDigest: value['materializationPolicyDigest'],
    repositoryIdentity: value['repositoryIdentity'],
    baseCommit: value['baseCommit'],
    repositoryRelativeCwd: value['repositoryRelativeCwd'],
    candidateBranch: value['candidateBranch'],
    candidatePathIdentity: value['candidatePathIdentity'],
    indexDigest: value['indexDigest'],
    trackedDeltaDigest: value['trackedDeltaDigest'],
    includedUntrackedDigest: value['includedUntrackedDigest'],
  };
  if (canonicalDigest('wukong/materialized-source/v1', materializedCore)
    !== value['materializedSourceDigest']) {
    return false;
  }
  const { recordDigest, ...recordCore } =
    value as unknown as MaterializedSnapshotCandidateRecordV1;
  return canonicalDigest('wukong/materialized-source-record/v1', recordCore)
    === recordDigest;
}

export function validateSnapshotCandidateIntent(
  value: unknown,
): value is SnapshotCandidateIntentV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'baseCommit',
      'candidateId',
      'confirmedBlobLeaseDigest',
      'createdAt',
      'intentDigest',
      'manifestDigest',
      'materializationPolicyDigest',
      'materializingWorktreeLeaseDigest',
      'repositoryIdentity',
      'repositoryRelativeCwd',
      'schemaVersion',
      'snapshotBlobLeaseId',
      'sourceSnapshotDigest',
      'state',
      'worktreeLeaseId',
      'candidateBranch',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || value['state'] !== 'creating'
    || !isUuid(value['candidateId'])
    || !isUuid(value['snapshotBlobLeaseId'])
    || !isUuid(value['worktreeLeaseId'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['confirmedBlobLeaseDigest'])
    || !isDigest(value['materializingWorktreeLeaseDigest'])
    || !isDigest(value['manifestDigest'])
    || value['materializationPolicyDigest'] !== SNAPSHOT_MATERIALIZATION_POLICY_DIGEST
    || !isDigest(value['repositoryIdentity'])
    || !isGitObjectId(value['baseCommit'])
    || typeof value['repositoryRelativeCwd'] !== 'string'
    || (value['repositoryRelativeCwd'] !== '.'
      && !isPortableRelativePath(value['repositoryRelativeCwd']))
    || typeof value['candidateBranch'] !== 'string'
    || value['candidateBranch'] !== `wukong/candidate/${value['candidateId']}`
    || !isCanonicalTimestamp(value['createdAt'])
    || !isDigest(value['intentDigest'])) {
    return false;
  }
  const { intentDigest, ...core } = value as unknown as SnapshotCandidateIntentV1;
  return canonicalDigest('wukong/snapshot-candidate-intent/v1', core)
    === intentDigest;
}

export function assessSnapshotCandidateRecovery(
  inspection: WorktreeMaterializationRecoveryInspectionV1,
): SnapshotCandidateRecoveryAssessmentV1 {
  if (inspection.lease.state !== 'materializing'
    || inspection.state === 'not_materializing') {
    return { state: 'not_materializing', record: null };
  }
  if (inspection.state !== 'materialized_record_present') {
    return {
      state: inspection.state === 'materialization_inconsistent'
        ? 'invalid'
        : 'incomplete',
      record: null,
    };
  }
  if (!validateSnapshotCandidateIntent(inspection.intent)
    || !validateMaterializedSnapshotCandidateRecord(inspection.record)
    || inspection.candidatePathIdentity === null) {
    return { state: 'invalid', record: null };
  }
  const lease = inspection.lease;
  const intent = inspection.intent;
  const record = inspection.record;
  const materializingLeaseDigestMatches =
    intent.materializingWorktreeLeaseDigest
      === record.materializingWorktreeLeaseDigest
    && (record.materializingWorktreeLeaseDigest
        === lease.leaseDigest
      || inspection.ownershipAncestors.some(
        (ancestor) => ancestor.state === 'materializing'
          && ancestor.leaseDigest
            === record.materializingWorktreeLeaseDigest,
      ));
  const commonBindingMatches =
    intent.candidateId === lease.candidateId
    && record.candidateId === lease.candidateId
    && intent.worktreeLeaseId === lease.leaseId
    && record.worktreeLeaseId === lease.leaseId
    && materializingLeaseDigestMatches
    && intent.sourceSnapshotDigest === lease.sourceSnapshotDigest
    && record.sourceSnapshotDigest === lease.sourceSnapshotDigest
    && intent.snapshotBlobLeaseId === lease.snapshotBlobLeaseId
    && record.snapshotBlobLeaseId === lease.snapshotBlobLeaseId
    && intent.confirmedBlobLeaseDigest === lease.snapshotBlobLeaseDigest
    && record.confirmedBlobLeaseDigest === lease.snapshotBlobLeaseDigest
    && intent.manifestDigest === lease.manifestDigest
    && record.manifestDigest === lease.manifestDigest
    && intent.materializationPolicyDigest === lease.materializationPolicyDigest
    && record.materializationPolicyDigest === lease.materializationPolicyDigest
    && intent.repositoryIdentity === lease.repositoryIdentity
    && record.repositoryIdentity === lease.repositoryIdentity
    && intent.baseCommit === lease.baseCommit
    && record.baseCommit === lease.baseCommit
    && intent.repositoryRelativeCwd === lease.repositoryRelativeCwd
    && record.repositoryRelativeCwd === lease.repositoryRelativeCwd
    && intent.candidateBranch === lease.candidateBranch
    && record.candidateBranch === lease.candidateBranch
    && intent.createdAt === record.createdAt
    && record.candidatePathIdentity === inspection.candidatePathIdentity;
  return commonBindingMatches
    ? { state: 'recoverable', record }
    : { state: 'invalid', record: null };
}

function createCandidateIntent(input: {
  readonly candidateId: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly snapshotBlobLeaseId: string;
  readonly confirmedBlobLeaseDigest: string;
  readonly worktreeLeaseId: string;
  readonly materializingWorktreeLeaseDigest: string;
  readonly manifestDigest: string;
  readonly candidateBranch: string;
  readonly createdAt: string;
}): SnapshotCandidateIntentV1 {
  const core = {
    schemaVersion: 1 as const,
    candidateId: input.candidateId,
    state: 'creating' as const,
    sourceSnapshotDigest: input.sourceSnapshot.snapshotDigest,
    snapshotBlobLeaseId: input.snapshotBlobLeaseId,
    confirmedBlobLeaseDigest: input.confirmedBlobLeaseDigest,
    worktreeLeaseId: input.worktreeLeaseId,
    materializingWorktreeLeaseDigest: input.materializingWorktreeLeaseDigest,
    manifestDigest: input.manifestDigest,
    materializationPolicyDigest: SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
    repositoryIdentity: input.sourceSnapshot.repositoryIdentity,
    baseCommit: input.sourceSnapshot.baseCommit,
    repositoryRelativeCwd: input.sourceSnapshot.repositoryRelativeCwd,
    candidateBranch: input.candidateBranch,
    createdAt: input.createdAt,
  };
  return Object.freeze({
    ...core,
    intentDigest: canonicalDigest('wukong/snapshot-candidate-intent/v1', core),
  });
}

async function applyIndexPostimage(
  candidateDirectory: string,
  path: string,
  entry: VerifiedSnapshotPayloadViewV1['manifest']['entries'][number],
  view: VerifiedSnapshotPayloadViewV1,
): Promise<void> {
  if (entry.indexImage === null) {
    const removed = await runGit(candidateDirectory, [
      'update-index', '--force-remove', '--', path,
    ]);
    if (removed.exitCode !== 0) {
      fail('snapshot_candidate_git_failed', 'Unable to remove a candidate index entry.');
    }
    return;
  }
  if (entry.indexObjectId === null) {
    fail(
      'snapshot_candidate_verification_failed',
      'A candidate index postimage has no Git object ID.',
    );
  }
  const expected = view.readImage(entry.indexImage);
  assertNotLfsPointer(expected);
  if (digestGitBlob(expected, entry.indexObjectId.length) !== entry.indexObjectId) {
    fail(
      'snapshot_candidate_verification_failed',
      'A candidate index postimage has an invalid Git object ID.',
    );
  }
  const object = await runGit(candidateDirectory, [
    'cat-file', 'blob', entry.indexObjectId,
  ]);
  if (object.exitCode !== 0 || !object.stdout.equals(Buffer.from(expected))) {
    fail(
      'snapshot_candidate_git_failed',
      'The frozen candidate index object is unavailable.',
    );
  }
  const updated = await runGit(candidateDirectory, [
    'update-index',
    '--add',
    '--cacheinfo',
    entry.indexImage.mode.toString(8),
    entry.indexObjectId,
    path,
  ]);
  if (updated.exitCode !== 0) {
    fail('snapshot_candidate_git_failed', 'Unable to update the candidate index.');
  }
}

function assertViewBinding(
  snapshot: SourceSnapshotV1,
  view: VerifiedSnapshotPayloadViewV1,
): void {
  if (view.manifest.sourceSnapshotDigest !== snapshot.snapshotDigest
    || view.manifest.snapshotPolicyDigest !== snapshot.snapshotPolicyDigest
    || view.manifest.materializationPolicyDigest
      !== SNAPSHOT_MATERIALIZATION_POLICY_DIGEST) {
    fail(
      'snapshot_candidate_verification_failed',
      'The private snapshot view does not match the materialization request.',
    );
  }
}

function parseBaseTree(input: Buffer): readonly BaseTreeEntry[] {
  const records = parseNulRecords(input);
  const paths: string[] = [];
  const entries: BaseTreeEntry[] = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      fail('snapshot_candidate_tree_unsupported', 'A base tree entry is invalid.');
    }
    const metadata = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40,64})\s+([0-9-]+)$/u
      .exec(record.slice(0, tab));
    const path = record.slice(tab + 1);
    assertPortableRelativePath(path);
    const mode = metadata?.[1];
    const type = metadata?.[2];
    const objectId = metadata?.[3];
    const sizeText = metadata?.[4];
    const sizeBytes = Number(sizeText);
    if (metadata === null
      || type !== 'blob'
      || (mode !== '100644' && mode !== '100755')
      || !isGitObjectId(objectId)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0) {
      fail(
        'snapshot_candidate_tree_unsupported',
        'The base tree contains an unsupported entry.',
      );
    }
    paths.push(path);
    entries.push({
      mode: Number.parseInt(mode, 8) as 0o100644 | 0o100755,
      objectId,
      sizeBytes,
      path,
    });
  }
  assertNoPortableCollisions(paths);
  return entries;
}

async function writeCandidateFile(
  candidateRoot: string,
  path: string,
  mode: 0o100644 | 0o100755,
  bytes: Uint8Array,
  replace: boolean,
): Promise<void> {
  assertNotLfsPointer(bytes);
  assertPortableRelativePath(path);
  const absolutePath = resolve(candidateRoot, path);
  if (!isInside(candidateRoot, absolutePath)) {
    fail('snapshot_candidate_root_unsafe', 'A candidate path escaped its root.');
  }
  await ensureCandidateParents(candidateRoot, dirname(path));
  const parent = dirname(absolutePath);
  const existing = await lstatOrNull(absolutePath);
  if (existing !== null) {
    if (!replace
      || existing.isSymbolicLink()
      || !existing.isFile()
      || existing.nlink !== 1) {
      fail(
        'snapshot_candidate_write_failed',
        'A candidate destination has an unsafe existing identity.',
      );
    }
  }
  const temporary = join(
    parent,
    `.wukong-materialize-${randomBytes(16).toString('hex')}.tmp`,
  );
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode === 0o100755 ? 0o755 : 0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, absolutePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw wrap(
      'snapshot_candidate_write_failed',
      'Unable to atomically install a candidate file.',
      error,
    );
  }
  const installed = await lstat(absolutePath);
  if (!installed.isFile()
    || installed.isSymbolicLink()
    || installed.nlink !== 1
    || installed.size !== bytes.byteLength
    || gitMode(installed.mode) !== mode) {
    fail(
      'snapshot_candidate_write_failed',
      'A candidate file failed its post-write identity check.',
    );
  }
  const installedBytes = await readFile(absolutePath);
  if (!installedBytes.equals(Buffer.from(bytes))) {
    fail(
      'snapshot_candidate_write_failed',
      'A candidate file failed its post-write content check.',
    );
  }
  await syncDirectory(parent);
}

async function removeCandidateFile(candidateRoot: string, path: string): Promise<void> {
  assertPortableRelativePath(path);
  const absolutePath = resolve(candidateRoot, path);
  if (!isInside(candidateRoot, absolutePath)) {
    fail('snapshot_candidate_root_unsafe', 'A candidate path escaped its root.');
  }
  await assertCandidateParents(candidateRoot, dirname(path));
  const existing = await lstatOrNull(absolutePath);
  if (existing === null) return;
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
    fail(
      'snapshot_candidate_write_failed',
      'A candidate deletion target has an unsafe identity.',
    );
  }
  await unlink(absolutePath);
  await syncDirectory(dirname(absolutePath));
}

async function ensureCandidateParents(candidateRoot: string, relativeParent: string): Promise<void> {
  if (relativeParent === '.') return;
  let current = candidateRoot;
  for (const segment of relativeParent.split('/')) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(
        'snapshot_candidate_write_failed',
        'A candidate parent path is unsafe.',
      );
    }
  }
}

async function assertCandidateParents(
  candidateRoot: string,
  relativeParent: string,
): Promise<void> {
  if (relativeParent === '.') return;
  let current = candidateRoot;
  for (const segment of relativeParent.split('/')) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(
        'snapshot_candidate_write_failed',
        'A candidate parent path is unsafe.',
      );
    }
  }
}

function resolveCandidateCwd(candidateRoot: string, relativeCwd: string): string {
  if (relativeCwd === '.') return candidateRoot;
  assertPortableRelativePath(relativeCwd);
  const candidateCwd = resolve(candidateRoot, relativeCwd);
  if (!isInside(candidateRoot, candidateCwd)) {
    fail('snapshot_candidate_root_unsafe', 'The candidate cwd escaped its root.');
  }
  return candidateCwd;
}

async function computeRepositoryIdentity(root: string): Promise<string> {
  const [commonDirResult, objectFormat] = await Promise.all([
    runGit(root, ['rev-parse', '--git-common-dir']),
    runGit(root, ['rev-parse', '--show-object-format']),
  ]);
  if (commonDirResult.exitCode !== 0 || objectFormat.exitCode !== 0) {
    fail(
      'snapshot_candidate_repository_mismatch',
      'Unable to resolve the source repository identity.',
    );
  }
  const commonDirValue = singleLine(commonDirResult.stdout);
  const commonDir = await realpath(isAbsolute(commonDirValue)
    ? commonDirValue
    : resolve(root, commonDirValue));
  const commonDirStat = await stat(commonDir, { bigint: true });
  return canonicalDigest('wukong/repository-identity/v1', {
    commonDirPathDigest: canonicalDigest('wukong/private-path/v1', commonDir),
    device: commonDirStat.dev.toString(),
    inode: commonDirStat.ino.toString(),
    objectFormat: singleLine(objectFormat.stdout),
  });
}

async function computeCandidatePathIdentity(candidateDirectory: string): Promise<string> {
  const [actualPath, info] = await Promise.all([
    realpath(candidateDirectory),
    stat(candidateDirectory, { bigint: true }),
  ]);
  return canonicalDigest('wukong/candidate-path-identity/v1', {
    pathDigest: canonicalDigest('wukong/private-path/v1', actualPath),
    device: info.dev.toString(),
    inode: info.ino.toString(),
  });
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('snapshot_candidate_root_unsafe', 'A candidate directory is unsafe.');
  }
  if (process.platform !== 'win32') {
    if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      fail('snapshot_candidate_root_unsafe', 'A candidate directory is not mode 0700.');
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      fail('snapshot_candidate_root_unsafe', 'A candidate directory has another owner.');
    }
  } else {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch (error) {
      throw new SnapshotCandidateMaterializerError(
        'snapshot_candidate_root_unsafe',
        'A candidate directory has an unsafe Windows ACL.',
        { cause: error },
      );
    }
  }
}

async function writePrivateExclusive(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseNulRecords(input: Buffer): readonly string[] {
  const text = input.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(input)) {
    fail('snapshot_candidate_tree_unsupported', 'Git returned a non-UTF-8 path.');
  }
  if (text.length === 0) return [];
  const records = text.split('\0');
  if (records.at(-1) !== '') {
    fail('snapshot_candidate_tree_unsupported', 'Git returned an unterminated path.');
  }
  records.pop();
  return records;
}

function assertPortableRelativePath(path: string): void {
  if (!isPortableRelativePath(path)) {
    fail('snapshot_candidate_tree_unsupported', 'A candidate path is not portable.');
  }
}

function isPortableRelativePath(path: string): boolean {
  if (path.length === 0
    || path !== path.normalize('NFC')
    || path.includes('\0')
    || path.includes('\\')
    || isAbsolute(path)
    || /[\u0000-\u001F\u007F]/u.test(path)
    || Buffer.byteLength(path, 'utf8') > MAX_PORTABLE_PATH_BYTES) return false;
  const segments = path.split('/');
  return !segments.some((segment) =>
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.toLowerCase() === '.git'
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || WINDOWS_RESERVED_CHARACTERS.test(segment)
    || WINDOWS_RESERVED_DEVICE.test(segment)
    || Buffer.byteLength(segment, 'utf8') > MAX_PORTABLE_SEGMENT_BYTES);
}

function assertNoPortableCollisions(paths: readonly string[]): void {
  const exact = new Set<string>();
  const portable = new Set<string>();
  for (const path of paths) {
    const portablePath = path.normalize('NFC').toLowerCase();
    if (exact.has(path) || portable.has(portablePath)) {
      fail(
        'snapshot_candidate_tree_unsupported',
        'The base tree has a portable path collision.',
      );
    }
    exact.add(path);
    portable.add(portablePath);
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      'git',
      [
        '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false',
        '-c', `core.attributesFile=${GIT_NULL_DEVICE}`,
        '-c', `core.hooksPath=${GIT_NULL_DEVICE}`,
        '-c', 'core.autocrlf=false',
        '-c', 'core.eol=lf',
        '-c', 'credential.helper=',
        '-c', 'maintenance.auto=false',
        ...args,
      ],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: MAX_GIT_RUNTIME_MS,
        env: sanitizedGitEnvironment(),
      },
      (error, stdout) => {
        if (error === null) {
          resolveResult({
            exitCode: 0,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          });
          return;
        }
        if (typeof error.code !== 'number') {
          rejectResult(error);
          return;
        }
        resolveResult({
          exitCode: error.code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        });
      },
    );
  });
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        !key.toUpperCase().startsWith('GIT_')),
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

function digestGitBlob(content: Uint8Array, objectIdLength: number): string {
  const algorithm = objectIdLength === 40 ? 'sha1' : objectIdLength === 64 ? 'sha256' : null;
  if (algorithm === null) return '';
  return createHash(algorithm)
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function assertNotLfsPointer(content: Uint8Array): void {
  const prefix = Buffer.from(content).subarray(0, 256).toString('utf8');
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:/u.test(prefix)) {
    fail(
      'snapshot_candidate_tree_unsupported',
      'Git LFS pointer materialization is unsupported.',
    );
  }
}

function gitMode(mode: number): 0o100644 | 0o100755 {
  return (mode & 0o111) === 0 ? 0o100644 : 0o100755;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string'
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function singleLine(input: Buffer): string {
  return input.toString('utf8').trim();
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('snapshot_candidate_invalid_input', 'The candidate clock is invalid.');
  }
  return value.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function wrap(
  code: SnapshotCandidateMaterializerErrorCode,
  message: string,
  cause: unknown,
): SnapshotCandidateMaterializerError {
  return new SnapshotCandidateMaterializerError(code, message, { cause });
}

function fail(code: SnapshotCandidateMaterializerErrorCode, message: string): never {
  throw new SnapshotCandidateMaterializerError(code, message);
}
