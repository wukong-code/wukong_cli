import { randomBytes, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  SNAPSHOT_BLOB_MAX_BYTES,
  SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  canonicalDigest,
  canonicalJson,
  containsSensitiveText,
  createSnapshotBlobLease,
  digestSnapshotMaterializationContainer,
  parseSnapshotMaterializationContainer,
  transitionSnapshotBlobLease,
  validateInitialSnapshotBlobLease,
  validateSnapshotBlobLease,
  validateSnapshotBlobLeaseContainerBinding,
  validateSnapshotBlobLeaseEvent,
  validateSnapshotBlobLeaseSourceBinding,
  validateSnapshotBlobLeaseTransition,
  validateSourceSnapshot,
  type ParsedSnapshotMaterializationContainerV1,
  type SnapshotBlobLeaseEventV1,
  type SnapshotBlobLeaseStateV1,
  type SnapshotBlobLeaseV1,
  type SnapshotMaterializationImageV1,
  type SnapshotMaterializationManifestV1,
  type SourceSnapshotV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const ROOT_MODE = 0o700;
const DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEASE_FILE = 'lease.json';
const SOURCE_SNAPSHOT_FILE = 'source-snapshot.json';
const PAYLOAD_FILE = 'payload.bin';
const CAPABILITY_FILE = 'capability.json';
const EVENTS_DIRECTORY = 'events';
const LOCK_SENTINEL = 'lock';
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITY_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_FILE_PATTERN = /^([0-9]{12})\.json$/u;
const FENCING_DIGEST_DOMAIN = 'wukong/snapshot-blob-fencing-token/v1';
const PATH_IDENTITY_DOMAIN = 'wukong/snapshot-blob-private-path/v1';

const rawFencingTokens = new WeakMap<SnapshotBlobLeaseBindingV1, string>();

export type SnapshotBlobLeaseStoreErrorCode =
  | 'snapshot_blob_invalid_input'
  | 'snapshot_blob_not_found'
  | 'snapshot_blob_integrity_failed'
  | 'snapshot_blob_stale_binding'
  | 'snapshot_blob_invalid_state'
  | 'snapshot_blob_expired'
  | 'snapshot_blob_lock_failed';

export class SnapshotBlobLeaseStoreError extends Error {
  constructor(
    readonly reasonCode: SnapshotBlobLeaseStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SnapshotBlobLeaseStoreError';
  }
}

/**
 * Opaque in-process authority for one exact lease revision.
 *
 * The raw fencing token is held in a module-private WeakMap, is not enumerable,
 * and cannot accidentally enter JSON/session/wire records. Future process
 * handoff must use a dedicated private carrier; callers must never log or
 * persist this object as a substitute for that carrier.
 */
export class SnapshotBlobLeaseBindingV1 {
  readonly blobLeaseId: string;
  readonly ownerRunId: string;
  readonly casRevision: number;
  readonly leaseDigest: string;

  private constructor(lease: SnapshotBlobLeaseV1, rawFencingToken: string) {
    this.blobLeaseId = lease.blobLeaseId;
    this.ownerRunId = lease.ownerRunId;
    this.casRevision = lease.casRevision;
    this.leaseDigest = lease.leaseDigest;
    rawFencingTokens.set(this, rawFencingToken);
    Object.freeze(this);
  }

  static create(
    lease: SnapshotBlobLeaseV1,
    rawFencingToken: string,
  ): SnapshotBlobLeaseBindingV1 {
    return new SnapshotBlobLeaseBindingV1(lease, rawFencingToken);
  }

  toJSON(): Record<string, unknown> {
    return {
      blobLeaseId: this.blobLeaseId,
      ownerRunId: this.ownerRunId,
      casRevision: this.casRevision,
      leaseDigest: this.leaseDigest,
      rawFencingToken: '[REDACTED]',
    };
  }
}

export interface SnapshotBlobLeaseStoreOptions {
  /** Dedicated private root, normally WUKONG_CODE_HOME/runtime/.../snapshot-blobs. */
  readonly rootDirectory: string;
  readonly now?: (() => Date) | undefined;
}

export interface StageSnapshotBlobLeaseInputV1 {
  readonly containerBytes: Uint8Array;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly createdByRunId: string;
  readonly ownerRunId: string;
  readonly expiresAt: string;
}

export interface SnapshotBlobLeaseAuthorityV1 {
  readonly lease: SnapshotBlobLeaseV1;
  readonly binding: SnapshotBlobLeaseBindingV1;
}

export interface ResumeOwnedSnapshotBlobLeaseInputV1 {
  readonly blobLeaseId: string;
  readonly ownerRunId: string;
  readonly expectedLeaseDigest: string;
}

export interface RecoverConsumedSnapshotBlobLeaseInputV1 {
  readonly blobLeaseId: string;
  readonly ownerRunId: string;
  readonly expectedConfirmedLeaseDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly manifestDigest: string;
}

export interface VerifiedSnapshotPayloadViewV1 {
  readonly manifest: SnapshotMaterializationManifestV1;
  /**
   * Verified image payload only (never the framed container or its disk path).
   * The callback is trusted; the view is an isolated in-memory copy.
   */
  readonly readImage: (image: SnapshotMaterializationImageV1) => Uint8Array;
}

export interface ConsumedSnapshotBlobLeaseV1<Result> {
  readonly lease: SnapshotBlobLeaseV1;
  readonly result: Result;
}

interface CapabilityRecordV1 {
  readonly schemaVersion: 1;
  readonly blobLeaseId: string;
  readonly rawFencingToken: string;
}

interface LeasePaths {
  readonly directory: string;
  readonly lease: string;
  readonly sourceSnapshot: string;
  readonly payload: string;
  readonly capability: string;
  readonly events: string;
  readonly lock: string;
}

interface LoadedLease {
  readonly lease: SnapshotBlobLeaseV1;
  readonly events: readonly SnapshotBlobLeaseEventV1[];
}

interface PrivateFileRead {
  readonly bytes: Buffer;
  readonly stats: Stats;
}

/**
 * Durable private carrier for a source snapshot.
 *
 * POSIX permissions and no-follow checks protect against other OS users and
 * accidental link traversal. They are not a sandbox against a hostile process
 * running under the same uid: Node does not expose an openat-style, directory
 * capability API that could close every path-replacement TOCTOU window.
 */
export class SnapshotBlobLeaseStore {
  private readonly rootDirectory: string;
  private readonly now: () => Date;
  private initialized = false;

  constructor(options: SnapshotBlobLeaseStoreOptions) {
    if (typeof options.rootDirectory !== 'string'
      || options.rootDirectory.length === 0) {
      fail('snapshot_blob_invalid_input', 'A dedicated snapshot blob root is required.');
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.now = options.now ?? (() => new Date());
  }

  async stageAndSeal(
    input: StageSnapshotBlobLeaseInputV1,
  ): Promise<SnapshotBlobLeaseAuthorityV1> {
    if (!isRecord(input)
      || Object.keys(input).toSorted().join(',')
        !== 'containerBytes,createdByRunId,expiresAt,ownerRunId,sourceSnapshot'
      || !(input.containerBytes instanceof Uint8Array)
      || input.containerBytes.byteLength <= 0
      || input.containerBytes.byteLength > SNAPSHOT_BLOB_MAX_BYTES
      || !validateSourceSnapshot(input.sourceSnapshot)
      || input.sourceSnapshot.exclusions.length > 0) {
      fail('snapshot_blob_invalid_input', 'The snapshot blob stage input is invalid.');
    }
    const parsed = parseSnapshotMaterializationContainer(input.containerBytes);
    if (parsed.manifest.sourceSnapshotDigest !== input.sourceSnapshot.snapshotDigest
      || parsed.manifest.snapshotPolicyDigest
        !== input.sourceSnapshot.snapshotPolicyDigest
      || parsed.manifest.materializationPolicyDigest
        !== SNAPSHOT_MATERIALIZATION_POLICY_DIGEST) {
      fail(
        'snapshot_blob_invalid_input',
        'The snapshot container does not identify the approved source snapshot.',
      );
    }
    const createdAt = canonicalNow(this.now);
    assertCanonicalFutureTimestamp(input.expiresAt, createdAt);
    await this.ensureRoot();

    const blobLeaseId = randomUUID();
    const paths = this.paths(blobLeaseId);
    await mkdir(paths.directory, { mode: DIRECTORY_MODE });
    try {
      if (process.platform === 'win32') {
        protectWindowsPrivateRootSecurity(paths.directory);
      }
      await assertPrivateDirectory(paths.directory);
      await mkdir(paths.events, { mode: DIRECTORY_MODE });
      if (process.platform === 'win32') {
        protectWindowsPrivateRootSecurity(paths.events);
      }
      await assertPrivateDirectory(paths.events);
      await writePrivateExclusive(paths.lock, '');

      const rawFencingToken = randomBytes(32).toString('base64url');
      const capability: CapabilityRecordV1 = {
        schemaVersion: 1,
        blobLeaseId,
        rawFencingToken,
      };
      await writePrivateExclusive(paths.capability, canonicalJson(capability));
      await writePrivateExclusive(
        paths.sourceSnapshot,
        canonicalJson(input.sourceSnapshot),
      );
      await writePrivateExclusive(paths.payload, input.containerBytes);

      const privateBlobPathIdentity = await computePrivateBlobPathIdentity(
        this.rootDirectory,
        paths.directory,
        paths.payload,
      );
      const created = createSnapshotBlobLease({
        blobLeaseId,
        createdByRunId: input.createdByRunId,
        ownerRunId: input.ownerRunId,
        sourceSnapshotDigest: parsed.manifest.sourceSnapshotDigest,
        snapshotPolicyDigest: parsed.manifest.snapshotPolicyDigest,
        materializationPolicyDigest: parsed.manifest.materializationPolicyDigest,
        manifestDigest: parsed.manifest.manifestDigest,
        privateBlobPathIdentity,
        contentDigest: digestSnapshotMaterializationContainer(input.containerBytes),
        payloadSizeBytes: input.containerBytes.byteLength,
        entryCount: parsed.manifest.entryCount,
        createdAt,
        expiresAt: input.expiresAt,
        fencingTokenDigest: digestFencingToken(rawFencingToken),
      });
      if (!validateSnapshotBlobLeaseSourceBinding(
        created.lease,
        input.containerBytes,
        input.sourceSnapshot,
      )) {
        integrity('The staged snapshot blob does not match the approved source projection.');
      }
      await appendEvent(paths, created.event);
      await writePrivateAtomic(paths.lease, canonicalJson(created.lease));

      return await this.withLeaseLock(blobLeaseId, async () => {
        const loaded = await this.loadLeaseLocked(paths);
        const sealed = await this.persistTransition(paths, loaded.lease, {
          toState: 'sealed',
          occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
        });
        return authority(sealed, rawFencingToken);
      });
    } catch (error) {
      await cleanupUnpublishedLease(paths);
      throw error;
    }
  }

  async inspect(blobLeaseId: string): Promise<SnapshotBlobLeaseV1> {
    assertLeaseId(blobLeaseId);
    await this.ensureRoot();
    return this.withLeaseLock(blobLeaseId, async () => {
      const loaded = await this.loadLeaseLocked(this.paths(blobLeaseId));
      return loaded.lease;
    });
  }

  async resumeOwned(
    input: ResumeOwnedSnapshotBlobLeaseInputV1,
  ): Promise<SnapshotBlobLeaseAuthorityV1> {
    if (!isRecord(input)
      || typeof input.blobLeaseId !== 'string'
      || typeof input.ownerRunId !== 'string'
      || !isDigest(input.expectedLeaseDigest)) {
      fail(
        'snapshot_blob_invalid_input',
        'The snapshot blob resume input is invalid.',
      );
    }
    assertLeaseId(input.blobLeaseId);
    await this.ensureRoot();
    return this.withLeaseLock(input.blobLeaseId, async () => {
      const paths = this.paths(input.blobLeaseId);
      const loaded = await this.loadLeaseLocked(paths);
      if (loaded.lease.ownerRunId !== input.ownerRunId
        || loaded.lease.leaseDigest !== input.expectedLeaseDigest
        || (loaded.lease.state !== 'sealed'
          && loaded.lease.state !== 'confirmed')) {
        fail(
          'snapshot_blob_stale_binding',
          'The persisted snapshot blob ownership does not match this resume.',
        );
      }
      if (isExpired(loaded.lease, this.now())) {
        fail(
          'snapshot_blob_expired',
          'The snapshot blob lease expired before resume.',
        );
      }
      const capability = await readCapability(paths);
      if (capability.blobLeaseId !== loaded.lease.blobLeaseId
        || digestFencingToken(capability.rawFencingToken)
          !== loaded.lease.fencingTokenDigest) {
        integrity(
          'The private snapshot blob capability does not match the lease.',
        );
      }
      return authority(loaded.lease, capability.rawFencingToken);
    });
  }

  async confirm(
    binding: SnapshotBlobLeaseBindingV1,
  ): Promise<SnapshotBlobLeaseAuthorityV1> {
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureRoot();
    return this.withLeaseLock(binding.blobLeaseId, async () => {
      const paths = this.paths(binding.blobLeaseId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (isExpired(loaded.lease, this.now())) {
        await this.persistTransition(paths, loaded.lease, {
          toState: 'expired',
          occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
          reasonCode: 'lease_expired',
        });
        fail('snapshot_blob_expired', 'The snapshot blob lease has expired.');
      }
      if (loaded.lease.state !== 'sealed') {
        invalidState(loaded.lease, 'sealed');
      }
      try {
        await this.readAndVerifyContainer(paths, loaded.lease);
      } catch (error) {
        await this.markCorrupt(paths, loaded.lease, 'payload_integrity_failed');
        throw error;
      }
      const confirmed = await this.persistTransition(paths, loaded.lease, {
        toState: 'confirmed',
        occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
      });
      return authority(confirmed, rawFencingToken);
    });
  }

  async consumeAndDestroy<Result>(
    binding: SnapshotBlobLeaseBindingV1,
    callback: (view: VerifiedSnapshotPayloadViewV1) => Promise<Result> | Result,
  ): Promise<ConsumedSnapshotBlobLeaseV1<Result>> {
    if (typeof callback !== 'function') {
      fail('snapshot_blob_invalid_input', 'A trusted materialization callback is required.');
    }
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureRoot();

    const materializing = await this.withLeaseLock(binding.blobLeaseId, async () => {
      const paths = this.paths(binding.blobLeaseId);
      const loaded = await this.loadLeaseLocked(paths);
      await this.assertExactBinding(paths, loaded.lease, binding, rawFencingToken);
      if (isExpired(loaded.lease, this.now())) {
        await this.persistTransition(paths, loaded.lease, {
          toState: 'expired',
          occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
          reasonCode: 'lease_expired',
        });
        fail('snapshot_blob_expired', 'The snapshot blob lease has expired.');
      }
      if (loaded.lease.state !== 'confirmed') {
        invalidState(loaded.lease, 'confirmed');
      }
      let parsed: ParsedSnapshotMaterializationContainerV1;
      try {
        parsed = await this.readAndVerifyContainer(paths, loaded.lease);
      } catch (error) {
        await this.markCorrupt(paths, loaded.lease, 'payload_integrity_failed');
        throw error;
      }
      const lease = await this.persistTransition(paths, loaded.lease, {
        toState: 'materializing',
        occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
      });
      return { lease, parsed };
    });

    const payloadCopy = Uint8Array.from(materializing.parsed.payloadBytes);
    const manifest = freezeManifest(materializing.parsed.manifest);
    const imageByDigest = new Map<string, SnapshotMaterializationImageV1>();
    for (const entry of manifest.entries) {
      if (entry.indexImage !== null) {
        imageByDigest.set(entry.indexImage.imageDigest, entry.indexImage);
      }
      if (entry.worktreeImage !== null) {
        imageByDigest.set(entry.worktreeImage.imageDigest, entry.worktreeImage);
      }
    }
    const view: VerifiedSnapshotPayloadViewV1 = Object.freeze({
      manifest,
      readImage: (image: SnapshotMaterializationImageV1): Uint8Array => {
        const expected = imageByDigest.get(image.imageDigest);
        if (expected === undefined || canonicalJson(expected) !== canonicalJson(image)) {
          fail(
            'snapshot_blob_integrity_failed',
            'The requested image is not part of the verified snapshot manifest.',
          );
        }
        const end = expected.offsetBytes + expected.sizeBytes;
        if (!Number.isSafeInteger(end)
          || expected.offsetBytes < 0
          || end > payloadCopy.byteLength) {
          fail('snapshot_blob_integrity_failed', 'An image view is outside the payload.');
        }
        return Uint8Array.from(payloadCopy.subarray(expected.offsetBytes, end));
      },
    });

    // A callback failure deliberately leaves a durable `materializing` record.
    // Blind retry could duplicate writes; a later reconciliation path must
    // classify the candidate before any destruction is attempted.
    const result = await callback(view);

    const destroyed = await this.withLeaseLock(binding.blobLeaseId, async () => {
      const paths = this.paths(binding.blobLeaseId);
      const loaded = await this.loadLeaseLocked(paths);
      this.assertInternalAuthority(
        loaded.lease,
        materializing.lease,
        rawFencingToken,
      );
      const consumed = await this.persistTransition(paths, loaded.lease, {
        toState: 'consumed',
        occurredAt: canonicalNow(this.now, loaded.lease.updatedAt),
      });
      return this.destroyLoaded(
        paths,
        consumed,
        rawFencingToken,
        'payload_consumed',
      );
    });
    return { lease: destroyed, result };
  }

  /**
   * Completes data minimization after a process died after writing and
   * verifying the materialized candidate record but before consumeAndDestroy
   * could commit its consumed/destroyed transitions.
   *
   * The caller must first re-verify the exact candidate record. This method
   * independently requires the durable confirmed -> materializing ancestry
   * and the same source/manifest/owner binding before deleting the payload.
   */
  async recoverConsumedAfterMaterialization(
    input: RecoverConsumedSnapshotBlobLeaseInputV1,
  ): Promise<SnapshotBlobLeaseV1> {
    if (!isRecord(input)
      || Object.keys(input).toSorted().join(',')
        !== 'blobLeaseId,expectedConfirmedLeaseDigest,manifestDigest,ownerRunId,sourceSnapshotDigest'
      || typeof input.blobLeaseId !== 'string'
      || typeof input.ownerRunId !== 'string'
      || !REASON_PATTERN.test(input.ownerRunId)
      || !isDigest(input.expectedConfirmedLeaseDigest)
      || !isDigest(input.sourceSnapshotDigest)
      || !isDigest(input.manifestDigest)) {
      fail(
        'snapshot_blob_invalid_input',
        'The recovered snapshot blob materialization input is invalid.',
      );
    }
    assertLeaseId(input.blobLeaseId);
    await this.ensureRoot();
    return this.withLeaseLock(input.blobLeaseId, async () => {
      const paths = this.paths(input.blobLeaseId);
      const loaded = await this.loadLeaseLocked(paths);
      const { lease, events } = loaded;
      const ancestryMatches = events.some((event) =>
        event.fromState === 'confirmed'
        && event.toState === 'materializing'
        && event.previousLeaseDigest
          === input.expectedConfirmedLeaseDigest);
      if (lease.blobLeaseId !== input.blobLeaseId
        || lease.ownerRunId !== input.ownerRunId
        || lease.sourceSnapshotDigest !== input.sourceSnapshotDigest
        || lease.manifestDigest !== input.manifestDigest
        || !ancestryMatches) {
        fail(
          'snapshot_blob_stale_binding',
          'The recovered materialization does not match the snapshot blob ancestry.',
        );
      }
      if (lease.state === 'destroyed') return lease;
      if (lease.state !== 'materializing'
        && lease.state !== 'consumed'
        && lease.state !== 'destroying') {
        fail(
          'snapshot_blob_invalid_state',
          `Snapshot blob lease ${lease.blobLeaseId} is ${lease.state}; expected materializing, consumed, destroying, or destroyed.`,
        );
      }
      const capability = await readCapability(paths);
      if (capability.blobLeaseId !== lease.blobLeaseId
        || digestFencingToken(capability.rawFencingToken)
          !== lease.fencingTokenDigest) {
        integrity(
          'The recovered snapshot blob capability does not match the lease.',
        );
      }
      const consumed = lease.state === 'materializing'
        ? await this.persistTransition(paths, lease, {
            toState: 'consumed',
            occurredAt: canonicalNow(this.now, lease.updatedAt),
          })
        : lease;
      return this.destroyLoaded(
        paths,
        consumed,
        capability.rawFencingToken,
        'payload_consumed_after_materialization_recovery',
      );
    });
  }

  async destroy(
    binding: SnapshotBlobLeaseBindingV1,
    reasonCode = 'cleanup_requested',
  ): Promise<SnapshotBlobLeaseV1> {
    assertReason(reasonCode);
    const rawFencingToken = getRawFencingToken(binding);
    await this.ensureRoot();
    return this.withLeaseLock(binding.blobLeaseId, async () => {
      const paths = this.paths(binding.blobLeaseId);
      const loaded = await this.loadLeaseLocked(paths);
      if (loaded.lease.state === 'destroyed') {
        assertBindingIdentity(loaded.lease, binding, rawFencingToken);
        await removeCapabilityAfterTombstone(paths);
        return loaded.lease;
      }
      if (loaded.lease.state === 'destroying') {
        assertBindingIdentity(loaded.lease, binding, rawFencingToken);
      } else {
        await this.assertExactBinding(
          paths,
          loaded.lease,
          binding,
          rawFencingToken,
        );
      }
      return this.destroyLoaded(paths, loaded.lease, rawFencingToken, reasonCode);
    });
  }

  async reconcileExpired(): Promise<readonly SnapshotBlobLeaseV1[]> {
    await this.ensureRoot();
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const reconciled: SnapshotBlobLeaseV1[] = [];
    for (const entry of entries.toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        const lease = await this.withLeaseLock(entry.name, async () => {
          const paths = this.paths(entry.name);
          const loaded = await this.loadLeaseLocked(paths);
          if (loaded.lease.state === 'destroyed') {
            await removeCapabilityAfterTombstone(paths);
            return undefined;
          }
          if (loaded.lease.state === 'materializing') return undefined;
          if (loaded.lease.state === 'destroying') {
            return this.destroyLoaded(
              paths,
              loaded.lease,
              undefined,
              'reconcile_destroying',
            );
          }
          if (loaded.lease.state === 'consumed'
            || loaded.lease.state === 'expired'
            || loaded.lease.state === 'corrupt') {
            return this.destroyLoaded(
              paths,
              loaded.lease,
              undefined,
              'reconcile_terminal_cleanup',
            );
          }
          if (!isExpired(loaded.lease, this.now())) return undefined;
          let current = loaded.lease;
          if (current.state === 'staging'
            || current.state === 'sealed'
            || current.state === 'confirmed') {
            current = await this.persistTransition(paths, current, {
              toState: 'expired',
              occurredAt: canonicalNow(this.now, current.updatedAt),
              reasonCode: 'lease_expired',
            });
          }
          return this.destroyLoaded(
            paths,
            current,
            undefined,
            'expired_lease_cleanup',
          );
        });
        if (lease !== undefined) reconciled.push(lease);
      } catch (error) {
        if (error instanceof SnapshotBlobLeaseStoreError
          && error.reasonCode === 'snapshot_blob_not_found') continue;
        throw error;
      }
    }
    return reconciled;
  }

  private async ensureRoot(): Promise<void> {
    if (this.initialized) {
      await assertPrivateDirectory(this.rootDirectory);
      return;
    }
    const created = await mkdir(this.rootDirectory, {
      recursive: true,
      mode: ROOT_MODE,
    });
    if (process.platform !== 'win32') {
      await chmod(this.rootDirectory, ROOT_MODE);
    } else if (created !== undefined) {
      protectWindowsPrivateRootSecurity(this.rootDirectory);
    }
    await assertPrivateDirectory(this.rootDirectory);
    this.initialized = true;
  }

  private paths(blobLeaseId: string): LeasePaths {
    assertLeaseId(blobLeaseId);
    const directory = join(this.rootDirectory, blobLeaseId);
    return {
      directory,
      lease: join(directory, LEASE_FILE),
      sourceSnapshot: join(directory, SOURCE_SNAPSHOT_FILE),
      payload: join(directory, PAYLOAD_FILE),
      capability: join(directory, CAPABILITY_FILE),
      events: join(directory, EVENTS_DIRECTORY),
      lock: join(directory, LOCK_SENTINEL),
    };
  }

  private async withLeaseLock<Result>(
    blobLeaseId: string,
    callback: () => Promise<Result>,
  ): Promise<Result> {
    const paths = this.paths(blobLeaseId);
    await assertPrivateDirectory(paths.directory).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) {
        fail('snapshot_blob_not_found', `Snapshot blob lease ${blobLeaseId} was not found.`);
      }
      throw error;
    });
    await assertPrivateFile(paths.lock, 1);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(paths.lock, {
        retries: { retries: 100, factor: 1, minTimeout: 20, maxTimeout: 100 },
        stale: 30_000,
        update: 10_000,
        realpath: false,
      });
      if (process.platform !== 'win32') {
        await chmod(`${paths.lock}.lock`, DIRECTORY_MODE).catch(() => {});
      }
      return await callback();
    } catch (error) {
      if (error instanceof SnapshotBlobLeaseStoreError) throw error;
      return fail(
        'snapshot_blob_lock_failed',
        `Unable to coordinate snapshot blob lease ${blobLeaseId}.`,
        error,
      );
    } finally {
      if (release !== undefined) {
        await release().catch(() => {});
      }
    }
  }

  private async loadLeaseLocked(paths: LeasePaths): Promise<LoadedLease> {
    await assertPrivateDirectory(paths.directory);
    await assertPrivateDirectory(paths.events);
    const leaseRead = await readPrivateFile(paths.lease, MAX_METADATA_BYTES);
    const leaseValue = parseJson(leaseRead.bytes, 'lease');
    if (!validateSnapshotBlobLease(leaseValue)) {
      integrity('The snapshot blob lease record is invalid.');
    }
    let lease = leaseValue;
    const events = await readJournal(paths, lease);
    if (events.length === lease.casRevision + 2) {
      const trailing = events.at(-1);
      if (trailing === undefined) {
        integrity('The snapshot blob journal recovery event is missing.');
      }
      const transition = transitionSnapshotBlobLease(lease, {
        toState: trailing.toState,
        occurredAt: trailing.occurredAt,
        reasonCode: trailing.reasonCode,
      });
      if (canonicalJson(transition.event) !== canonicalJson(trailing)
        || !validateSnapshotBlobLeaseTransition(lease, trailing, transition.lease)) {
        integrity('The trailing snapshot blob journal event is invalid.');
      }
      lease = transition.lease;
      await writePrivateAtomic(paths.lease, canonicalJson(lease));
    }
    return { lease, events };
  }

  private async persistTransition(
    paths: LeasePaths,
    current: SnapshotBlobLeaseV1,
    input: {
      readonly toState: SnapshotBlobLeaseStateV1;
      readonly occurredAt: string;
      readonly reasonCode?: string | null;
    },
  ): Promise<SnapshotBlobLeaseV1> {
    const transition = transitionSnapshotBlobLease(current, input);
    await appendEvent(paths, transition.event);
    await writePrivateAtomic(paths.lease, canonicalJson(transition.lease));
    return transition.lease;
  }

  private async assertExactBinding(
    paths: LeasePaths,
    lease: SnapshotBlobLeaseV1,
    binding: SnapshotBlobLeaseBindingV1,
    rawFencingToken: string,
  ): Promise<void> {
    assertBindingIdentity(lease, binding, rawFencingToken);
    if (binding.casRevision !== lease.casRevision
      || binding.leaseDigest !== lease.leaseDigest) {
      fail('snapshot_blob_stale_binding', 'The snapshot blob binding is stale.');
    }
    const capability = await readCapability(paths);
    if (capability.blobLeaseId !== lease.blobLeaseId
      || capability.rawFencingToken !== rawFencingToken) {
      integrity('The private snapshot blob capability does not match the lease.');
    }
  }

  private assertInternalAuthority(
    current: SnapshotBlobLeaseV1,
    expected: SnapshotBlobLeaseV1,
    rawFencingToken: string,
  ): void {
    if (current.blobLeaseId !== expected.blobLeaseId
      || current.ownerRunId !== expected.ownerRunId
      || current.casRevision !== expected.casRevision
      || current.leaseDigest !== expected.leaseDigest
      || current.state !== 'materializing'
      || digestFencingToken(rawFencingToken) !== current.fencingTokenDigest) {
      fail(
        'snapshot_blob_stale_binding',
        'The materializing snapshot blob authority changed during the callback.',
      );
    }
  }

  private async readAndVerifyContainer(
    paths: LeasePaths,
    lease: SnapshotBlobLeaseV1,
  ): Promise<ParsedSnapshotMaterializationContainerV1> {
    const payload = await readPrivateFile(paths.payload, SNAPSHOT_BLOB_MAX_BYTES);
    if (payload.bytes.byteLength !== lease.payloadSizeBytes
      || digestSnapshotMaterializationContainer(payload.bytes) !== lease.contentDigest) {
      integrity('The private snapshot blob content digest does not match.');
    }
    const identity = await computePrivateBlobPathIdentity(
      this.rootDirectory,
      paths.directory,
      paths.payload,
    );
    if (identity !== lease.privateBlobPathIdentity) {
      integrity('The private snapshot blob path identity changed.');
    }
    let parsed: ParsedSnapshotMaterializationContainerV1;
    try {
      parsed = parseSnapshotMaterializationContainer(payload.bytes);
    } catch (error) {
      fail(
        'snapshot_blob_integrity_failed',
        'The private snapshot materialization container is invalid.',
        error,
      );
    }
    const snapshotRead = await readPrivateFile(paths.sourceSnapshot, MAX_METADATA_BYTES);
    const sourceSnapshot = parseJson(snapshotRead.bytes, 'source snapshot');
    if (!validateSnapshotBlobLeaseContainerBinding(lease, payload.bytes)
      || !validateSnapshotBlobLeaseSourceBinding(
        lease,
        payload.bytes,
        sourceSnapshot as SourceSnapshotV1,
      )) {
      integrity('The private snapshot blob does not match its lease and source snapshot.');
    }
    return parsed;
  }

  private async markCorrupt(
    paths: LeasePaths,
    lease: SnapshotBlobLeaseV1,
    reasonCode: string,
  ): Promise<SnapshotBlobLeaseV1> {
    if (lease.state === 'corrupt') return lease;
    if (lease.state === 'destroying' || lease.state === 'destroyed') return lease;
    return this.persistTransition(paths, lease, {
      toState: 'corrupt',
      occurredAt: canonicalNow(this.now, lease.updatedAt),
      reasonCode,
    });
  }

  private async destroyLoaded(
    paths: LeasePaths,
    loaded: SnapshotBlobLeaseV1,
    rawFencingToken: string | undefined,
    reasonCode: string,
  ): Promise<SnapshotBlobLeaseV1> {
    assertReason(reasonCode);
    let lease = loaded;
    if (lease.state === 'destroyed') {
      await removeCapabilityAfterTombstone(paths);
      return lease;
    }
    if (rawFencingToken !== undefined
      && digestFencingToken(rawFencingToken) !== lease.fencingTokenDigest) {
      fail('snapshot_blob_stale_binding', 'The snapshot blob fencing token is stale.');
    }
    if (lease.state !== 'destroying') {
      await assertPayloadIdentity(
        this.rootDirectory,
        paths,
        lease.privateBlobPathIdentity,
        false,
      );
      lease = await this.persistTransition(paths, lease, {
        toState: 'destroying',
        occurredAt: canonicalNow(this.now, lease.updatedAt),
        reasonCode,
      });
    }

    // Exact unlink only. This is data minimization, not secure erase: SSD/COW
    // media may retain historical blocks. The no-follow identity checks below
    // cannot defend against a hostile same-uid path swap after the check.
    await assertPayloadIdentity(
      this.rootDirectory,
      paths,
      lease.privateBlobPathIdentity,
      true,
    );
    try {
      await unlink(paths.payload);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    await syncDirectory(paths.directory);
    lease = await this.persistTransition(paths, lease, {
      toState: 'destroyed',
      occurredAt: canonicalNow(this.now, lease.updatedAt),
    });
    await removeCapabilityAfterTombstone(paths);
    return lease;
  }
}

function authority(
  lease: SnapshotBlobLeaseV1,
  rawFencingToken: string,
): SnapshotBlobLeaseAuthorityV1 {
  return {
    lease,
    binding: SnapshotBlobLeaseBindingV1.create(lease, rawFencingToken),
  };
}

function freezeManifest(
  manifest: SnapshotMaterializationManifestV1,
): SnapshotMaterializationManifestV1 {
  for (const entry of manifest.entries) {
    if (entry.indexImage !== null) Object.freeze(entry.indexImage);
    if (entry.worktreeImage !== null) Object.freeze(entry.worktreeImage);
    Object.freeze(entry);
  }
  Object.freeze(manifest.entries);
  return Object.freeze(manifest);
}

function getRawFencingToken(binding: SnapshotBlobLeaseBindingV1): string {
  if (!(binding instanceof SnapshotBlobLeaseBindingV1)) {
    fail('snapshot_blob_stale_binding', 'The snapshot blob binding is not authentic.');
  }
  const token = rawFencingTokens.get(binding);
  if (token === undefined) {
    fail('snapshot_blob_stale_binding', 'The snapshot blob binding is not authentic.');
  }
  return token;
}

function assertBindingIdentity(
  lease: SnapshotBlobLeaseV1,
  binding: SnapshotBlobLeaseBindingV1,
  rawFencingToken: string,
): void {
  if (binding.blobLeaseId !== lease.blobLeaseId
    || binding.ownerRunId !== lease.ownerRunId
    || digestFencingToken(rawFencingToken) !== lease.fencingTokenDigest) {
    fail('snapshot_blob_stale_binding', 'The snapshot blob binding is not authorized.');
  }
}

async function readCapability(paths: LeasePaths): Promise<CapabilityRecordV1> {
  const read = await readPrivateFile(paths.capability, MAX_CAPABILITY_BYTES);
  const value = parseJson(read.bytes, 'capability');
  if (!isRecord(value)
    || Object.keys(value).length !== 3
    || value['schemaVersion'] !== 1
    || typeof value['blobLeaseId'] !== 'string'
    || typeof value['rawFencingToken'] !== 'string') {
    integrity('The private snapshot blob capability is invalid.');
  }
  return value as unknown as CapabilityRecordV1;
}

async function removeCapabilityAfterTombstone(paths: LeasePaths): Promise<void> {
  try {
    await unlink(paths.capability);
    await syncDirectory(paths.directory);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function readJournal(
  paths: LeasePaths,
  persistedLease: SnapshotBlobLeaseV1,
): Promise<readonly SnapshotBlobLeaseEventV1[]> {
  const directoryEntries = await readdir(paths.events, { withFileTypes: true });
  if (directoryEntries.some((entry) =>
    !entry.isFile() || !EVENT_FILE_PATTERN.test(entry.name))) {
    integrity('The snapshot blob journal contains an unknown entry.');
  }
  const names = directoryEntries
    .map((entry) => entry.name)
    .toSorted();
  if (names.length === 0 || names.length > persistedLease.casRevision + 2) {
    integrity('The snapshot blob journal length is invalid.');
  }
  const events: SnapshotBlobLeaseEventV1[] = [];
  for (const [index, name] of names.entries()) {
    const match = EVENT_FILE_PATTERN.exec(name);
    if (match?.[1] !== String(index).padStart(12, '0')) {
      integrity('The snapshot blob journal sequence has a gap.');
    }
    const read = await readPrivateFile(join(paths.events, name), MAX_METADATA_BYTES);
    const value = parseJson(read.bytes, 'journal event');
    if (!validateSnapshotBlobLeaseEvent(value) || value.sequence !== index) {
      integrity('A snapshot blob journal event is invalid.');
    }
    events.push(value);
  }

  const initialEvent = events[0];
  if (initialEvent === undefined) {
    integrity('The initial snapshot blob journal event is missing.');
  }
  let replay = createSnapshotBlobLease({
    blobLeaseId: persistedLease.blobLeaseId,
    createdByRunId: persistedLease.createdByRunId,
    ownerRunId: persistedLease.ownerRunId,
    sourceSnapshotDigest: persistedLease.sourceSnapshotDigest,
    snapshotPolicyDigest: persistedLease.snapshotPolicyDigest,
    materializationPolicyDigest: persistedLease.materializationPolicyDigest,
    manifestDigest: persistedLease.manifestDigest,
    privateBlobPathIdentity: persistedLease.privateBlobPathIdentity,
    contentDigest: persistedLease.contentDigest,
    payloadSizeBytes: persistedLease.payloadSizeBytes,
    entryCount: persistedLease.entryCount,
    createdAt: persistedLease.createdAt,
    expiresAt: persistedLease.expiresAt,
    fencingTokenDigest: persistedLease.fencingTokenDigest,
  });
  if (!validateInitialSnapshotBlobLease(replay.lease, initialEvent)
    || canonicalJson(replay.event) !== canonicalJson(initialEvent)) {
    integrity('The initial snapshot blob journal event does not match the lease.');
  }
  for (const event of events.slice(1)) {
    const next = transitionSnapshotBlobLease(replay.lease, {
      toState: event.toState,
      occurredAt: event.occurredAt,
      reasonCode: event.reasonCode,
    });
    if (!validateSnapshotBlobLeaseTransition(replay.lease, event, next.lease)
      || canonicalJson(next.event) !== canonicalJson(event)) {
      integrity('The snapshot blob journal chain is invalid.');
    }
    replay = next;
  }
  const persistedReplay = events.length === persistedLease.casRevision + 1
    ? replay.lease
    : replayFromEvents(events.slice(0, -1), persistedLease);
  if (canonicalJson(persistedReplay) !== canonicalJson(persistedLease)) {
    integrity('The snapshot blob lease does not match its journal.');
  }
  return events;
}

function replayFromEvents(
  events: readonly SnapshotBlobLeaseEventV1[],
  template: SnapshotBlobLeaseV1,
): SnapshotBlobLeaseV1 {
  let replay = createSnapshotBlobLease({
    blobLeaseId: template.blobLeaseId,
    createdByRunId: template.createdByRunId,
    ownerRunId: template.ownerRunId,
    sourceSnapshotDigest: template.sourceSnapshotDigest,
    snapshotPolicyDigest: template.snapshotPolicyDigest,
    materializationPolicyDigest: template.materializationPolicyDigest,
    manifestDigest: template.manifestDigest,
    privateBlobPathIdentity: template.privateBlobPathIdentity,
    contentDigest: template.contentDigest,
    payloadSizeBytes: template.payloadSizeBytes,
    entryCount: template.entryCount,
    createdAt: template.createdAt,
    expiresAt: template.expiresAt,
    fencingTokenDigest: template.fencingTokenDigest,
  });
  for (const event of events.slice(1)) {
    replay = transitionSnapshotBlobLease(replay.lease, {
      toState: event.toState,
      occurredAt: event.occurredAt,
      reasonCode: event.reasonCode,
    });
  }
  return replay.lease;
}

async function appendEvent(
  paths: LeasePaths,
  event: SnapshotBlobLeaseEventV1,
): Promise<void> {
  const name = `${String(event.sequence).padStart(12, '0')}.json`;
  await writePrivateExclusive(join(paths.events, name), canonicalJson(event));
  await syncDirectory(paths.events);
}

async function cleanupUnpublishedLease(paths: LeasePaths): Promise<void> {
  const knownFiles = [
    paths.payload,
    paths.capability,
    paths.sourceSnapshot,
    paths.lease,
    paths.lock,
  ];
  for (const filePath of knownFiles) {
    await unlink(filePath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
  }
  const eventEntries = await readdir(paths.events, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    });
  for (const entry of eventEntries) {
    if (entry.isFile() && EVENT_FILE_PATTERN.test(entry.name)) {
      await unlink(join(paths.events, entry.name));
    }
  }
  await rmdir(`${paths.lock}.lock`).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error;
  });
  await rmdir(paths.events).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error;
  });
  await rmdir(paths.directory).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error;
  });
  await syncDirectory(dirname(paths.directory));
}

async function writePrivateExclusive(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    if (process.platform !== 'win32') await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(filePath));
}

async function writePrivateAtomic(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp.${process.pid}.${randomUUID()}`,
  );
  let renamed = false;
  try {
    await writePrivateExclusive(temporaryPath, content);
    if (process.platform === 'win32') {
      await unlink(filePath).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
    }
    await rename(temporaryPath, filePath);
    renamed = true;
    await syncDirectory(dirname(filePath));
  } finally {
    if (!renamed) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

async function readPrivateFile(
  filePath: string,
  maxBytes: number,
): Promise<PrivateFileRead> {
  const noFollow = process.platform === 'win32'
    ? 0
    : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      fail('snapshot_blob_not_found', `Private snapshot blob file ${basename(filePath)} is missing.`);
    }
    integrity(
      `Unable to safely open private snapshot blob file ${basename(filePath)}.`,
      error,
    );
  }
  try {
    const opened = await handle.stat();
    await assertPrivateRegularStats(opened, filePath);
    const linked = await lstat(filePath);
    await assertPrivateRegularStats(linked, filePath);
    if (!sameFile(opened, linked)) {
      integrity(`Private snapshot blob file ${basename(filePath)} changed while opening.`);
    }
    if (opened.size > maxBytes) {
      integrity(`Private snapshot blob file ${basename(filePath)} exceeds its limit.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(opened, after) || after.size !== bytes.byteLength) {
      integrity(`Private snapshot blob file ${basename(filePath)} changed while reading.`);
    }
    return { bytes, stats: after };
  } finally {
    await handle.close();
  }
}

async function assertPrivateFile(filePath: string, maxBytes: number): Promise<void> {
  await readPrivateFile(filePath, maxBytes);
}

async function assertPrivateDirectory(directoryPath: string): Promise<void> {
  const linked = await lstat(directoryPath);
  if (!linked.isDirectory() || linked.isSymbolicLink()) {
    integrity(`Private snapshot blob directory ${basename(directoryPath)} is unsafe.`);
  }
  if (process.platform !== 'win32') {
    if ((linked.mode & 0o777) !== DIRECTORY_MODE) {
      integrity(`Private snapshot blob directory ${basename(directoryPath)} is not mode 0700.`);
    }
    if (typeof process.getuid === 'function' && linked.uid !== process.getuid()) {
      integrity(`Private snapshot blob directory ${basename(directoryPath)} has another owner.`);
    }
  } else {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(directoryPath));
    } catch (error) {
      integrity(
        `Private snapshot blob directory ${basename(directoryPath)} has an unsafe Windows ACL.`,
        error,
      );
    }
  }
}

async function assertPrivateRegularStats(
  stats: Stats | BigIntStats,
  filePath: string,
): Promise<void> {
  if (!stats.isFile() || stats.isSymbolicLink() || Number(stats.nlink) !== 1) {
    integrity(`Private snapshot blob file ${basename(filePath)} is not a single regular file.`);
  }
  if (process.platform !== 'win32') {
    if ((Number(stats.mode) & 0o777) !== PRIVATE_FILE_MODE) {
      integrity(`Private snapshot blob file ${basename(filePath)} is not mode 0600.`);
    }
    if (typeof process.getuid === 'function' && Number(stats.uid) !== process.getuid()) {
      integrity(`Private snapshot blob file ${basename(filePath)} has another owner.`);
    }
  }
}

async function computePrivateBlobPathIdentity(
  rootDirectory: string,
  leaseDirectory: string,
  payloadPath: string,
): Promise<string> {
  const rootStats = await lstat(rootDirectory);
  const leaseStats = await lstat(leaseDirectory);
  const payload = await readPrivateFile(payloadPath, SNAPSHOT_BLOB_MAX_BYTES);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()
    || !leaseStats.isDirectory() || leaseStats.isSymbolicLink()) {
    integrity('The private snapshot blob directory identity is unsafe.');
  }
  return canonicalDigest(PATH_IDENTITY_DOMAIN, {
    rootRealPath: await realpath(rootDirectory),
    root: stableDirectoryIdentity(rootStats),
    lease: stableDirectoryIdentity(leaseStats),
    payload: stableFileIdentity(payload.stats),
  });
}

async function assertPayloadIdentity(
  rootDirectory: string,
  paths: LeasePaths,
  expectedIdentity: string,
  allowAlreadyUnlinked: boolean,
): Promise<void> {
  try {
    const identity = await computePrivateBlobPathIdentity(
      rootDirectory,
      paths.directory,
      paths.payload,
    );
    if (identity !== expectedIdentity) {
      integrity('The private snapshot blob path identity changed before destruction.');
    }
  } catch (error) {
    if (error instanceof SnapshotBlobLeaseStoreError
      && error.reasonCode === 'snapshot_blob_not_found') {
      if (allowAlreadyUnlinked) {
        // A prior crash may have completed the exact unlink after the durable
        // destroying event but before the destroyed tombstone.
        return;
      }
      integrity('The snapshot blob payload disappeared before destroy was prepared.');
    }
    throw error;
  }
}

function stableDirectoryIdentity(stats: Stats | BigIntStats): Record<string, unknown> {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    modeType: Number(stats.mode) & fsConstants.S_IFMT,
    uid: Number(stats.uid),
  };
}

function stableFileIdentity(stats: Stats | BigIntStats): Record<string, unknown> {
  return {
    ...stableDirectoryIdentity(stats),
    nlink: Number(stats.nlink),
  };
}

function sameFile(left: Stats | BigIntStats, right: Stats | BigIntStats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && Number(left.mode) === Number(right.mode)
    && Number(left.nlink) === Number(right.nlink);
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directoryPath, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function digestFencingToken(rawFencingToken: string): string {
  return canonicalDigest(FENCING_DIGEST_DOMAIN, rawFencingToken);
}

function canonicalNow(now: () => Date, notBefore?: string): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('snapshot_blob_invalid_input', 'The snapshot blob clock returned an invalid time.');
  }
  const timestamp = value.toISOString();
  if (notBefore !== undefined && Date.parse(timestamp) < Date.parse(notBefore)) {
    fail('snapshot_blob_invalid_input', 'The snapshot blob clock moved backwards.');
  }
  return timestamp;
}

function assertCanonicalFutureTimestamp(expiresAt: string, createdAt: string): void {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== expiresAt
    || parsed <= Date.parse(createdAt)) {
    fail('snapshot_blob_invalid_input', 'The snapshot blob expiry is invalid.');
  }
}

function isExpired(lease: SnapshotBlobLeaseV1, now: Date): boolean {
  return now.getTime() >= Date.parse(lease.expiresAt);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function assertLeaseId(blobLeaseId: string): void {
  if (!UUID_PATTERN.test(blobLeaseId)) {
    fail('snapshot_blob_invalid_input', 'The snapshot blob lease id is invalid.');
  }
}

function assertReason(reasonCode: string): void {
  if (!REASON_PATTERN.test(reasonCode)
    || containsSensitiveText(reasonCode)) {
    fail('snapshot_blob_invalid_input', 'The snapshot blob destruction reason is invalid.');
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    const text = bytes.toString('utf8');
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      integrity(`The snapshot blob ${label} is not canonical JSON.`);
    }
    return value;
  } catch (error) {
    if (error instanceof SnapshotBlobLeaseStoreError) throw error;
    integrity(`The snapshot blob ${label} is invalid JSON.`, error);
  }
}

function invalidState(
  lease: SnapshotBlobLeaseV1,
  expected: SnapshotBlobLeaseStateV1,
): never {
  fail(
    'snapshot_blob_invalid_state',
    `Snapshot blob lease ${lease.blobLeaseId} is ${lease.state}; expected ${expected}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function integrity(message: string, cause?: unknown): never {
  fail('snapshot_blob_integrity_failed', message, cause);
}

function fail(
  reasonCode: SnapshotBlobLeaseStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new SnapshotBlobLeaseStoreError(
    reasonCode,
    message,
    cause === undefined ? undefined : { cause },
  );
}
