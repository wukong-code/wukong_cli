import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  adoptTargetPromotionLease,
  canonicalDigest,
  canonicalJson,
  createTargetPromotionLease,
  targetPromotionRegistryKey,
  transitionTargetPromotionLease,
  validatePromotionConsentBinding,
  validateTargetPromotionLease,
  validateTargetStateFingerprint,
  type PromotionConsentBindingV1,
  type TargetPromotionLeaseStateV1,
  type TargetPromotionLeaseV1,
  type TargetStateFingerprintV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

import {
  probeProcessLiveness,
  validateProcessLivenessProof,
  type ProcessLivenessProofV1,
  type ProcessLivenessOutcome,
} from './process-liveness-proof';
import {
  validateDurableBoundaryTestFaultCapability,
  type DurableBoundaryTestFaultCapabilityV1,
} from './durable-boundary-test-fault';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_FILE = '.target-promotion.lock';
const LEASE_FILE = 'lease.json';
const CAPABILITY_FILE = 'capability.json';
const ADOPTION_PENDING_FILE = 'adoption-pending.json';
const EVENTS_DIRECTORY = 'events';
const EVENT_PATTERN = /^([0-9]{12})\.json$/u;
const MAX_BYTES = 8 * 1024 * 1024;

const rawFencingTokens =
  new WeakMap<TargetPromotionLeaseBindingV1, string>();

export type TargetPromotionLeaseStoreErrorCode =
  | 'promotion_lease_invalid_input'
  | 'promotion_target_busy'
  | 'promotion_owner_live'
  | 'promotion_liveness_unproven'
  | 'promotion_adoption_unsafe_state'
  | 'promotion_lease_not_found'
  | 'promotion_fencing_lost'
  | 'promotion_lease_integrity_failed'
  | 'promotion_lease_root_unsafe'
  | 'promotion_lease_lock_failed';

export class TargetPromotionLeaseStoreError extends Error {
  constructor(
    readonly reasonCode: TargetPromotionLeaseStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TargetPromotionLeaseStoreError';
  }
}

export class TargetPromotionLeaseBindingV1 {
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly registryRevision: number;
  readonly leaseDigest: string;

  private constructor(
    lease: TargetPromotionLeaseV1,
    rawFencingToken: string,
  ) {
    this.targetPromotionLeaseId = lease.targetPromotionLeaseId;
    this.targetRegistryKey = lease.targetRegistryKey;
    this.registryRevision = lease.registryRevision;
    this.leaseDigest = lease.leaseDigest;
    rawFencingTokens.set(this, rawFencingToken);
    Object.freeze(this);
  }

  static create(
    lease: TargetPromotionLeaseV1,
    rawFencingToken: string,
  ): TargetPromotionLeaseBindingV1 {
    return new TargetPromotionLeaseBindingV1(lease, rawFencingToken);
  }

  toJSON(): Record<string, unknown> {
    return {
      targetPromotionLeaseId: this.targetPromotionLeaseId,
      targetRegistryKey: this.targetRegistryKey,
      registryRevision: this.registryRevision,
      leaseDigest: this.leaseDigest,
      rawFencingToken: '[REDACTED]',
    };
  }
}

export interface TargetPromotionLeaseAuthorityV1 {
  readonly lease: TargetPromotionLeaseV1;
  readonly binding: TargetPromotionLeaseBindingV1;
}

export interface TargetPromotionExclusiveLeaseViewV1 {
  readonly lease: TargetPromotionLeaseV1;
  /** Trusted internal path. Never expose it to a model or persist it publicly. */
  readonly registryDirectory: string;
  readonly assertAuthority: () => Promise<void>;
}

interface TargetPromotionLeaseEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType:
    | 'acquired'
    | 'transitioned'
    | 'ownership_adopted';
  readonly previousEventDigest: string | null;
  readonly previousLeaseDigest: string | null;
  readonly nextLease: TargetPromotionLeaseV1;
  readonly occurredAt: string;
  readonly eventDigest: string;
}

interface CapabilityRecordV1 {
  readonly schemaVersion: 1;
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly rawFencingToken: string;
  readonly processLivenessProof: ProcessLivenessProofV1 | null;
}

interface AdoptionPendingV1 {
  readonly schemaVersion: 1;
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly previousLeaseDigest: string;
  readonly nextLease: TargetPromotionLeaseV1;
  readonly nextRawFencingToken: string;
  readonly nextProcessLivenessProof: ProcessLivenessProofV1;
  readonly pendingDigest: string;
}

interface RegistryPaths {
  readonly directory: string;
  readonly lock: string;
  readonly lease: string;
  readonly capability: string;
  readonly adoptionPending: string;
  readonly events: string;
}

export class TargetPromotionLeaseStore {
  private readonly registryRootDirectory: string;
  private readonly now: () => Date;
  private readonly lockStaleMs: number;
  private readonly probeLiveness: (
    proof: ProcessLivenessProofV1,
  ) => Promise<ProcessLivenessOutcome>;

  constructor(options: {
    readonly registryRootDirectory: string;
    readonly now?: () => Date;
    readonly probeLiveness?: (
      proof: ProcessLivenessProofV1,
    ) => Promise<ProcessLivenessOutcome>;
    /**
     * Reduces the orphan-lock recovery window only in hard-crash tests.
     * Production callers must never supply this.
     */
    readonly _testFaultCapability?:
      DurableBoundaryTestFaultCapabilityV1;
  }) {
    if (typeof options?.registryRootDirectory !== 'string'
      || !isAbsolute(options.registryRootDirectory)
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.probeLiveness !== undefined
        && typeof options.probeLiveness !== 'function')
      || (options._testFaultCapability !== undefined
        && !validateDurableBoundaryTestFaultCapability(
          options._testFaultCapability,
        ))) {
      fail(
        'promotion_lease_invalid_input',
        'Target promotion registry options are invalid.',
      );
    }
    this.registryRootDirectory = resolve(options.registryRootDirectory);
    this.now = options.now ?? (() => new Date());
    this.lockStaleMs =
      options._testFaultCapability === undefined
        ? 30_000
        : 2_000;
    this.probeLiveness =
      options.probeLiveness ?? probeProcessLiveness;
  }

  async acquire(input: {
    readonly consent: PromotionConsentBindingV1;
    readonly targetFingerprint: TargetStateFingerprintV1;
    readonly ownerRunId: string;
    readonly ownerProcessIdentityDigest: string;
    readonly ownerProcessLivenessProof?: ProcessLivenessProofV1;
  }): Promise<TargetPromotionLeaseAuthorityV1> {
    if (!validatePromotionConsentBinding(input.consent)
      || !validateTargetStateFingerprint(input.targetFingerprint)
      || input.consent.targetFingerprintDigest
        !== input.targetFingerprint.fingerprintDigest
      || input.consent.targetWorkspaceIdentity
        !== input.targetFingerprint.targetWorkspaceIdentity
      || input.consent.targetGitCommonDirIdentity
        !== input.targetFingerprint.targetGitCommonDirIdentity
      || !isIdentifier(input.ownerRunId)
      || !isDigest(input.ownerProcessIdentityDigest)
      || (input.ownerProcessLivenessProof !== undefined
        && (!validateProcessLivenessProof(
          input.ownerProcessLivenessProof,
        )
          || input.ownerProcessLivenessProof.proofDigest
            !== input.ownerProcessIdentityDigest))) {
      fail(
        'promotion_lease_invalid_input',
        'Target promotion acquisition input is invalid.',
      );
    }
    const key = targetPromotionRegistryKey(input.targetFingerprint);
    const paths = await this.preparePaths(key);
    return this.withLock(paths, async () => {
      const loaded = await this.loadOrRecover(paths, false);
      if (loaded !== null && loaded.lease.state !== 'released') {
        fail(
          'promotion_target_busy',
          'Another promotion owner holds this target registry.',
        );
      }
      const rawFencingToken = randomBytes(32).toString('base64url');
      const acquiredAt = timestamp(this.now());
      const lease = createTargetPromotionLease({
        targetPromotionLeaseId: randomUUID(),
        registryRevision: loaded === null
          ? 0
          : loaded.lease.registryRevision + 1,
        targetFingerprint: input.targetFingerprint,
        promotionId: input.consent.promotionId,
        candidateId: input.consent.candidateId,
        promotionConsentDigest: input.consent.consentDigest,
        candidateDeltaDigest: input.consent.candidateDeltaDigest,
        candidateGateResultDigest:
          input.consent.candidateGateResultDigest,
        ownerRunId: input.ownerRunId,
        ownerProcessIdentityDigest: input.ownerProcessIdentityDigest,
        fencingTokenDigest: fencingDigest(rawFencingToken),
        acquiredAt,
        previousLeaseDigest: loaded?.lease.leaseDigest ?? null,
      });
      const event = createEvent({
        lease,
        eventType: 'acquired',
        previousEventDigest: loaded?.lastEventDigest ?? null,
        occurredAt: acquiredAt,
      });
      await persistEvent(paths, event);
      await writePrivateAtomic(paths.lease, canonicalJson(lease));
      await writePrivateAtomic(paths.capability, canonicalJson({
        schemaVersion: 1,
        targetPromotionLeaseId: lease.targetPromotionLeaseId,
        targetRegistryKey: lease.targetRegistryKey,
        rawFencingToken,
        processLivenessProof:
          input.ownerProcessLivenessProof ?? null,
      } satisfies CapabilityRecordV1));
      return authority(lease, rawFencingToken);
    });
  }

  async adoptAcquired(input: {
    readonly targetRegistryKey: string;
    readonly ownerRunId: string;
    readonly expectedLeaseDigest: string;
    readonly nextProcessLivenessProof: ProcessLivenessProofV1;
  }): Promise<TargetPromotionLeaseAuthorityV1> {
    return this.adoptRecoverable(input, 'acquired');
  }

  async adoptApplying(input: {
    readonly targetRegistryKey: string;
    readonly ownerRunId: string;
    readonly expectedLeaseDigest: string;
    readonly nextProcessLivenessProof: ProcessLivenessProofV1;
  }): Promise<TargetPromotionLeaseAuthorityV1> {
    return this.adoptRecoverable(input, 'applying');
  }

  async adoptFinalVerifying(input: {
    readonly targetRegistryKey: string;
    readonly ownerRunId: string;
    readonly expectedLeaseDigest: string;
    readonly nextProcessLivenessProof: ProcessLivenessProofV1;
  }): Promise<TargetPromotionLeaseAuthorityV1> {
    return this.adoptRecoverable(input, 'final_verifying');
  }

  private async adoptRecoverable(input: {
    readonly targetRegistryKey: string;
    readonly ownerRunId: string;
    readonly expectedLeaseDigest: string;
    readonly nextProcessLivenessProof: ProcessLivenessProofV1;
  }, expectedState: 'acquired' | 'applying' | 'final_verifying'):
  Promise<TargetPromotionLeaseAuthorityV1> {
    if (!isDigest(input.targetRegistryKey)
      || !isIdentifier(input.ownerRunId)
      || !isDigest(input.expectedLeaseDigest)
      || !validateProcessLivenessProof(
        input.nextProcessLivenessProof,
      )) {
      fail(
        'promotion_lease_invalid_input',
        'Target promotion adoption input is invalid.',
      );
    }
    const paths = await this.preparePaths(input.targetRegistryKey);
    return this.withLock(paths, async () => {
      const loaded = await this.loadOrRecover(paths, true);
      if (loaded === null
        || loaded.lease.ownerRunId !== input.ownerRunId
        || loaded.lease.leaseDigest !== input.expectedLeaseDigest) {
        fail(
          'promotion_fencing_lost',
          'Target promotion adoption no longer matches its owner.',
        );
      }
      if (loaded.lease.state !== expectedState) {
        fail(
          'promotion_adoption_unsafe_state',
          `Only a ${expectedState} promotion can use this adoption path.`,
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
          'promotion_liveness_unproven',
          'The previous promotion owner has no distinct liveness proof.',
        );
      }
      const liveness = await this.probeLiveness(previousProof);
      if (liveness === 'live') {
        fail(
          'promotion_owner_live',
          'The previous promotion owner is still live.',
        );
      }
      if (liveness !== 'dead') {
        fail(
          'promotion_liveness_unproven',
          'The previous promotion owner is not provably dead.',
        );
      }
      const nextRawFencingToken =
        randomBytes(32).toString('base64url');
      const occurredAt = timestamp(
        this.now(),
        loaded.lease.lastHeartbeatAt,
      );
      const next = adoptTargetPromotionLease(loaded.lease, {
        expectedOwnerProcessIdentityDigest:
          loaded.lease.ownerProcessIdentityDigest,
        expectedFencingTokenDigest:
          loaded.lease.fencingTokenDigest,
        nextOwnerProcessIdentityDigest:
          input.nextProcessLivenessProof.proofDigest,
        nextFencingTokenDigest:
          fencingDigest(nextRawFencingToken),
        occurredAt,
      });
      const pending = createAdoptionPending({
        previousLease: loaded.lease,
        nextLease: next,
        nextRawFencingToken,
        nextProcessLivenessProof:
          input.nextProcessLivenessProof,
      });
      await writePrivateExclusive(
        paths.adoptionPending,
        canonicalJson(pending),
      );
      const event = createEvent({
        lease: next,
        eventType: 'ownership_adopted',
        previousEventDigest: loaded.lastEventDigest,
        occurredAt,
      });
      await persistEvent(paths, event);
      await writePrivateAtomic(paths.lease, canonicalJson(next));
      await writePrivateAtomic(
        paths.capability,
        canonicalJson(capabilityFor(
          next,
          nextRawFencingToken,
          input.nextProcessLivenessProof,
        )),
      );
      await removePending(paths);
      return authority(next, nextRawFencingToken);
    });
  }

  async inspect(targetRegistryKey: string): Promise<TargetPromotionLeaseV1> {
    if (!isDigest(targetRegistryKey)) {
      fail(
        'promotion_lease_invalid_input',
        'Target promotion registry key is invalid.',
      );
    }
    const paths = await this.preparePaths(targetRegistryKey);
    return this.withLock(paths, async () => {
      const loaded = await this.loadOrRecover(paths, true);
      if (loaded === null) {
        fail(
          'promotion_lease_not_found',
          'Target promotion lease was not found.',
        );
      }
      return loaded.lease;
    });
  }

  async transition(
    binding: TargetPromotionLeaseBindingV1,
    toState: TargetPromotionLeaseStateV1,
  ): Promise<TargetPromotionLeaseAuthorityV1> {
    const rawFencingToken = getRawFencingToken(binding);
    const paths = await this.preparePaths(binding.targetRegistryKey);
    return this.withLock(paths, async () => {
      const loaded = await this.loadOrRecover(paths, true);
      if (loaded === null) {
        fail(
          'promotion_lease_not_found',
          'Target promotion lease was not found.',
        );
      }
      await assertBinding(paths, loaded.lease, binding, rawFencingToken);
      const occurredAt = timestamp(this.now(), loaded.lease.lastHeartbeatAt);
      let next: TargetPromotionLeaseV1;
      try {
        next = transitionTargetPromotionLease(loaded.lease, {
          toState,
          expectedFencingTokenDigest:
            loaded.lease.fencingTokenDigest,
          occurredAt,
        });
      } catch (error) {
        fail(
          'promotion_lease_invalid_input',
          'Target promotion lease transition is invalid.',
          error,
        );
      }
      const event = createEvent({
        lease: next,
        eventType: 'transitioned',
        previousEventDigest: loaded.lastEventDigest,
        occurredAt,
      });
      await persistEvent(paths, event);
      await writePrivateAtomic(paths.lease, canonicalJson(next));
      return authority(next, rawFencingToken);
    });
  }

  async resumeOwned(input: {
    readonly targetRegistryKey: string;
    readonly ownerRunId: string;
    readonly ownerProcessIdentityDigest: string;
    readonly expectedLeaseDigest: string;
  }): Promise<TargetPromotionLeaseAuthorityV1> {
    if (!isDigest(input.targetRegistryKey)
      || !isIdentifier(input.ownerRunId)
      || !isDigest(input.ownerProcessIdentityDigest)
      || !isDigest(input.expectedLeaseDigest)) {
      fail(
        'promotion_lease_invalid_input',
        'Target promotion resume input is invalid.',
      );
    }
    const paths = await this.preparePaths(input.targetRegistryKey);
    return this.withLock(paths, async () => {
      const loaded = await this.loadOrRecover(paths, true);
      if (loaded === null
        || loaded.lease.state === 'released'
        || loaded.lease.ownerRunId !== input.ownerRunId
        || loaded.lease.ownerProcessIdentityDigest
          !== input.ownerProcessIdentityDigest
        || loaded.lease.leaseDigest !== input.expectedLeaseDigest) {
        fail(
          'promotion_fencing_lost',
          'Target promotion ownership no longer matches this process.',
        );
      }
      const capability = await readCapability(paths);
      return authority(loaded.lease, capability.rawFencingToken);
    });
  }

  async withExclusiveLease<Result>(
    binding: TargetPromotionLeaseBindingV1,
    expectedState: Exclude<TargetPromotionLeaseStateV1, 'released'>,
    callback: (
      view: TargetPromotionExclusiveLeaseViewV1,
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    if (typeof callback !== 'function'
      || ![
        'acquired',
        'applying',
        'final_verifying',
        'reconciliation_required',
      ].includes(expectedState)) {
      fail(
        'promotion_lease_invalid_input',
        'Exclusive target promotion lease input is invalid.',
      );
    }
    const rawFencingToken = getRawFencingToken(binding);
    const paths = await this.preparePaths(binding.targetRegistryKey);
    return this.withLock(paths, async () => {
      const loaded = await this.loadOrRecover(paths, true);
      if (loaded === null) {
        fail(
          'promotion_lease_not_found',
          'Target promotion lease was not found.',
        );
      }
      await assertBinding(
        paths,
        loaded.lease,
        binding,
        rawFencingToken,
      );
      if (loaded.lease.state !== expectedState) {
        fail(
          'promotion_lease_invalid_input',
          `Target promotion lease must be ${expectedState}.`,
        );
      }
      let active = true;
      const assertAuthority = async (): Promise<void> => {
        if (!active) {
          fail(
            'promotion_fencing_lost',
            'Exclusive target promotion authority escaped its lock.',
          );
        }
        const current = await this.loadOrRecover(paths, true);
        if (current === null
          || current.lease.state !== expectedState) {
          fail(
            'promotion_fencing_lost',
            'Exclusive target promotion authority changed.',
          );
        }
        await assertBinding(
          paths,
          current.lease,
          binding,
          rawFencingToken,
        );
      };
      const view = Object.freeze({
        lease: loaded.lease,
        registryDirectory: paths.directory,
        assertAuthority,
      });
      try {
        return await callback(view);
      } finally {
        try {
          await assertAuthority();
        } finally {
          active = false;
        }
      }
    });
  }

  private async preparePaths(
    targetRegistryKey: string,
  ): Promise<RegistryPaths> {
    await ensurePrivateDirectory(this.registryRootDirectory);
    const directory = join(
      this.registryRootDirectory,
      targetRegistryKey.slice('sha256:'.length),
    );
    await ensurePrivateDirectory(directory);
    const events = join(directory, EVENTS_DIRECTORY);
    await ensurePrivateDirectory(events);
    const lock = join(directory, LOCK_FILE);
    await ensurePrivateFile(lock);
    return {
      directory,
      lock,
      lease: join(directory, LEASE_FILE),
      capability: join(directory, CAPABILITY_FILE),
      adoptionPending: join(directory, ADOPTION_PENDING_FILE),
      events,
    };
  }

  private async withLock<Result>(
    paths: RegistryPaths,
    callback: () => Promise<Result>,
  ): Promise<Result> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(paths.lock, {
        realpath: false,
        stale: this.lockStaleMs,
        retries: { retries: 40, minTimeout: 10, maxTimeout: 100 },
      });
    } catch (error) {
      fail(
        'promotion_lease_lock_failed',
        'Unable to lock target promotion registry.',
        error,
      );
    }
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  private async loadOrRecover(
    paths: RegistryPaths,
    requireCapability: boolean,
  ): Promise<{
    readonly lease: TargetPromotionLeaseV1;
    readonly lastEventDigest: string;
  } | null> {
    const [persisted, events] = await Promise.all([
      readLeaseOrNull(paths.lease),
      readEvents(paths.events),
    ]);
    if (persisted === null && events.length === 0) return null;
    if (events.length === 0) integrity('Target promotion journal is missing.');
    validateEventChain(events);
    const last = events.at(-1);
    if (last === undefined) integrity('Target promotion journal is empty.');
    if (persisted === null
      || (events.length >= 2
        && persisted.leaseDigest === events.at(-2)?.nextLease.leaseDigest)) {
      await writePrivateAtomic(paths.lease, canonicalJson(last.nextLease));
    } else if (persisted.leaseDigest !== last.nextLease.leaseDigest) {
      integrity('Target promotion lease diverges from its journal.');
    }
    await reconcileAdoptionPending(paths, last.nextLease);
    if (requireCapability) {
      const capability = await readCapability(paths);
      if (capability.targetPromotionLeaseId
          !== last.nextLease.targetPromotionLeaseId
        || capability.targetRegistryKey
          !== last.nextLease.targetRegistryKey
        || fencingDigest(capability.rawFencingToken)
          !== last.nextLease.fencingTokenDigest) {
        integrity('Target promotion capability does not match its lease.');
      }
    }
    return {
      lease: last.nextLease,
      lastEventDigest: last.eventDigest,
    };
  }
}

function createEvent(input: {
  readonly lease: TargetPromotionLeaseV1;
  readonly eventType: TargetPromotionLeaseEventV1['eventType'];
  readonly previousEventDigest: string | null;
  readonly occurredAt: string;
}): TargetPromotionLeaseEventV1 {
  const core = {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    sequence: input.lease.registryRevision,
    eventType: input.eventType,
    previousEventDigest: input.previousEventDigest,
    previousLeaseDigest: input.lease.previousLeaseDigest,
    nextLease: input.lease,
    occurredAt: input.occurredAt,
  };
  return Object.freeze({
    ...core,
    eventDigest: canonicalDigest(
      'wukong/target-promotion-lease-event/v1',
      core,
    ),
  });
}

function validateEventChain(
  events: readonly TargetPromotionLeaseEventV1[],
): void {
  let previous: TargetPromotionLeaseEventV1 | undefined;
  for (const event of events) {
    if (!validateEvent(event)
      || !validateEventSemantics(event, previous)
      || (previous === undefined
        ? event.previousEventDigest !== null
          || (event.sequence !== 0
            && event.previousLeaseDigest === null)
        : event.sequence !== previous.sequence + 1
          || event.previousEventDigest !== previous.eventDigest
          || event.previousLeaseDigest
            !== previous.nextLease.leaseDigest)) {
      integrity('Target promotion journal chain is invalid.');
    }
    previous = event;
  }
}

function validateEventSemantics(
  event: TargetPromotionLeaseEventV1,
  previous: TargetPromotionLeaseEventV1 | undefined,
): boolean {
  if (event.eventType === 'acquired') {
    return event.nextLease.state === 'acquired'
      && (previous === undefined
        ? event.sequence === 0
        : previous.nextLease.state === 'released'
          && event.sequence === previous.sequence + 1);
  }
  if (previous === undefined) return false;
  try {
    if (event.eventType === 'ownership_adopted') {
      return (previous.nextLease.state === 'acquired'
          || previous.nextLease.state === 'applying'
          || previous.nextLease.state === 'final_verifying')
        && adoptTargetPromotionLease(previous.nextLease, {
          expectedOwnerProcessIdentityDigest:
            previous.nextLease.ownerProcessIdentityDigest,
          expectedFencingTokenDigest:
            previous.nextLease.fencingTokenDigest,
          nextOwnerProcessIdentityDigest:
            event.nextLease.ownerProcessIdentityDigest,
          nextFencingTokenDigest:
            event.nextLease.fencingTokenDigest,
          occurredAt: event.occurredAt,
        }).leaseDigest === event.nextLease.leaseDigest;
    }
    return transitionTargetPromotionLease(previous.nextLease, {
      toState: event.nextLease.state,
      expectedFencingTokenDigest:
        previous.nextLease.fencingTokenDigest,
      occurredAt: event.occurredAt,
    }).leaseDigest === event.nextLease.leaseDigest;
  } catch {
    return false;
  }
}

function validateEvent(
  value: unknown,
): value is TargetPromotionLeaseEventV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'eventDigest', 'eventId', 'eventType', 'nextLease',
      'occurredAt', 'previousEventDigest', 'previousLeaseDigest',
      'schemaVersion', 'sequence',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['eventId'])
    || !isNonNegativeInteger(value['sequence'])
    || (value['eventType'] !== 'acquired'
      && value['eventType'] !== 'transitioned'
      && value['eventType'] !== 'ownership_adopted')
    || !isNullableDigest(value['previousEventDigest'])
    || !isNullableDigest(value['previousLeaseDigest'])
    || !validateTargetPromotionLease(value['nextLease'])
    || !isTimestamp(value['occurredAt'])
    || !isDigest(value['eventDigest'])) {
    return false;
  }
  const event = value as unknown as TargetPromotionLeaseEventV1;
  const { eventDigest, ...core } = event;
  return event.sequence === event.nextLease.registryRevision
    && event.previousLeaseDigest === event.nextLease.previousLeaseDigest
    && canonicalDigest(
      'wukong/target-promotion-lease-event/v1',
      core,
    ) === eventDigest;
}

async function readEvents(
  directory: string,
): Promise<readonly TargetPromotionLeaseEventV1[]> {
  const entries = await readdir(directory);
  if (entries.some((name) => !EVENT_PATTERN.test(name))) {
    integrity('Target promotion event directory contains an unknown entry.');
  }
  const names = entries.toSorted();
  const events: TargetPromotionLeaseEventV1[] = [];
  for (const name of names) {
    const value = JSON.parse(await readPrivateFile(
      join(directory, name),
    )) as unknown;
    if (!validateEvent(value)) integrity('Target promotion event is invalid.');
    events.push(value);
  }
  return events;
}

async function readLeaseOrNull(
  path: string,
): Promise<TargetPromotionLeaseV1 | null> {
  try {
    const value = JSON.parse(await readPrivateFile(path)) as unknown;
    if (!validateTargetPromotionLease(value)) {
      integrity('Target promotion lease is invalid.');
    }
    return value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function readCapability(
  paths: RegistryPaths,
): Promise<CapabilityRecordV1> {
  let value: unknown;
  try {
    value = JSON.parse(await readPrivateFile(paths.capability)) as unknown;
  } catch (error) {
    integrity('Target promotion capability is unreadable.', error);
  }
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'processLivenessProof', 'rawFencingToken', 'schemaVersion',
      'targetPromotionLeaseId', 'targetRegistryKey',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetRegistryKey'])
    || typeof value['rawFencingToken'] !== 'string'
    || value['rawFencingToken'].length < 32
    || (value['processLivenessProof'] !== null
      && !validateProcessLivenessProof(
        value['processLivenessProof'],
      ))) {
    integrity('Target promotion capability is invalid.');
  }
  return value as unknown as CapabilityRecordV1;
}

function capabilityFor(
  lease: TargetPromotionLeaseV1,
  rawFencingToken: string,
  processLivenessProof: ProcessLivenessProofV1 | null,
): CapabilityRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    targetPromotionLeaseId: lease.targetPromotionLeaseId,
    targetRegistryKey: lease.targetRegistryKey,
    rawFencingToken,
    processLivenessProof,
  });
}

function createAdoptionPending(input: {
  readonly previousLease: TargetPromotionLeaseV1;
  readonly nextLease: TargetPromotionLeaseV1;
  readonly nextRawFencingToken: string;
  readonly nextProcessLivenessProof: ProcessLivenessProofV1;
}): AdoptionPendingV1 {
  const core = {
    schemaVersion: 1 as const,
    targetPromotionLeaseId:
      input.nextLease.targetPromotionLeaseId,
    targetRegistryKey: input.nextLease.targetRegistryKey,
    previousLeaseDigest: input.previousLease.leaseDigest,
    nextLease: input.nextLease,
    nextRawFencingToken: input.nextRawFencingToken,
    nextProcessLivenessProof:
      input.nextProcessLivenessProof,
  };
  return Object.freeze({
    ...core,
    pendingDigest: canonicalDigest(
      'wukong/target-promotion-adoption-pending/v1',
      core,
    ),
  });
}

async function readAdoptionPendingOrNull(
  path: string,
): Promise<AdoptionPendingV1 | null> {
  try {
    const value = JSON.parse(await readPrivateFile(path)) as unknown;
    if (!validateAdoptionPending(value)) {
      integrity('Target promotion adoption pending record is invalid.');
    }
    return value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

function validateAdoptionPending(
  value: unknown,
): value is AdoptionPendingV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'nextLease', 'nextProcessLivenessProof',
      'nextRawFencingToken', 'pendingDigest',
      'previousLeaseDigest', 'schemaVersion',
      'targetPromotionLeaseId', 'targetRegistryKey',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetRegistryKey'])
    || !isDigest(value['previousLeaseDigest'])
    || !validateTargetPromotionLease(value['nextLease'])
    || typeof value['nextRawFencingToken'] !== 'string'
    || value['nextRawFencingToken'].length < 32
    || !validateProcessLivenessProof(
      value['nextProcessLivenessProof'],
    )
    || !isDigest(value['pendingDigest'])) {
    return false;
  }
  const pending = value as unknown as AdoptionPendingV1;
  const { pendingDigest, ...core } = pending;
  return pending.targetPromotionLeaseId
      === pending.nextLease.targetPromotionLeaseId
    && pending.targetRegistryKey
      === pending.nextLease.targetRegistryKey
    && pending.nextProcessLivenessProof.proofDigest
      === pending.nextLease.ownerProcessIdentityDigest
    && fencingDigest(pending.nextRawFencingToken)
      === pending.nextLease.fencingTokenDigest
    && pending.nextLease.previousLeaseDigest
      === pending.previousLeaseDigest
    && canonicalDigest(
      'wukong/target-promotion-adoption-pending/v1',
      core,
    ) === pendingDigest;
}

async function reconcileAdoptionPending(
  paths: RegistryPaths,
  currentLease: TargetPromotionLeaseV1,
): Promise<void> {
  const pending = await readAdoptionPendingOrNull(
    paths.adoptionPending,
  );
  if (pending === null) return;
  if (currentLease.leaseDigest === pending.previousLeaseDigest) {
    await removePending(paths);
    return;
  }
  if (currentLease.leaseDigest
      !== pending.nextLease.leaseDigest) {
    integrity(
      'Target promotion adoption pending record diverges from its lease.',
    );
  }
  await writePrivateAtomic(
    paths.capability,
    canonicalJson(capabilityFor(
      pending.nextLease,
      pending.nextRawFencingToken,
      pending.nextProcessLivenessProof,
    )),
  );
  await removePending(paths);
}

async function removePending(paths: RegistryPaths): Promise<void> {
  await unlink(paths.adoptionPending).catch((error) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
  await syncDirectory(paths.directory);
}

async function persistEvent(
  paths: RegistryPaths,
  event: TargetPromotionLeaseEventV1,
): Promise<void> {
  const path = join(
    paths.events,
    `${String(event.sequence).padStart(12, '0')}.json`,
  );
  try {
    await writePrivateExclusive(path, canonicalJson(event));
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    const existing = JSON.parse(await readPrivateFile(path)) as unknown;
    if (!validateEvent(existing)
      || existing.eventDigest !== event.eventDigest) {
      integrity('Target promotion event sequence is already occupied.');
    }
  }
}

async function assertBinding(
  paths: RegistryPaths,
  lease: TargetPromotionLeaseV1,
  binding: TargetPromotionLeaseBindingV1,
  rawFencingToken: string,
): Promise<void> {
  if (binding.targetPromotionLeaseId
      !== lease.targetPromotionLeaseId
    || binding.targetRegistryKey !== lease.targetRegistryKey
    || binding.registryRevision !== lease.registryRevision
    || binding.leaseDigest !== lease.leaseDigest
    || fencingDigest(rawFencingToken) !== lease.fencingTokenDigest) {
    fail(
      'promotion_fencing_lost',
      'Target promotion lease binding is stale.',
    );
  }
  const capability = await readCapability(paths);
  if (capability.rawFencingToken !== rawFencingToken) {
    fail(
      'promotion_fencing_lost',
      'Target promotion fencing token is stale.',
    );
  }
}

function authority(
  lease: TargetPromotionLeaseV1,
  rawFencingToken: string,
): TargetPromotionLeaseAuthorityV1 {
  return {
    lease,
    binding: TargetPromotionLeaseBindingV1.create(
      lease,
      rawFencingToken,
    ),
  };
}

function getRawFencingToken(
  binding: TargetPromotionLeaseBindingV1,
): string {
  if (!(binding instanceof TargetPromotionLeaseBindingV1)) {
    fail(
      'promotion_fencing_lost',
      'Target promotion lease binding is not authentic.',
    );
  }
  const value = rawFencingTokens.get(binding);
  if (value === undefined) {
    fail(
      'promotion_fencing_lost',
      'Target promotion fencing token is unavailable.',
    );
  }
  return value;
}

function fencingDigest(raw: string): string {
  return canonicalDigest(
    'wukong/target-promotion-fencing-token/v1',
    raw,
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, {
      recursive: false,
      mode: DIRECTORY_MODE,
    });
    created = true;
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  if (process.platform === 'win32' && created) {
    protectWindowsPrivateRootSecurity(path);
  }
  const [actual, linked] = await Promise.all([stat(path), lstat(path)]);
  if (!actual.isDirectory()
    || !linked.isDirectory()
    || linked.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== DIRECTORY_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))) {
    fail(
      'promotion_lease_root_unsafe',
      'Target promotion registry directory is unsafe.',
    );
  }
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch {
      fail(
        'promotion_lease_root_unsafe',
        'Target promotion registry has an unsafe Windows ACL.',
      );
    }
  }
}

async function ensurePrivateFile(path: string): Promise<void> {
  try {
    await writeFile(path, '', {
      flag: 'wx',
      mode: FILE_MODE,
    });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  const info = await lstat(path);
  if (!info.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1
    || (process.platform !== 'win32'
      && (info.mode & 0o777) !== FILE_MODE)) {
    fail(
      'promotion_lease_root_unsafe',
      'Target promotion registry file is unsafe.',
    );
  }
}

async function writePrivateExclusive(
  path: string,
  content: string,
): Promise<void> {
  const handle = await open(path, 'wx', FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(resolve(path, '..'));
}

async function writePrivateAtomic(
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, FILE_MODE);
  await syncDirectory(resolve(path, '..'));
}

async function readPrivateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1
    || info.size > MAX_BYTES
    || (process.platform !== 'win32'
      && (info.mode & 0o777) !== FILE_MODE)) {
    integrity('Target promotion private file is unsafe.');
  }
  return readFile(path, 'utf8');
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

function timestamp(now: Date, minimum?: string): string {
  if (!Number.isFinite(now.getTime())) {
    fail('promotion_lease_invalid_input', 'Current time is invalid.');
  }
  return new Date(Math.max(
    now.getTime(),
    minimum === undefined ? 0 : Date.parse(minimum),
  )).toISOString();
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function fail(
  reasonCode: TargetPromotionLeaseStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new TargetPromotionLeaseStoreError(
    reasonCode,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function integrity(message: string, cause?: unknown): never {
  fail('promotion_lease_integrity_failed', message, cause);
}
