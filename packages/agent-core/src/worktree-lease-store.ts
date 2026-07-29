import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  adoptWorktreeLease,
  canonicalDigest,
  canonicalJson,
  containsSensitiveText,
  createWorktreeLease,
  transitionWorktreeLease,
  validateInitialWorktreeLease,
  validateSnapshotBlobLease,
  validateSourceSnapshot,
  validateWorktreeLease,
  validateWorktreeLeaseEvent,
  validateWorktreeLeaseTransition,
  type SnapshotBlobLeaseV1,
  type SourceSnapshotV1,
  type WorktreeLeaseEventV1,
  type WorktreeLeaseStateV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

import {
  assertCandidateWorkspacePathPolicyPlan,
  bindCandidateWorkspaceGuard,
  type CandidateWorkspacePathPolicyV1,
  type WorkspaceConfig,
} from './tools/support/workspace';
import {
  captureProcessLivenessProof,
  probeProcessLiveness,
  validateProcessLivenessProof,
  type ProcessLivenessOutcome,
  type ProcessLivenessProofV1,
} from './process-liveness-proof';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEASE_FILE = 'worktree-lease.json';
const CAPABILITY_FILE = 'worktree-capability.json';
const EVENTS_DIRECTORY = 'worktree-events';
const LOCK_SENTINEL = 'worktree-lock';
const WORKTREE_DIRECTORY = 'worktree';
const CANDIDATE_INTENT_FILE = 'candidate-intent.json';
const CANDIDATE_RECORD_FILE = 'candidate.json';
const OWNERSHIP_PENDING_FILE = 'worktree-ownership-pending.json';
const BOOTSTRAP_PRIVATE_DIRECTORY = 'bootstrap-private';
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITY_BYTES = 4 * 1024;
const EVENT_FILE_PATTERN = /^([0-9]{12})\.json$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_GIT_RUNTIME_MS = 30_000;

const rawFencingTokens = new WeakMap<WorktreeLeaseBindingV1, string>();
const rootCapabilities = new WeakMap<CandidateRootCapabilityV1, {
  readonly candidateDirectory: string;
  readonly candidateRelativeCwd: string;
  readonly rawFencingToken: string;
}>();

export type WorktreeLeaseStoreErrorCode =
  | 'worktree_lease_invalid_input'
  | 'worktree_lease_not_found'
  | 'worktree_lease_integrity_failed'
  | 'worktree_lease_stale_binding'
  | 'worktree_lease_invalid_state'
  | 'worktree_lease_expired'
  | 'worktree_lease_owner_live'
  | 'worktree_lease_liveness_unproven'
  | 'worktree_lease_root_unsafe'
  | 'worktree_lease_lock_failed';

export class WorktreeLeaseStoreError extends Error {
  constructor(
    readonly reasonCode: WorktreeLeaseStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorktreeLeaseStoreError';
  }
}

export class WorktreeLeaseBindingV1 {
  readonly leaseId: string;
  readonly candidateId: string;
  readonly ownerRunId: string;
  readonly casRevision: number;
  readonly leaseDigest: string;

  private constructor(lease: WorktreeLeaseV1, rawFencingToken: string) {
    this.leaseId = lease.leaseId;
    this.candidateId = lease.candidateId;
    this.ownerRunId = lease.ownerRunId;
    this.casRevision = lease.casRevision;
    this.leaseDigest = lease.leaseDigest;
    rawFencingTokens.set(this, rawFencingToken);
    Object.freeze(this);
  }

  static create(
    lease: WorktreeLeaseV1,
    rawFencingToken: string,
  ): WorktreeLeaseBindingV1 {
    return new WorktreeLeaseBindingV1(lease, rawFencingToken);
  }

  toJSON(): Record<string, unknown> {
    return {
      leaseId: this.leaseId,
      candidateId: this.candidateId,
      ownerRunId: this.ownerRunId,
      casRevision: this.casRevision,
      leaseDigest: this.leaseDigest,
      rawFencingToken: '[REDACTED]',
    };
  }
}

export class CandidateRootCapabilityV1 {
  readonly leaseId: string;
  readonly candidateId: string;
  readonly worktreeIdentity: string;
  readonly fencingTokenDigest: string;

  private constructor(
    lease: WorktreeLeaseV1,
    candidateDirectory: string,
    candidateRelativeCwd: string,
    rawFencingToken: string,
  ) {
    if (lease.worktreeIdentity === null) {
      integrity('A candidate-root capability requires a materialized worktree.');
    }
    this.leaseId = lease.leaseId;
    this.candidateId = lease.candidateId;
    this.worktreeIdentity = lease.worktreeIdentity;
    this.fencingTokenDigest = lease.fencingTokenDigest;
    rootCapabilities.set(this, {
      candidateDirectory,
      candidateRelativeCwd,
      rawFencingToken,
    });
    Object.freeze(this);
  }

  static create(
    lease: WorktreeLeaseV1,
    candidateDirectory: string,
    candidateRelativeCwd: string,
    rawFencingToken: string,
  ): CandidateRootCapabilityV1 {
    return new CandidateRootCapabilityV1(
      lease,
      candidateDirectory,
      candidateRelativeCwd,
      rawFencingToken,
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      leaseId: this.leaseId,
      candidateId: this.candidateId,
      worktreeIdentity: this.worktreeIdentity,
      fencingTokenDigest: this.fencingTokenDigest,
      candidateDirectory: '[PRIVATE]',
    };
  }
}

export interface WorktreeLeaseStoreOptions {
  readonly candidatesRootDirectory: string;
  readonly now?: () => Date;
  readonly probeLiveness?: (
    proof: ProcessLivenessProofV1,
  ) => Promise<ProcessLivenessOutcome>;
}

export interface ReserveWorktreeLeaseInputV1 {
  readonly sourceRepositoryRoot: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly snapshotBlobLease: SnapshotBlobLeaseV1;
  readonly goalId: string;
  readonly contractId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest?: string;
  readonly ownerProcessLivenessProof?: ProcessLivenessProofV1;
  readonly bootstrapPlanDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string | null;
  readonly expiresAt: string;
}

export interface WorktreeLeaseAuthorityV1 {
  readonly lease: WorktreeLeaseV1;
  readonly binding: WorktreeLeaseBindingV1;
}

export interface WorktreeMaterializationAuthorityV1
  extends WorktreeLeaseAuthorityV1 {
  readonly candidateOwnerDirectory: string;
  readonly candidateDirectory: string;
  readonly candidateBranch: string;
}

export interface CompleteWorktreeMaterializationInputV1 {
  readonly candidatePathIdentity: string;
  readonly materializedSourceDigest: string;
  readonly bootstrapRequired: boolean;
}

export interface ActivatedWorktreeLeaseV1 extends WorktreeLeaseAuthorityV1 {
  readonly rootCapability: CandidateRootCapabilityV1;
}

export interface RestoredCandidateRootV1 extends WorktreeLeaseAuthorityV1 {
  readonly rootCapability: CandidateRootCapabilityV1;
}

export interface TransferWorktreeOwnershipInputV1 {
  readonly newRunId: string;
  readonly newOwnerRunId: string;
  readonly newOwnerProcessLivenessProof: ProcessLivenessProofV1;
  readonly reasonCode: string;
}

export interface ResumeOwnedWorktreeLeaseInputV1 {
  readonly candidateId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest?: string;
  readonly expectedLeaseDigest: string;
}

export interface AdoptDeadWorktreeOwnerInputV1 {
  readonly candidateId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly expectedLeaseDigest: string;
  readonly nextProcessLivenessProof: ProcessLivenessProofV1;
}

export interface CandidateRootViewV1 {
  /** Trusted internal path. Never persist it in prompt, logs, or public records. */
  readonly candidateDirectory: string;
  readonly candidateRelativeCwd: string;
  readonly workspace: WorkspaceConfig & {
    readonly accessMode: 'workspace-only';
  };
}

export interface BootstrappingCandidateViewV1 extends CandidateRootViewV1 {
  /** Trusted internal state. Never expose this directory to the Agent. */
  readonly bootstrapPrivateDirectory: string;
}

export interface WorktreeOwnershipAncestorV1 {
  readonly leaseDigest: string;
  readonly fencingTokenDigest: string;
  readonly state: WorktreeLeaseStateV1;
}

export type WorktreeMaterializationRecoveryStateV1 =
  | 'not_materializing'
  | 'materializing_empty'
  | 'materialization_intent_only'
  | 'materialization_incomplete'
  | 'materialized_record_present'
  | 'materialization_inconsistent';

export interface WorktreeMaterializationRecoveryInspectionV1 {
  readonly lease: WorktreeLeaseV1;
  readonly ownershipAncestors:
    readonly WorktreeOwnershipAncestorV1[];
  readonly state: WorktreeMaterializationRecoveryStateV1;
  readonly intent: unknown;
  readonly record: unknown;
  readonly candidatePresent: boolean;
  readonly candidatePathIdentity: string | null;
}

interface WorktreePaths {
  readonly ownerDirectory: string;
  readonly candidateDirectory: string;
  readonly lease: string;
  readonly capability: string;
  readonly events: string;
  readonly lock: string;
}

interface CapabilityRecordV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly rawFencingToken: string;
  readonly processLivenessProof: ProcessLivenessProofV1 | null;
}

interface OwnershipPendingV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly previousLeaseDigest: string;
  readonly nextLeaseDigest: string;
  readonly newRawFencingToken: string;
  readonly nextProcessLivenessProof: ProcessLivenessProofV1;
}

interface LoadedLease {
  readonly lease: WorktreeLeaseV1;
  readonly events: readonly WorktreeLeaseEventV1[];
}

interface ReplayedWorktreeJournal {
  readonly events: readonly WorktreeLeaseEventV1[];
  readonly lease: WorktreeLeaseV1;
  readonly repairedFromJournal: boolean;
}

export class WorktreeLeaseStore {
  private readonly candidatesRootDirectory: string;
  private readonly now: () => Date;
  private readonly probeLiveness: (
    proof: ProcessLivenessProofV1,
  ) => Promise<ProcessLivenessOutcome>;
  private initialized = false;

  constructor(options: WorktreeLeaseStoreOptions) {
    if (!isRecord(options)
      || typeof options.candidatesRootDirectory !== 'string'
      || options.candidatesRootDirectory.length === 0
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.probeLiveness !== undefined
        && typeof options.probeLiveness !== 'function')) {
      fail('worktree_lease_invalid_input', 'A dedicated candidate root is required.');
    }
    this.candidatesRootDirectory = resolve(options.candidatesRootDirectory);
    this.now = options.now ?? (() => new Date());
    this.probeLiveness =
      options.probeLiveness ?? probeProcessLiveness;
  }

  async reserve(
    input: ReserveWorktreeLeaseInputV1,
  ): Promise<WorktreeLeaseAuthorityV1> {
    assertReserveInput(input);
    const ownerProcessLivenessProof =
      input.ownerProcessLivenessProof
      ?? await captureProcessLivenessProof();
    const ownerProcessIdentityDigest =
      input.ownerProcessIdentityDigest
      ?? ownerProcessLivenessProof.proofDigest;
    if (ownerProcessLivenessProof.proofDigest
      !== ownerProcessIdentityDigest) {
      fail(
        'worktree_lease_invalid_input',
        'The worktree owner process proof does not match its identity.',
      );
    }
    const sourceRepositoryRoot = await realpath(resolve(input.sourceRepositoryRoot));
    const topLevel = await runGit(sourceRepositoryRoot, [
      'rev-parse', '--show-toplevel',
    ]);
    if (topLevel.exitCode !== 0
      || await realpath(singleLine(topLevel.stdout)) !== sourceRepositoryRoot
      || await computeRepositoryIdentity(sourceRepositoryRoot)
        !== input.sourceSnapshot.repositoryIdentity) {
      fail(
        'worktree_lease_invalid_input',
        'The worktree lease source repository does not match the snapshot.',
      );
    }
    await this.ensureRoot(sourceRepositoryRoot);
    const createdAt = canonicalNow(this.now);
    if (!isCanonicalTimestamp(input.expiresAt)
      || Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
      fail('worktree_lease_invalid_input', 'The worktree lease expiry is invalid.');
    }
    const leaseId = randomUUID();
    const candidateId = randomUUID();
    const candidateBranch = `wukong/candidate/${candidateId}`;
    const paths = this.paths(candidateId);
    const rawFencingToken = randomBytes(32).toString('base64url');
    const created = createWorktreeLease({
      leaseId,
      candidateId,
      goalId: input.goalId,
      contractId: input.contractId,
      runId: input.runId,
      ownerRunId: input.ownerRunId,
      ownerProcessIdentityDigest:
        ownerProcessIdentityDigest,
      sourceSnapshotDigest: input.sourceSnapshot.snapshotDigest,
      snapshotBlobLeaseId: input.snapshotBlobLease.blobLeaseId,
      snapshotBlobLeaseDigest: input.snapshotBlobLease.leaseDigest,
      manifestDigest: input.snapshotBlobLease.manifestDigest,
      materializationPolicyDigest:
        input.snapshotBlobLease.materializationPolicyDigest,
      bootstrapPlanDigest: input.bootstrapPlanDigest,
      gatePlanDigest: input.gatePlanDigest,
      criteriaSelectionDigest: input.criteriaSelectionDigest,
      repositoryIdentity: input.sourceSnapshot.repositoryIdentity,
      baseCommit: input.sourceSnapshot.baseCommit,
      repositoryRelativeCwd: input.sourceSnapshot.repositoryRelativeCwd,
      candidateBranch,
      createdByRunId: input.runId,
      createdAt,
      expiresAt: input.expiresAt,
      fencingTokenDigest: digestFencingToken(rawFencingToken),
    });
    await mkdir(paths.ownerDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform === 'win32') {
      protectWindowsPrivateRootSecurity(paths.ownerDirectory);
    }
    await assertPrivateDirectory(paths.ownerDirectory);
    await mkdir(paths.events, { mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform === 'win32') {
      protectWindowsPrivateRootSecurity(paths.events);
    }
    await assertPrivateDirectory(paths.events);
    await writePrivateExclusive(paths.lock, '');
    const capability: CapabilityRecordV1 = {
      schemaVersion: 1,
      leaseId,
      candidateId,
      rawFencingToken,
      processLivenessProof:
        ownerProcessLivenessProof,
    };
    await writePrivateExclusive(paths.capability, canonicalJson(capability));
    await appendEvent(paths, created.event);
    await writePrivateAtomic(paths.lease, canonicalJson(created.lease));
    await syncDirectory(paths.ownerDirectory);
    return authority(created.lease, rawFencingToken);
  }

  async inspect(candidateId: string): Promise<WorktreeLeaseV1> {
    assertCandidateId(candidateId);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(candidateId, async () => {
      const loaded = await this.loadLeaseLocked(this.paths(candidateId));
      return loaded.lease;
    });
  }

  async inspectVerifyingLeaseDigest(
    candidateId: string,
  ): Promise<string> {
    assertCandidateId(candidateId);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(candidateId, async () => {
      const loaded = await this.loadLeaseLocked(this.paths(candidateId));
      if (loaded.lease.state === 'verifying') {
        return loaded.lease.leaseDigest;
      }
      const last = loaded.events.at(-1);
      if (loaded.lease.state === 'awaiting_promotion'
        && last?.fromState === 'verifying'
        && last.toState === 'awaiting_promotion'
        && last.previousLeaseDigest !== null) {
        return last.previousLeaseDigest;
      }
      fail(
        'worktree_lease_invalid_state',
        'The candidate has no current verification lease revision.',
      );
    });
  }

  async hasTransitionEvidence(input: {
    readonly candidateId: string;
    readonly leaseId: string;
    readonly previousLeaseDigest: string;
    readonly toState: WorktreeLeaseStateV1;
    readonly reasonCode: string;
  }): Promise<boolean> {
    if (!isRecord(input)
      || !isDigest(input.previousLeaseDigest)
      || !isReasonCode(input.reasonCode)) {
      fail(
        'worktree_lease_invalid_input',
        'Worktree transition evidence input is invalid.',
      );
    }
    assertCandidateId(input.candidateId);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(input.candidateId, async () => {
      const loaded = await this.loadLeaseLocked(
        this.paths(input.candidateId),
      );
      return loaded.events.some((event) =>
        event.candidateId === input.candidateId
        && event.leaseId === input.leaseId
        && event.previousLeaseDigest === input.previousLeaseDigest
        && event.toState === input.toState
        && event.reasonCode === input.reasonCode);
    });
  }

  async inspectMaterializationRecovery(
    candidateId: string,
  ): Promise<WorktreeMaterializationRecoveryInspectionV1> {
    assertCandidateId(candidateId);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(candidateId, async () => {
      const paths = this.paths(candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      const [intent, record, candidateInfo] = await Promise.all([
        readOptionalPrivateJson(
          join(paths.ownerDirectory, CANDIDATE_INTENT_FILE),
        ),
        readOptionalPrivateJson(
          join(paths.ownerDirectory, CANDIDATE_RECORD_FILE),
        ),
        lstatOrNull(paths.candidateDirectory),
      ]);
      if (candidateInfo !== null) assertPrivateDirectoryInfo(candidateInfo);
      const candidatePresent = candidateInfo !== null;
      const candidatePathIdentity = candidatePresent
        ? await computeCandidatePathIdentity(paths.candidateDirectory)
        : null;
      let state: WorktreeMaterializationRecoveryStateV1;
      if (loaded.lease.state !== 'materializing') {
        state = 'not_materializing';
      } else if (intent === null && record === null && !candidatePresent) {
        state = 'materializing_empty';
      } else if (intent !== null && record === null && !candidatePresent) {
        state = 'materialization_intent_only';
      } else if (intent !== null && record === null && candidatePresent) {
        state = 'materialization_incomplete';
      } else if (intent !== null && record !== null && candidatePresent) {
        state = 'materialized_record_present';
      } else {
        state = 'materialization_inconsistent';
      }
      return Object.freeze({
        lease: loaded.lease,
        ownershipAncestors:
          worktreeOwnershipAncestors(loaded.events),
        state,
        intent,
        record,
        candidatePresent,
        candidatePathIdentity,
      });
    });
  }

  async resumeOwned(
    input: ResumeOwnedWorktreeLeaseInputV1,
  ): Promise<WorktreeLeaseAuthorityV1> {
    if (!isRecord(input)
      || typeof input.candidateId !== 'string'
      || typeof input.runId !== 'string'
      || typeof input.ownerRunId !== 'string'
      || (input.ownerProcessIdentityDigest !== undefined
        && !isDigest(input.ownerProcessIdentityDigest))
      || !isDigest(input.expectedLeaseDigest)) {
      fail('worktree_lease_invalid_input', 'The worktree resume input is invalid.');
    }
    const ownerProcessIdentityDigest =
      input.ownerProcessIdentityDigest
      ?? (await captureProcessLivenessProof()).proofDigest;
    assertCandidateId(input.candidateId);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(input.candidateId, async () => {
      const paths = this.paths(input.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      if (loaded.lease.runId !== input.runId
        || loaded.lease.ownerRunId !== input.ownerRunId
        || loaded.lease.ownerProcessIdentityDigest
          !== ownerProcessIdentityDigest
        || loaded.lease.leaseDigest !== input.expectedLeaseDigest
        || loaded.lease.state === 'promoted'
        || loaded.lease.state === 'retained'
        || loaded.lease.state === 'released') {
        fail(
          'worktree_lease_stale_binding',
          'The persisted worktree ownership does not match this resume.',
        );
      }
      const capability = await readCapability(paths);
      return authority(loaded.lease, capability.rawFencingToken);
    });
  }

  async adoptDeadOwner(
    input: AdoptDeadWorktreeOwnerInputV1,
  ): Promise<WorktreeLeaseAuthorityV1> {
    if (!isRecord(input)
      || typeof input.candidateId !== 'string'
      || typeof input.runId !== 'string'
      || typeof input.ownerRunId !== 'string'
      || !isDigest(input.expectedLeaseDigest)
      || !validateProcessLivenessProof(
        input.nextProcessLivenessProof,
      )) {
      fail(
        'worktree_lease_invalid_input',
        'The dead-owner worktree adoption input is invalid.',
      );
    }
    assertCandidateId(input.candidateId);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(input.candidateId, async () => {
      const paths = this.paths(input.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      if (loaded.lease.runId !== input.runId
        || loaded.lease.ownerRunId !== input.ownerRunId
        || loaded.lease.leaseDigest
          !== input.expectedLeaseDigest
        || loaded.lease.state === 'promoting'
        || loaded.lease.state === 'promoted'
        || loaded.lease.state === 'retained'
        || loaded.lease.state === 'released') {
        fail(
          'worktree_lease_stale_binding',
          'The persisted worktree owner is not adoptable.',
        );
      }
      const previousCapability = await readCapability(paths);
      const previousProof =
        previousCapability.processLivenessProof;
      if (previousProof === null
        || previousProof.proofDigest
          !== loaded.lease.ownerProcessIdentityDigest
        || input.nextProcessLivenessProof.proofDigest
          === previousProof.proofDigest) {
        fail(
          'worktree_lease_liveness_unproven',
          'The previous worktree owner has no distinct liveness proof.',
        );
      }
      const liveness = await this.probeLiveness(previousProof);
      if (liveness === 'live') {
        fail(
          'worktree_lease_owner_live',
          'The previous worktree owner is still live.',
        );
      }
      if (liveness !== 'dead') {
        fail(
          'worktree_lease_liveness_unproven',
          'The previous worktree owner is not provably dead.',
        );
      }
      return persistOwnershipAdoption(
        paths,
        loaded.lease,
        {
          newRunId: input.runId,
          newOwnerRunId: input.ownerRunId,
          newOwnerProcessLivenessProof:
            input.nextProcessLivenessProof,
          reasonCode: 'dead_owner_recovery',
        },
        this.now,
      );
    });
  }

  async beginMaterialization(
    binding: WorktreeLeaseBindingV1,
  ): Promise<WorktreeMaterializationAuthorityV1> {
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (isExpired(loaded.lease, this.now())) {
        fail('worktree_lease_expired', 'The worktree lease expired before materialization.');
      }
      if (loaded.lease.state !== 'creating') invalidState(loaded.lease, 'creating');
      const materializing = await this.persistTransition(paths, loaded.lease, {
        toState: 'materializing',
        occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
      });
      return {
        ...authority(materializing, rawFencingToken),
        candidateOwnerDirectory: paths.ownerDirectory,
        candidateDirectory: paths.candidateDirectory,
        candidateBranch: materializing.candidateBranch,
      };
    });
  }

  async completeMaterialization(
    binding: WorktreeLeaseBindingV1,
    input: CompleteWorktreeMaterializationInputV1,
  ): Promise<WorktreeLeaseAuthorityV1> {
    if (!isRecord(input)
      || !isDigest(input.candidatePathIdentity)
      || !isDigest(input.materializedSourceDigest)
      || typeof input.bootstrapRequired !== 'boolean') {
      fail(
        'worktree_lease_invalid_input',
        'The worktree materialization completion is invalid.',
      );
    }
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (loaded.lease.state !== 'materializing') {
        invalidState(loaded.lease, 'materializing');
      }
      if (isExpired(loaded.lease, this.now())) {
        fail('worktree_lease_expired', 'The worktree lease expired during materialization.');
      }
      const actualIdentity = await computeCandidatePathIdentity(paths.candidateDirectory);
      if (actualIdentity !== input.candidatePathIdentity) {
        integrity('The materialized candidate path identity does not match.');
      }
      const next = await this.persistTransition(paths, loaded.lease, {
        toState: input.bootstrapRequired ? 'bootstrapping' : 'active',
        occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
        worktreeIdentity: input.candidatePathIdentity,
        materializedSourceDigest: input.materializedSourceDigest,
      });
      return authority(next, rawFencingToken);
    });
  }

  async activate(
    binding: WorktreeLeaseBindingV1,
  ): Promise<ActivatedWorktreeLeaseV1> {
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      let active = loaded.lease;
      if (active.state === 'bootstrapping') {
        active = await this.persistTransition(paths, active, {
          toState: 'active',
          occurredAt: canonicalNow(this.now, active.updatedAt),
        });
      } else if (active.state !== 'active') {
        invalidState(active, 'bootstrapping or active');
      }
      const candidateRelativeCwd = resolveCandidateCwd(
        paths.candidateDirectory,
        active.repositoryRelativeCwd,
      );
      await assertCandidateIdentity(paths.candidateDirectory, active);
      return {
        ...authority(active, rawFencingToken),
        rootCapability: CandidateRootCapabilityV1.create(
          active,
          paths.candidateDirectory,
          candidateRelativeCwd,
          rawFencingToken,
        ),
      };
    });
  }

  async restoreCandidateRoot(
    binding: WorktreeLeaseBindingV1,
  ): Promise<RestoredCandidateRootV1> {
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(
        paths,
        loaded.lease,
        binding,
        rawFencingToken,
      );
      if (loaded.lease.state !== 'active'
        && loaded.lease.state !== 'verifying'
        && loaded.lease.state !== 'awaiting_promotion') {
        invalidState(
          loaded.lease,
          'active, verifying, or awaiting_promotion',
        );
      }
      if (isExpired(loaded.lease, this.now())) {
        fail(
          'worktree_lease_expired',
          'The worktree lease expired before candidate-root restore.',
        );
      }
      await assertCandidateIdentity(
        paths.candidateDirectory,
        loaded.lease,
      );
      const candidateRelativeCwd = resolveCandidateCwd(
        paths.candidateDirectory,
        loaded.lease.repositoryRelativeCwd,
      );
      return {
        ...authority(loaded.lease, rawFencingToken),
        rootCapability: CandidateRootCapabilityV1.create(
          loaded.lease,
          paths.candidateDirectory,
          candidateRelativeCwd,
          rawFencingToken,
        ),
      };
    });
  }

  async transferOwnership(
    binding: WorktreeLeaseBindingV1,
    input: TransferWorktreeOwnershipInputV1,
  ): Promise<WorktreeLeaseAuthorityV1> {
    if (!isRecord(input)
      || typeof input.newRunId !== 'string'
      || typeof input.newOwnerRunId !== 'string'
      || !validateProcessLivenessProof(
        input.newOwnerProcessLivenessProof,
      )
      || typeof input.reasonCode !== 'string'
      || !REASON_PATTERN.test(input.newRunId)
      || !REASON_PATTERN.test(input.newOwnerRunId)
      || !isReasonCode(input.reasonCode)) {
      fail(
        'worktree_lease_invalid_input',
        'The worktree ownership transfer is invalid.',
      );
    }
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (loaded.lease.state !== 'creating'
        && loaded.lease.state !== 'materializing'
        && loaded.lease.state !== 'bootstrapping'
        && loaded.lease.state !== 'active'
        && loaded.lease.state !== 'verifying'
        && loaded.lease.state !== 'awaiting_promotion') {
        invalidState(
          loaded.lease,
          'creating, materializing, bootstrapping, active, verifying, or awaiting_promotion',
        );
      }
      return persistOwnershipAdoption(
        paths,
        loaded.lease,
        input,
        this.now,
      );
    });
  }

  async transition(
    binding: WorktreeLeaseBindingV1,
    toState: Exclude<WorktreeLeaseStateV1, 'creating' | 'materializing' | 'bootstrapping'>,
    reasonCode?: string,
  ): Promise<WorktreeLeaseAuthorityV1> {
    if (reasonCode !== undefined && !isReasonCode(reasonCode)) {
      fail('worktree_lease_invalid_input', 'The worktree transition reason is invalid.');
    }
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    return this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      await assertCandidateIdentity(paths.candidateDirectory, loaded.lease);
      const next = await this.persistTransition(paths, loaded.lease, {
        toState,
        occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
        reasonCode,
      });
      return authority(next, rawFencingToken);
    });
  }

  async withCandidateRoot<Result>(
    capability: CandidateRootCapabilityV1,
    callback: (view: CandidateRootViewV1) => Promise<Result> | Result,
    pathPolicy?: CandidateWorkspacePathPolicyV1,
  ): Promise<Result> {
    if (!(capability instanceof CandidateRootCapabilityV1)
      || typeof callback !== 'function') {
      fail('worktree_lease_invalid_input', 'A candidate-root capability is required.');
    }
    const privateCapability = rootCapabilities.get(capability);
    if (privateCapability === undefined) {
      fail('worktree_lease_stale_binding', 'The candidate-root capability is not authentic.');
    }
    await this.ensureInitializedRoot();
    const before = await this.validateCandidateRootUse(
      capability,
      privateCapability,
    );
    if (pathPolicy !== undefined) {
      assertCandidateWorkspacePathPolicyPlan(
        pathPolicy,
        before.bootstrapPlanDigest,
      );
    }
    let rootUseActive = true;
    const validateAuthority = async (): Promise<void> => {
      if (!rootUseActive) {
        fail(
          'worktree_lease_stale_binding',
          'The candidate-root capability escaped its authorized lifecycle.',
        );
      }
      const current = await this.validateCandidateRootUse(
        capability,
        privateCapability,
        before.leaseDigest,
      );
      if (pathPolicy !== undefined) {
        assertCandidateWorkspacePathPolicyPlan(
          pathPolicy,
          current.bootstrapPlanDigest,
        );
      }
    };
    const view = createCandidateRootView(
      privateCapability.candidateDirectory,
      privateCapability.candidateRelativeCwd,
      capability.worktreeIdentity,
      validateAuthority,
      pathPolicy,
    );
    try {
      return await callback(view);
    } finally {
      try {
        await validateAuthority();
      } finally {
        rootUseActive = false;
      }
    }
  }

  async withMaterializingCandidate<Result>(
    binding: WorktreeLeaseBindingV1,
    callback: (view: CandidateRootViewV1) => Promise<Result> | Result,
  ): Promise<Result> {
    if (typeof callback !== 'function') {
      fail('worktree_lease_invalid_input', 'A recovery callback is required.');
    }
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    const before = await this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (loaded.lease.state !== 'materializing') {
        invalidState(loaded.lease, 'materializing');
      }
      const candidateInfo = await lstatOrNull(paths.candidateDirectory);
      if (candidateInfo === null) {
        fail(
          'worktree_lease_invalid_state',
          'The materializing candidate directory does not exist.',
        );
      }
      assertPrivateDirectoryInfo(candidateInfo);
      const identity = await computeCandidatePathIdentity(
        paths.candidateDirectory,
      );
      return {
        lease: loaded.lease,
        identity,
        view: createCandidateRootView(
          paths.candidateDirectory,
          resolveCandidateCwd(
            paths.candidateDirectory,
            loaded.lease.repositoryRelativeCwd,
          ),
          identity,
        ),
      };
    });
    const result = await callback(before.view);
    await this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (loaded.lease.leaseDigest !== before.lease.leaseDigest
        || await computeCandidatePathIdentity(paths.candidateDirectory)
          !== before.identity) {
        fail(
          'worktree_lease_stale_binding',
          'The materializing candidate changed during recovery validation.',
        );
      }
    });
    return result;
  }

  async withBootstrappingCandidate<Result>(
    binding: WorktreeLeaseBindingV1,
    callback: (
      view: BootstrappingCandidateViewV1,
      ownershipAncestors: readonly WorktreeOwnershipAncestorV1[],
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    if (typeof callback !== 'function') {
      fail('worktree_lease_invalid_input', 'A bootstrap callback is required.');
    }
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureInitializedRoot();
    const before = await this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (loaded.lease.state !== 'bootstrapping') {
        invalidState(loaded.lease, 'bootstrapping');
      }
      if (isExpired(loaded.lease, this.now())) {
        fail(
          'worktree_lease_expired',
          'The worktree lease expired before bootstrap state access.',
        );
      }
      await assertCandidateIdentity(paths.candidateDirectory, loaded.lease);
      const bootstrapPrivateDirectory = join(
        paths.ownerDirectory,
        BOOTSTRAP_PRIVATE_DIRECTORY,
      );
      await mkdir(bootstrapPrivateDirectory, {
        mode: PRIVATE_DIRECTORY_MODE,
      }).catch((error) => {
        if (!isNodeError(error, 'EEXIST')) throw error;
      });
      await assertPrivateDirectory(bootstrapPrivateDirectory);
      const rootView = createCandidateRootView(
        paths.candidateDirectory,
        resolveCandidateCwd(
          paths.candidateDirectory,
          loaded.lease.repositoryRelativeCwd,
        ),
        loaded.lease.worktreeIdentity!,
      );
      return {
        lease: loaded.lease,
        identity: loaded.lease.worktreeIdentity,
        ownershipAncestors:
          worktreeOwnershipAncestors(loaded.events),
        view: Object.freeze({
          ...rootView,
          bootstrapPrivateDirectory,
        }),
      };
    });
    const result = await callback(
      before.view,
      before.ownershipAncestors,
    );
    await this.withLeaseLock(binding.candidateId, async () => {
      const paths = this.paths(binding.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (loaded.lease.state !== 'bootstrapping'
        || loaded.lease.leaseDigest !== before.lease.leaseDigest
        || loaded.lease.worktreeIdentity !== before.identity) {
        fail(
          'worktree_lease_stale_binding',
          'The worktree lease changed during bootstrap state access.',
        );
      }
      if (isExpired(loaded.lease, this.now())) {
        fail(
          'worktree_lease_expired',
          'The worktree lease expired during bootstrap state access.',
        );
      }
      await assertCandidateIdentity(paths.candidateDirectory, loaded.lease);
      await assertPrivateDirectory(join(
        paths.ownerDirectory,
        BOOTSTRAP_PRIVATE_DIRECTORY,
      ));
    });
    return result;
  }

  private async validateCandidateRootUse(
    capability: CandidateRootCapabilityV1,
    privateCapability: {
      readonly rawFencingToken: string;
      readonly candidateDirectory: string;
      readonly candidateRelativeCwd: string;
    },
    expectedLeaseDigest?: string,
  ): Promise<WorktreeLeaseV1> {
    return this.withLeaseLock(capability.candidateId, async () => {
      const paths = this.paths(capability.candidateId);
      const loaded = await this.loadLeaseLocked(paths);
      if (expectedLeaseDigest !== undefined
        && loaded.lease.leaseDigest !== expectedLeaseDigest) {
        fail(
          'worktree_lease_stale_binding',
          'The worktree lease changed during candidate-root use.',
        );
      }
      assertRootCapability(
        loaded.lease,
        capability,
        privateCapability.rawFencingToken,
      );
      if (loaded.lease.state !== 'active'
        && loaded.lease.state !== 'verifying'
        && loaded.lease.state !== 'awaiting_promotion') {
        invalidState(loaded.lease, 'active, verifying, or awaiting_promotion');
      }
      if (isExpired(loaded.lease, this.now())) {
        fail(
          'worktree_lease_expired',
          'The worktree lease expired during candidate-root use.',
        );
      }
      await assertCandidateIdentity(paths.candidateDirectory, loaded.lease);
      return loaded.lease;
    });
  }

  private async ensureRoot(sourceRepositoryRoot: string): Promise<void> {
    const prospectiveRoot = await resolveProspectiveRealPath(
      this.candidatesRootDirectory,
    );
    if (isInside(sourceRepositoryRoot, prospectiveRoot)
      || isInside(prospectiveRoot, sourceRepositoryRoot)) {
      fail(
        'worktree_lease_root_unsafe',
        'The candidate root must be isolated from the source repository.',
      );
    }
    await this.ensureInitializedRoot();
    const actualRoot = await realpath(this.candidatesRootDirectory);
    if (isInside(sourceRepositoryRoot, actualRoot)
      || isInside(actualRoot, sourceRepositoryRoot)) {
      fail(
        'worktree_lease_root_unsafe',
        'The candidate root must be isolated from the source repository.',
      );
    }
  }

  private async ensureInitializedRoot(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.candidatesRootDirectory, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      if (process.platform !== 'win32') {
        await chmod(this.candidatesRootDirectory, PRIVATE_DIRECTORY_MODE);
      } else {
        protectWindowsPrivateRootSecurity(
          this.candidatesRootDirectory,
        );
      }
      this.initialized = true;
    }
    await assertPrivateDirectory(this.candidatesRootDirectory);
  }

  private paths(candidateId: string): WorktreePaths {
    assertCandidateId(candidateId);
    const ownerDirectory = join(this.candidatesRootDirectory, candidateId);
    return {
      ownerDirectory,
      candidateDirectory: join(ownerDirectory, WORKTREE_DIRECTORY),
      lease: join(ownerDirectory, LEASE_FILE),
      capability: join(ownerDirectory, CAPABILITY_FILE),
      events: join(ownerDirectory, EVENTS_DIRECTORY),
      lock: join(ownerDirectory, LOCK_SENTINEL),
    };
  }

  private async withLeaseLock<Result>(
    candidateId: string,
    callback: () => Promise<Result>,
  ): Promise<Result> {
    const paths = this.paths(candidateId);
    await assertPrivateDirectory(paths.ownerDirectory);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(paths.lock, {
        realpath: true,
        retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      throw new WorktreeLeaseStoreError(
        'worktree_lease_lock_failed',
        'Unable to lock the worktree lease.',
        { cause: error },
      );
    }
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  private async loadLeaseLocked(paths: WorktreePaths): Promise<LoadedLease> {
    const persisted = parseJson(await readPrivateFile(paths.lease, MAX_METADATA_BYTES));
    if (!validateWorktreeLease(persisted)) {
      integrity('The persisted worktree lease is invalid.');
    }
    const replayed = await readJournal(paths, persisted);
    const lease = replayed.lease;
    if (replayed.repairedFromJournal) {
      await writePrivateAtomic(paths.lease, canonicalJson(lease));
    }
    await reconcilePendingOwnership(paths, lease);
    const capability = await readCapability(paths);
    if (capability.leaseId !== lease.leaseId
      || capability.candidateId !== lease.candidateId
      || digestFencingToken(capability.rawFencingToken)
        !== lease.fencingTokenDigest
      || (capability.processLivenessProof === null
        ? true
        : capability.processLivenessProof.proofDigest
          !== lease.ownerProcessIdentityDigest)) {
      integrity('The private worktree lease capability does not match.');
    }
    return { lease, events: replayed.events };
  }

  private async assertExactBinding(
    paths: WorktreePaths,
    lease: WorktreeLeaseV1,
    binding: WorktreeLeaseBindingV1,
    rawFencingToken: string,
  ): Promise<void> {
    if (binding.leaseId !== lease.leaseId
      || binding.candidateId !== lease.candidateId
      || binding.ownerRunId !== lease.ownerRunId
      || binding.casRevision !== lease.casRevision
      || binding.leaseDigest !== lease.leaseDigest
      || digestFencingToken(rawFencingToken) !== lease.fencingTokenDigest) {
      fail('worktree_lease_stale_binding', 'The worktree lease binding is stale.');
    }
    const capability = await readCapability(paths);
    if (capability.rawFencingToken !== rawFencingToken) {
      fail('worktree_lease_stale_binding', 'The worktree lease fencing token is stale.');
    }
  }

  private async persistTransition(
    paths: WorktreePaths,
    current: WorktreeLeaseV1,
    input: Parameters<typeof transitionWorktreeLease>[1],
  ): Promise<WorktreeLeaseV1> {
    let next: ReturnType<typeof transitionWorktreeLease>;
    try {
      next = transitionWorktreeLease(current, input);
    } catch (error) {
      throw new WorktreeLeaseStoreError(
        'worktree_lease_invalid_state',
        'The requested worktree lease transition is invalid.',
        { cause: error },
      );
    }
    await appendEvent(paths, next.event);
    await writePrivateAtomic(paths.lease, canonicalJson(next.lease));
    return next.lease;
  }
}

function assertReserveInput(input: ReserveWorktreeLeaseInputV1): void {
  if (!isRecord(input)
    || typeof input.sourceRepositoryRoot !== 'string'
    || input.sourceRepositoryRoot.length === 0
    || !validateSourceSnapshot(input.sourceSnapshot)
    || input.sourceSnapshot.exclusions.length > 0
    || !validateSnapshotBlobLease(input.snapshotBlobLease)
    || input.snapshotBlobLease.state !== 'confirmed'
    || input.snapshotBlobLease.sourceSnapshotDigest
      !== input.sourceSnapshot.snapshotDigest
    || input.snapshotBlobLease.snapshotPolicyDigest
      !== input.sourceSnapshot.snapshotPolicyDigest
    || input.snapshotBlobLease.materializationPolicyDigest
      !== SNAPSHOT_MATERIALIZATION_POLICY_DIGEST
    || (input.ownerProcessIdentityDigest !== undefined
      && !isDigest(input.ownerProcessIdentityDigest))
    || (input.ownerProcessLivenessProof !== undefined
      && !validateProcessLivenessProof(
        input.ownerProcessLivenessProof,
      ))
    || (input.ownerProcessIdentityDigest !== undefined
      && input.ownerProcessLivenessProof !== undefined
      && input.ownerProcessLivenessProof.proofDigest
        !== input.ownerProcessIdentityDigest)) {
    fail('worktree_lease_invalid_input', 'The worktree lease reservation is invalid.');
  }
}

function authority(
  lease: WorktreeLeaseV1,
  rawFencingToken: string,
): WorktreeLeaseAuthorityV1 {
  return {
    lease,
    binding: WorktreeLeaseBindingV1.create(lease, rawFencingToken),
  };
}

function worktreeOwnershipAncestors(
  events: readonly WorktreeLeaseEventV1[],
): readonly WorktreeOwnershipAncestorV1[] {
  return Object.freeze(
    events
      .filter((event) =>
        event.eventType === 'ownership_adopted')
      .map((event) => Object.freeze({
        leaseDigest: event.previousLeaseDigest!,
        fencingTokenDigest:
          event.previousFencingTokenDigest!,
        state: event.fromState!,
      }))
      .toReversed(),
  );
}

async function persistOwnershipAdoption(
  paths: WorktreePaths,
  current: WorktreeLeaseV1,
  input: TransferWorktreeOwnershipInputV1 & {
    readonly newOwnerProcessLivenessProof: ProcessLivenessProofV1;
  },
  now: () => Date,
): Promise<WorktreeLeaseAuthorityV1> {
  const nextRawFencingToken =
    randomBytes(32).toString('base64url');
  const adopted = adoptWorktreeLease(current, {
    newRunId: input.newRunId,
    newOwnerRunId: input.newOwnerRunId,
    newOwnerProcessIdentityDigest:
      input.newOwnerProcessLivenessProof.proofDigest,
    newFencingTokenDigest:
      digestFencingToken(nextRawFencingToken),
    occurredAt: canonicalNow(now, current.updatedAt),
    reasonCode: input.reasonCode,
  });
  const pending: OwnershipPendingV1 = {
    schemaVersion: 1,
    leaseId: adopted.lease.leaseId,
    candidateId: adopted.lease.candidateId,
    previousLeaseDigest: current.leaseDigest,
    nextLeaseDigest: adopted.lease.leaseDigest,
    newRawFencingToken: nextRawFencingToken,
    nextProcessLivenessProof:
      input.newOwnerProcessLivenessProof,
  };
  const pendingPath = join(
    paths.ownerDirectory,
    OWNERSHIP_PENDING_FILE,
  );
  await writePrivateExclusive(
    pendingPath,
    canonicalJson(pending),
  );
  await appendEvent(paths, adopted.event);
  await writePrivateAtomic(
    paths.lease,
    canonicalJson(adopted.lease),
  );
  await writePrivateAtomic(
    paths.capability,
    canonicalJson({
      schemaVersion: 1,
      leaseId: adopted.lease.leaseId,
      candidateId: adopted.lease.candidateId,
      rawFencingToken: nextRawFencingToken,
      processLivenessProof:
        input.newOwnerProcessLivenessProof,
    } satisfies CapabilityRecordV1),
  );
  await unlink(pendingPath);
  await syncDirectory(paths.ownerDirectory);
  return authority(adopted.lease, nextRawFencingToken);
}

function getRawFencingToken(binding: WorktreeLeaseBindingV1): string {
  if (!(binding instanceof WorktreeLeaseBindingV1)) {
    fail('worktree_lease_stale_binding', 'The worktree lease binding is not authentic.');
  }
  const token = rawFencingTokens.get(binding);
  if (token === undefined) {
    fail('worktree_lease_stale_binding', 'The worktree lease binding is not authentic.');
  }
  return token;
}

function assertRootCapability(
  lease: WorktreeLeaseV1,
  capability: CandidateRootCapabilityV1,
  rawFencingToken: string,
): void {
  if (capability.leaseId !== lease.leaseId
    || capability.candidateId !== lease.candidateId
    || capability.worktreeIdentity !== lease.worktreeIdentity
    || capability.fencingTokenDigest !== lease.fencingTokenDigest
    || digestFencingToken(rawFencingToken) !== lease.fencingTokenDigest) {
    fail('worktree_lease_stale_binding', 'The candidate-root capability is stale.');
  }
}

async function readCapability(paths: WorktreePaths): Promise<CapabilityRecordV1> {
  const value = parseJson(await readPrivateFile(paths.capability, MAX_CAPABILITY_BYTES));
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',')
      !== [
        'candidateId',
        'leaseId',
        'processLivenessProof',
        'rawFencingToken',
        'schemaVersion',
      ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || typeof value['leaseId'] !== 'string'
    || typeof value['candidateId'] !== 'string'
    || typeof value['rawFencingToken'] !== 'string'
    || (value['processLivenessProof'] !== null
      && !validateProcessLivenessProof(
        value['processLivenessProof'],
      ))) {
    integrity('The private worktree capability is invalid.');
  }
  return value as unknown as CapabilityRecordV1;
}

async function reconcilePendingOwnership(
  paths: WorktreePaths,
  lease: WorktreeLeaseV1,
): Promise<void> {
  const pendingPath = join(paths.ownerDirectory, OWNERSHIP_PENDING_FILE);
  const value = await readOptionalPrivateJson(pendingPath);
  if (value === null) return;
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',')
      !== [
        'candidateId',
        'leaseId',
        'newRawFencingToken',
        'nextProcessLivenessProof',
        'nextLeaseDigest',
        'previousLeaseDigest',
        'schemaVersion',
      ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || value['leaseId'] !== lease.leaseId
    || value['candidateId'] !== lease.candidateId
    || !isDigest(value['previousLeaseDigest'])
    || !isDigest(value['nextLeaseDigest'])
    || typeof value['newRawFencingToken'] !== 'string'
    || value['newRawFencingToken'].length < 32
    || !validateProcessLivenessProof(
      value['nextProcessLivenessProof'],
    )) {
    integrity('The pending worktree ownership transfer is invalid.');
  }
  const pending = value as unknown as OwnershipPendingV1;
  if (lease.leaseDigest === pending.previousLeaseDigest) {
    await unlink(pendingPath);
    await syncDirectory(paths.ownerDirectory);
    return;
  }
  if (lease.leaseDigest !== pending.nextLeaseDigest
    || digestFencingToken(pending.newRawFencingToken)
      !== lease.fencingTokenDigest) {
    integrity('The pending worktree ownership transfer does not match the lease.');
  }
  const currentCapability = await readCapability(paths);
  if (currentCapability.rawFencingToken !== pending.newRawFencingToken) {
    await writePrivateAtomic(paths.capability, canonicalJson({
      schemaVersion: 1,
      leaseId: lease.leaseId,
      candidateId: lease.candidateId,
      rawFencingToken: pending.newRawFencingToken,
      processLivenessProof:
        pending.nextProcessLivenessProof,
    } satisfies CapabilityRecordV1));
  }
  await unlink(pendingPath);
  await syncDirectory(paths.ownerDirectory);
}

async function readJournal(
  paths: WorktreePaths,
  persistedLease: WorktreeLeaseV1,
): Promise<ReplayedWorktreeJournal> {
  const entries = await readdir(paths.events, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !EVENT_FILE_PATTERN.test(entry.name))) {
    integrity('The worktree lease journal contains an unknown entry.');
  }
  const names = entries.map((entry) => entry.name).toSorted();
  if (names.length === 0 || names.length > 10_000) {
    integrity('The worktree lease journal length is invalid.');
  }
  const events: WorktreeLeaseEventV1[] = [];
  for (const [index, name] of names.entries()) {
    if (name !== `${String(index).padStart(12, '0')}.json`) {
      integrity('The worktree lease journal sequence has a gap.');
    }
    const event = parseJson(
      await readPrivateFile(join(paths.events, name), MAX_METADATA_BYTES),
    );
    if (!validateWorktreeLeaseEvent(event) || event.sequence !== index) {
      integrity('A worktree lease journal event is invalid.');
    }
    events.push(event);
  }
  const first = events[0];
  if (first === undefined) integrity('The initial worktree lease event is missing.');
  let replay = createWorktreeLease({
    leaseId: persistedLease.leaseId,
    candidateId: persistedLease.candidateId,
    goalId: persistedLease.goalId,
    contractId: persistedLease.contractId,
    runId: first.runId,
    ownerRunId: first.ownerRunId,
    ownerProcessIdentityDigest:
      first.ownerProcessIdentityDigest,
    sourceSnapshotDigest: persistedLease.sourceSnapshotDigest,
    snapshotBlobLeaseId: persistedLease.snapshotBlobLeaseId,
    snapshotBlobLeaseDigest: persistedLease.snapshotBlobLeaseDigest,
    manifestDigest: persistedLease.manifestDigest,
    materializationPolicyDigest: persistedLease.materializationPolicyDigest,
    bootstrapPlanDigest: persistedLease.bootstrapPlanDigest,
    gatePlanDigest: persistedLease.gatePlanDigest,
    criteriaSelectionDigest: persistedLease.criteriaSelectionDigest,
    repositoryIdentity: persistedLease.repositoryIdentity,
    baseCommit: persistedLease.baseCommit,
    repositoryRelativeCwd: persistedLease.repositoryRelativeCwd,
    candidateBranch: persistedLease.candidateBranch,
    createdByRunId: persistedLease.createdByRunId,
    createdAt: persistedLease.createdAt,
    expiresAt: persistedLease.expiresAt,
    fencingTokenDigest: first.fencingTokenDigest,
  });
  if (!validateInitialWorktreeLease(replay.lease, first)
    || canonicalJson(replay.event) !== canonicalJson(first)) {
    integrity('The initial worktree lease event does not match.');
  }
  let penultimate: WorktreeLeaseV1 | null = null;
  for (const event of events.slice(1)) {
    penultimate = replay.lease;
    const next = replayWorktreeEvent(replay.lease, event);
    if (!validateWorktreeLeaseTransition(replay.lease, event, next.lease)
      || canonicalJson(next.event) !== canonicalJson(event)) {
      integrity('The worktree lease journal chain is invalid.');
    }
    replay = next;
  }
  if (canonicalJson(replay.lease) === canonicalJson(persistedLease)) {
    return { events, lease: replay.lease, repairedFromJournal: false };
  }
  const journalIsExactlyOneAhead =
    events.length === persistedLease.casRevision + 2
    && penultimate !== null
    && canonicalJson(penultimate) === canonicalJson(persistedLease)
    && events.at(-1)?.previousLeaseDigest === persistedLease.leaseDigest;
  if (!journalIsExactlyOneAhead) {
    integrity('The worktree lease does not match its journal.');
  }
  return { events, lease: replay.lease, repairedFromJournal: true };
}

function replayWorktreeEvent(
  current: WorktreeLeaseV1,
  event: WorktreeLeaseEventV1,
): ReturnType<typeof transitionWorktreeLease> {
  try {
    return event.eventType === 'ownership_adopted'
      ? adoptWorktreeLease(current, {
          newRunId: event.runId,
          newOwnerRunId: event.ownerRunId,
          newOwnerProcessIdentityDigest:
            event.ownerProcessIdentityDigest,
          newFencingTokenDigest: event.fencingTokenDigest,
          occurredAt: event.occurredAt,
          reasonCode: event.reasonCode ?? '',
        })
      : transitionWorktreeLease(current, {
          toState: event.toState as Exclude<WorktreeLeaseStateV1, 'creating'>,
          occurredAt: event.occurredAt,
          worktreeIdentity: event.worktreeIdentity ?? undefined,
          materializedSourceDigest: event.materializedSourceDigest ?? undefined,
          reasonCode: event.reasonCode,
        });
  } catch (error) {
    throw new WorktreeLeaseStoreError(
      'worktree_lease_integrity_failed',
      'The worktree lease journal cannot be replayed.',
      { cause: error },
    );
  }
}

async function appendEvent(
  paths: WorktreePaths,
  event: WorktreeLeaseEventV1,
): Promise<void> {
  await writePrivateExclusive(
    join(paths.events, `${String(event.sequence).padStart(12, '0')}.json`),
    canonicalJson(event),
  );
  await syncDirectory(paths.events);
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

async function writePrivateAtomic(path: string, content: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.worktree-lease-${randomBytes(16).toString('hex')}.tmp`,
  );
  await writePrivateExclusive(temporary, content);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertPrivateFile(before);
    if (before.size > maxBytes) integrity('A private worktree lease file is oversized.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.byteLength !== after.size) {
      integrity('A private worktree lease file changed while reading.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertPrivateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    integrity('A private worktree lease file has an unsafe identity.');
  }
  if (process.platform !== 'win32') {
    if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) {
      integrity('A private worktree lease file is not mode 0600.');
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      integrity('A private worktree lease file has another owner.');
    }
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      fail('worktree_lease_not_found', 'The worktree lease directory was not found.');
    }
    throw error;
  }
  assertPrivateDirectoryInfo(info);
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch (error) {
      throw new WorktreeLeaseStoreError(
        'worktree_lease_integrity_failed',
        'A worktree lease directory has an unsafe Windows ACL.',
        { cause: error },
      );
    }
  }
}

function assertPrivateDirectoryInfo(info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    integrity('A worktree lease directory has an unsafe identity.');
  }
  if (process.platform !== 'win32'
    && ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
    integrity('A worktree lease directory is not private to the current owner.');
  }
}

async function assertCandidateIdentity(
  candidateDirectory: string,
  lease: WorktreeLeaseV1,
): Promise<void> {
  if (lease.worktreeIdentity === null
    || await computeCandidatePathIdentity(candidateDirectory)
      !== lease.worktreeIdentity) {
    integrity('The candidate worktree identity changed.');
  }
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

async function computeRepositoryIdentity(root: string): Promise<string> {
  const [commonDirResult, objectFormat] = await Promise.all([
    runGit(root, ['rev-parse', '--git-common-dir']),
    runGit(root, ['rev-parse', '--show-object-format']),
  ]);
  if (commonDirResult.exitCode !== 0 || objectFormat.exitCode !== 0) {
    integrity('Unable to compute the worktree repository identity.');
  }
  const commonDirValue = singleLine(commonDirResult.stdout);
  const commonDir = await realpath(isAbsolute(commonDirValue)
    ? commonDirValue
    : resolve(root, commonDirValue));
  const info = await stat(commonDir, { bigint: true });
  return canonicalDigest('wukong/repository-identity/v1', {
    commonDirPathDigest: canonicalDigest('wukong/private-path/v1', commonDir),
    device: info.dev.toString(),
    inode: info.ino.toString(),
    objectFormat: singleLine(objectFormat.stdout),
  });
}

async function resolveProspectiveRealPath(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = path;
  while (true) {
    try {
      return resolve(await realpath(existing), ...missing.toReversed());
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      const parent = dirname(existing);
      if (parent === existing) {
        fail('worktree_lease_root_unsafe', 'Unable to resolve the candidate root.');
      }
      missing.push(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
}

function resolveCandidateCwd(candidateDirectory: string, relativeCwd: string): string {
  const result = relativeCwd === '.'
    ? candidateDirectory
    : resolve(candidateDirectory, relativeCwd);
  if (!isInside(candidateDirectory, result)) {
    integrity('The candidate cwd escaped its worktree.');
  }
  return result;
}

function createCandidateRootView(
  candidateDirectory: string,
  candidateRelativeCwd: string,
  worktreeIdentity: string,
  validateAuthority?: () => Promise<void>,
  pathPolicy?: CandidateWorkspacePathPolicyV1,
): CandidateRootViewV1 {
  const workspace = Object.freeze({
    workspaceDir: candidateRelativeCwd,
    additionalDirs: Object.freeze(
      candidateRelativeCwd === candidateDirectory
        ? []
        : [candidateDirectory],
    ),
    accessMode: 'workspace-only' as const,
  });
  bindCandidateWorkspaceGuard(workspace, {
    rootDirectory: candidateDirectory,
    expectedRootIdentity: worktreeIdentity,
    validateAuthority,
    pathPolicy,
  });
  return Object.freeze({
    candidateDirectory,
    candidateRelativeCwd,
    workspace,
  });
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

function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = Buffer.from(bytes).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
      integrity('A private worktree lease file is not valid UTF-8.');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WorktreeLeaseStoreError) throw error;
    throw new WorktreeLeaseStoreError(
      'worktree_lease_integrity_failed',
      'A private worktree lease file is not valid JSON.',
      { cause: error },
    );
  }
}

async function readOptionalPrivateJson(path: string): Promise<unknown> {
  try {
    return parseJson(await readPrivateFile(path, MAX_METADATA_BYTES));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

function digestFencingToken(rawToken: string): string {
  return canonicalDigest('wukong/worktree-lease-fencing-token/v1', rawToken);
}

function sameFile(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function isExpired(lease: WorktreeLeaseV1, now: Date): boolean {
  return now.getTime() >= Date.parse(lease.expiresAt);
}

function invalidState(lease: WorktreeLeaseV1, expected: string): never {
  fail(
    'worktree_lease_invalid_state',
    `Worktree lease state ${lease.state} is not ${expected}.`,
  );
}

function assertCandidateId(candidateId: string): void {
  if (!UUID_PATTERN.test(candidateId)) {
    fail('worktree_lease_invalid_input', 'The candidate ID is invalid.');
  }
}

function canonicalNow(now: () => Date, minimum?: string): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('worktree_lease_invalid_input', 'The worktree lease clock is invalid.');
  }
  const time = minimum === undefined
    ? value.getTime()
    : Math.max(value.getTime(), Date.parse(minimum));
  return new Date(time).toISOString();
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string'
    && REASON_PATTERN.test(value)
    && !containsSensitiveText(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
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

function singleLine(input: Buffer): string {
  return input.toString('utf8').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function integrity(message: string): never {
  fail('worktree_lease_integrity_failed', message);
}

function fail(code: WorktreeLeaseStoreErrorCode, message: string): never {
  throw new WorktreeLeaseStoreError(code, message);
}
