import { canonicalDigest, canonicalJson } from './finish-line';
import { containsSensitiveText } from './redaction';

export const SNAPSHOT_BLOB_PAYLOAD_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_BLOB_MAX_BYTES = 66 * 1024 * 1024 + 24;

export type SnapshotBlobLeaseStateV1 =
  | 'staging'
  | 'sealed'
  | 'confirmed'
  | 'materializing'
  | 'consumed'
  | 'expired'
  | 'corrupt'
  | 'destroying'
  | 'destroyed';

export type SnapshotBlobLeaseEventTypeV1 =
  | 'staged'
  | 'sealed'
  | 'confirmed'
  | 'materialization_started'
  | 'consumed'
  | 'expired'
  | 'corrupt'
  | 'destroy_started'
  | 'destroyed';

export interface SnapshotBlobLeaseV1 {
  readonly schemaVersion: 1;
  readonly blobLeaseId: string;
  readonly createdByRunId: string;
  readonly ownerRunId: string;
  readonly sourceSnapshotDigest: string;
  readonly snapshotPolicyDigest: string;
  readonly materializationPolicyDigest: string;
  readonly manifestDigest: string;
  readonly privateBlobPathIdentity: string;
  readonly contentDigest: string;
  readonly payloadFormatVersion: 1;
  readonly payloadSizeBytes: number;
  readonly entryCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sealedAt: string | null;
  readonly expiresAt: string;
  readonly destroyedAt: string | null;
  readonly state: SnapshotBlobLeaseStateV1;
  readonly casRevision: number;
  readonly fencingTokenDigest: string;
  readonly journalHeadDigest: string;
  readonly leaseDigest: string;
}

export interface SnapshotBlobLeaseEventV1 {
  readonly schemaVersion: 1;
  readonly blobLeaseId: string;
  readonly sequence: number;
  readonly eventType: SnapshotBlobLeaseEventTypeV1;
  readonly fromState: SnapshotBlobLeaseStateV1 | null;
  readonly toState: SnapshotBlobLeaseStateV1;
  readonly ownerRunId: string;
  readonly fencingTokenDigest: string;
  readonly previousLeaseDigest: string | null;
  readonly previousEventDigest: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
  readonly eventDigest: string;
}

export interface CreateSnapshotBlobLeaseInputV1 {
  readonly blobLeaseId: string;
  readonly createdByRunId: string;
  readonly ownerRunId: string;
  readonly sourceSnapshotDigest: string;
  readonly snapshotPolicyDigest: string;
  readonly materializationPolicyDigest: string;
  readonly manifestDigest: string;
  readonly privateBlobPathIdentity: string;
  readonly contentDigest: string;
  readonly payloadSizeBytes: number;
  readonly entryCount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fencingTokenDigest: string;
}

export interface TransitionSnapshotBlobLeaseInputV1 {
  readonly toState: SnapshotBlobLeaseStateV1;
  readonly occurredAt: string;
  readonly reasonCode?: string | null;
}

export interface SnapshotBlobLeaseTransitionV1 {
  readonly lease: SnapshotBlobLeaseV1;
  readonly event: SnapshotBlobLeaseEventV1;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_ENTRY_COUNT = 4_096;

const LEASE_KEYS = [
  'schemaVersion',
  'blobLeaseId',
  'createdByRunId',
  'ownerRunId',
  'sourceSnapshotDigest',
  'snapshotPolicyDigest',
  'materializationPolicyDigest',
  'manifestDigest',
  'privateBlobPathIdentity',
  'contentDigest',
  'payloadFormatVersion',
  'payloadSizeBytes',
  'entryCount',
  'createdAt',
  'updatedAt',
  'sealedAt',
  'expiresAt',
  'destroyedAt',
  'state',
  'casRevision',
  'fencingTokenDigest',
  'journalHeadDigest',
  'leaseDigest',
] as const;

const EVENT_KEYS = [
  'schemaVersion',
  'blobLeaseId',
  'sequence',
  'eventType',
  'fromState',
  'toState',
  'ownerRunId',
  'fencingTokenDigest',
  'previousLeaseDigest',
  'previousEventDigest',
  'occurredAt',
  'reasonCode',
  'eventDigest',
] as const;

const EVENT_TYPE_BY_STATE = {
  staging: 'staged',
  sealed: 'sealed',
  confirmed: 'confirmed',
  materializing: 'materialization_started',
  consumed: 'consumed',
  expired: 'expired',
  corrupt: 'corrupt',
  destroying: 'destroy_started',
  destroyed: 'destroyed',
} as const satisfies Record<SnapshotBlobLeaseStateV1, SnapshotBlobLeaseEventTypeV1>;

const ALLOWED_TRANSITIONS = {
  staging: ['sealed', 'expired', 'corrupt', 'destroying'],
  sealed: ['confirmed', 'expired', 'corrupt', 'destroying'],
  confirmed: ['materializing', 'expired', 'corrupt', 'destroying'],
  materializing: ['consumed', 'expired', 'corrupt', 'destroying'],
  consumed: ['destroying'],
  expired: ['destroying'],
  corrupt: ['destroying'],
  destroying: ['destroyed'],
  destroyed: [],
} as const satisfies Record<SnapshotBlobLeaseStateV1, readonly SnapshotBlobLeaseStateV1[]>;

export function createSnapshotBlobLease(
  input: CreateSnapshotBlobLeaseInputV1,
): SnapshotBlobLeaseTransitionV1 {
  assertCreateInput(input);
  const eventCore = {
    schemaVersion: 1 as const,
    blobLeaseId: input.blobLeaseId,
    sequence: 0,
    eventType: 'staged' as const,
    fromState: null,
    toState: 'staging' as const,
    ownerRunId: input.ownerRunId,
    fencingTokenDigest: input.fencingTokenDigest,
    previousLeaseDigest: null,
    previousEventDigest: null,
    occurredAt: input.createdAt,
    reasonCode: null,
  };
  const event: SnapshotBlobLeaseEventV1 = {
    ...eventCore,
    eventDigest: canonicalDigest('wukong/snapshot-blob-lease-event/v1', eventCore),
  };
  const leaseCore = {
    schemaVersion: 1 as const,
    blobLeaseId: input.blobLeaseId,
    createdByRunId: input.createdByRunId,
    ownerRunId: input.ownerRunId,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    snapshotPolicyDigest: input.snapshotPolicyDigest,
    materializationPolicyDigest: input.materializationPolicyDigest,
    manifestDigest: input.manifestDigest,
    privateBlobPathIdentity: input.privateBlobPathIdentity,
    contentDigest: input.contentDigest,
    payloadFormatVersion: SNAPSHOT_BLOB_PAYLOAD_FORMAT_VERSION,
    payloadSizeBytes: input.payloadSizeBytes,
    entryCount: input.entryCount,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    sealedAt: null,
    expiresAt: input.expiresAt,
    destroyedAt: null,
    state: 'staging' as const,
    casRevision: 0,
    fencingTokenDigest: input.fencingTokenDigest,
    journalHeadDigest: event.eventDigest,
  };
  const lease: SnapshotBlobLeaseV1 = {
    ...leaseCore,
    leaseDigest: canonicalDigest('wukong/snapshot-blob-lease/v1', leaseCore),
  };
  if (!validateSnapshotBlobLease(lease)
    || !validateInitialSnapshotBlobLease(lease, event)) {
    throw new Error('Unable to create a valid snapshot blob lease.');
  }
  return { lease, event };
}

export function transitionSnapshotBlobLease(
  current: SnapshotBlobLeaseV1,
  input: TransitionSnapshotBlobLeaseInputV1,
): SnapshotBlobLeaseTransitionV1 {
  if (!validateSnapshotBlobLease(current)) {
    throw new Error('The current snapshot blob lease is invalid.');
  }
  if (!ALLOWED_TRANSITIONS[current.state].includes(input.toState as never)) {
    throw new Error(
      `Invalid snapshot blob lease transition: ${current.state} -> ${input.toState}.`,
    );
  }
  if (!isCanonicalTimestamp(input.occurredAt)
    || Date.parse(input.occurredAt) < Date.parse(current.updatedAt)) {
    throw new Error('Snapshot blob lease transition time is invalid.');
  }
  if ((input.toState === 'sealed'
    || input.toState === 'confirmed'
    || input.toState === 'materializing')
    && Date.parse(input.occurredAt) >= Date.parse(current.expiresAt)) {
    throw new Error('The snapshot blob lease expired before the requested transition.');
  }
  const reasonCode = input.reasonCode ?? null;
  if (requiresReason(input.toState) !== (reasonCode !== null)
    || (reasonCode !== null && !isReasonCode(reasonCode))) {
    throw new Error(`Snapshot blob lease transition ${input.toState} has an invalid reason.`);
  }
  const eventCore = {
    schemaVersion: 1 as const,
    blobLeaseId: current.blobLeaseId,
    sequence: current.casRevision + 1,
    eventType: EVENT_TYPE_BY_STATE[input.toState],
    fromState: current.state,
    toState: input.toState,
    ownerRunId: current.ownerRunId,
    fencingTokenDigest: current.fencingTokenDigest,
    previousLeaseDigest: current.leaseDigest,
    previousEventDigest: current.journalHeadDigest,
    occurredAt: input.occurredAt,
    reasonCode,
  };
  const event: SnapshotBlobLeaseEventV1 = {
    ...eventCore,
    eventDigest: canonicalDigest('wukong/snapshot-blob-lease-event/v1', eventCore),
  };
  const leaseCore = {
    ...withoutLeaseDigest(current),
    state: input.toState,
    casRevision: event.sequence,
    updatedAt: input.occurredAt,
    sealedAt: input.toState === 'sealed' ? input.occurredAt : current.sealedAt,
    destroyedAt: input.toState === 'destroyed' ? input.occurredAt : current.destroyedAt,
    journalHeadDigest: event.eventDigest,
  };
  const lease: SnapshotBlobLeaseV1 = {
    ...leaseCore,
    leaseDigest: canonicalDigest('wukong/snapshot-blob-lease/v1', leaseCore),
  };
  if (!validateSnapshotBlobLeaseTransition(current, event, lease)) {
    throw new Error('Unable to create a valid snapshot blob lease transition.');
  }
  return { lease, event };
}

export function validateSnapshotBlobLease(value: unknown): value is SnapshotBlobLeaseV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, LEASE_KEYS)) return false;
  const lease = value as unknown as SnapshotBlobLeaseV1;
  if (lease.schemaVersion !== 1
    || lease.payloadFormatVersion !== SNAPSHOT_BLOB_PAYLOAD_FORMAT_VERSION
    || !isOpaqueId(lease.blobLeaseId)
    || !isOpaqueId(lease.createdByRunId)
    || !isOpaqueId(lease.ownerRunId)
    || !isDigest(lease.sourceSnapshotDigest)
    || !isDigest(lease.snapshotPolicyDigest)
    || !isDigest(lease.materializationPolicyDigest)
    || !isDigest(lease.manifestDigest)
    || !isDigest(lease.privateBlobPathIdentity)
    || !isDigest(lease.contentDigest)
    || !isDigest(lease.fencingTokenDigest)
    || !isDigest(lease.journalHeadDigest)
    || !isDigest(lease.leaseDigest)
    || !Number.isSafeInteger(lease.payloadSizeBytes)
    || lease.payloadSizeBytes <= 0
    || lease.payloadSizeBytes > SNAPSHOT_BLOB_MAX_BYTES
    || !Number.isSafeInteger(lease.entryCount)
    || lease.entryCount < 0
    || lease.entryCount > MAX_ENTRY_COUNT
    || !Number.isSafeInteger(lease.casRevision)
    || lease.casRevision < 0
    || !isCanonicalTimestamp(lease.createdAt)
    || !isCanonicalTimestamp(lease.updatedAt)
    || !isCanonicalTimestamp(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= Date.parse(lease.createdAt)
    || !isNullableTimestamp(lease.sealedAt)
    || !isNullableTimestamp(lease.destroyedAt)
    || !isSnapshotBlobLeaseState(lease.state)) {
    return false;
  }
  if (lease.sealedAt !== null
    && Date.parse(lease.sealedAt) < Date.parse(lease.createdAt)) return false;
  if (lease.sealedAt !== null
    && Date.parse(lease.sealedAt) >= Date.parse(lease.expiresAt)) return false;
  if (Date.parse(lease.updatedAt) < Date.parse(lease.createdAt)) return false;
  if (lease.sealedAt !== null
    && Date.parse(lease.updatedAt) < Date.parse(lease.sealedAt)) return false;
  if (lease.destroyedAt !== null
    && (Date.parse(lease.destroyedAt) < Date.parse(lease.createdAt)
      || lease.destroyedAt !== lease.updatedAt)) return false;
  if (lease.state === 'staging' && lease.sealedAt !== null) return false;
  if (lease.state === 'staging' && lease.casRevision !== 0) return false;
  if ((lease.state === 'sealed'
    || lease.state === 'confirmed'
    || lease.state === 'materializing')
    && Date.parse(lease.updatedAt) >= Date.parse(lease.expiresAt)) return false;
  if ((lease.state === 'sealed'
    || lease.state === 'confirmed'
    || lease.state === 'materializing'
    || lease.state === 'consumed')
    && lease.sealedAt === null) return false;
  if (lease.state === 'destroyed' ? lease.destroyedAt === null : lease.destroyedAt !== null) {
    return false;
  }
  const core = withoutLeaseDigest(lease);
  return canonicalDigest('wukong/snapshot-blob-lease/v1', core) === lease.leaseDigest;
}

export function validateSnapshotBlobLeaseEvent(
  value: unknown,
): value is SnapshotBlobLeaseEventV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, EVENT_KEYS)) return false;
  const event = value as unknown as SnapshotBlobLeaseEventV1;
  if (event.schemaVersion !== 1
    || !isOpaqueId(event.blobLeaseId)
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 0
    || !isSnapshotBlobLeaseEventType(event.eventType)
    || !isNullableSnapshotBlobLeaseState(event.fromState)
    || !isSnapshotBlobLeaseState(event.toState)
    || EVENT_TYPE_BY_STATE[event.toState] !== event.eventType
    || !isOpaqueId(event.ownerRunId)
    || !isDigest(event.fencingTokenDigest)
    || !isNullableDigest(event.previousLeaseDigest)
    || !isNullableDigest(event.previousEventDigest)
    || !isCanonicalTimestamp(event.occurredAt)
    || !isNullableReasonCode(event.reasonCode)
    || !isDigest(event.eventDigest)) {
    return false;
  }
  if (event.sequence === 0) {
    if (event.eventType !== 'staged'
      || event.fromState !== null
      || event.toState !== 'staging'
      || event.previousLeaseDigest !== null
      || event.previousEventDigest !== null
      || event.reasonCode !== null) return false;
  } else if (event.fromState === null
    || event.previousLeaseDigest === null
    || event.previousEventDigest === null
    || !ALLOWED_TRANSITIONS[event.fromState].includes(event.toState as never)
    || requiresReason(event.toState) !== (event.reasonCode !== null)) return false;
  const { eventDigest, ...core } = event;
  return canonicalDigest('wukong/snapshot-blob-lease-event/v1', core) === eventDigest;
}

export function validateInitialSnapshotBlobLease(
  lease: SnapshotBlobLeaseV1,
  event: SnapshotBlobLeaseEventV1,
): boolean {
  return validateSnapshotBlobLease(lease)
    && validateSnapshotBlobLeaseEvent(event)
    && lease.state === 'staging'
    && lease.casRevision === 0
    && lease.journalHeadDigest === event.eventDigest
    && lease.createdAt === event.occurredAt
    && lease.updatedAt === lease.createdAt
    && lease.blobLeaseId === event.blobLeaseId
    && lease.ownerRunId === event.ownerRunId
    && lease.fencingTokenDigest === event.fencingTokenDigest;
}

export function validateSnapshotBlobLeaseTransition(
  previous: SnapshotBlobLeaseV1,
  event: SnapshotBlobLeaseEventV1,
  next: SnapshotBlobLeaseV1,
): boolean {
  if (!validateSnapshotBlobLease(previous)
    || !validateSnapshotBlobLeaseEvent(event)
    || !validateSnapshotBlobLease(next)
    || event.sequence !== previous.casRevision + 1
    || event.fromState !== previous.state
    || event.previousLeaseDigest !== previous.leaseDigest
    || event.previousEventDigest !== previous.journalHeadDigest
    || Date.parse(event.occurredAt) < Date.parse(previous.updatedAt)
    || event.blobLeaseId !== previous.blobLeaseId
    || event.ownerRunId !== previous.ownerRunId
    || event.fencingTokenDigest !== previous.fencingTokenDigest) {
    return false;
  }
  try {
    const expected = transitionSnapshotBlobLeaseUnchecked(previous, {
      toState: event.toState,
      occurredAt: event.occurredAt,
      reasonCode: event.reasonCode,
    });
    return canonicalJson(expected.event) === canonicalJson(event)
      && canonicalJson(expected.lease) === canonicalJson(next);
  } catch {
    return false;
  }
}

function transitionSnapshotBlobLeaseUnchecked(
  current: SnapshotBlobLeaseV1,
  input: Required<TransitionSnapshotBlobLeaseInputV1>,
): SnapshotBlobLeaseTransitionV1 {
  const eventCore = {
    schemaVersion: 1 as const,
    blobLeaseId: current.blobLeaseId,
    sequence: current.casRevision + 1,
    eventType: EVENT_TYPE_BY_STATE[input.toState],
    fromState: current.state,
    toState: input.toState,
    ownerRunId: current.ownerRunId,
    fencingTokenDigest: current.fencingTokenDigest,
    previousLeaseDigest: current.leaseDigest,
    previousEventDigest: current.journalHeadDigest,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
  };
  const event: SnapshotBlobLeaseEventV1 = {
    ...eventCore,
    eventDigest: canonicalDigest('wukong/snapshot-blob-lease-event/v1', eventCore),
  };
  const leaseCore = {
    ...withoutLeaseDigest(current),
    state: input.toState,
    casRevision: event.sequence,
    updatedAt: input.occurredAt,
    sealedAt: input.toState === 'sealed' ? input.occurredAt : current.sealedAt,
    destroyedAt: input.toState === 'destroyed' ? input.occurredAt : current.destroyedAt,
    journalHeadDigest: event.eventDigest,
  };
  return {
    event,
    lease: {
      ...leaseCore,
      leaseDigest: canonicalDigest('wukong/snapshot-blob-lease/v1', leaseCore),
    },
  };
}

function assertCreateInput(input: CreateSnapshotBlobLeaseInputV1): void {
  if (!isOpaqueId(input.blobLeaseId)
    || !isOpaqueId(input.createdByRunId)
    || !isOpaqueId(input.ownerRunId)
    || !isDigest(input.sourceSnapshotDigest)
    || !isDigest(input.snapshotPolicyDigest)
    || !isDigest(input.materializationPolicyDigest)
    || !isDigest(input.manifestDigest)
    || !isDigest(input.privateBlobPathIdentity)
    || !isDigest(input.contentDigest)
    || !isDigest(input.fencingTokenDigest)
    || !Number.isSafeInteger(input.payloadSizeBytes)
    || input.payloadSizeBytes <= 0
    || input.payloadSizeBytes > SNAPSHOT_BLOB_MAX_BYTES
    || !Number.isSafeInteger(input.entryCount)
    || input.entryCount < 0
    || input.entryCount > MAX_ENTRY_COUNT
    || !isCanonicalTimestamp(input.createdAt)
    || !isCanonicalTimestamp(input.expiresAt)
    || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) {
    throw new Error('Snapshot blob lease creation input is invalid.');
  }
}

function withoutLeaseDigest(
  lease: SnapshotBlobLeaseV1,
): Omit<SnapshotBlobLeaseV1, 'leaseDigest'> {
  const { leaseDigest: _leaseDigest, ...core } = lease;
  return core;
}

function requiresReason(state: SnapshotBlobLeaseStateV1): boolean {
  return state === 'expired' || state === 'corrupt' || state === 'destroying';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string'
    && OPAQUE_ID.test(value)
    && !containsSensitiveText(value);
}

function isNullableReasonCode(value: unknown): value is string | null {
  return value === null || isReasonCode(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isCanonicalTimestamp(value);
}

function isSnapshotBlobLeaseState(value: unknown): value is SnapshotBlobLeaseStateV1 {
  return typeof value === 'string' && Object.hasOwn(EVENT_TYPE_BY_STATE, value);
}

function isNullableSnapshotBlobLeaseState(
  value: unknown,
): value is SnapshotBlobLeaseStateV1 | null {
  return value === null || isSnapshotBlobLeaseState(value);
}

function isSnapshotBlobLeaseEventType(
  value: unknown,
): value is SnapshotBlobLeaseEventTypeV1 {
  return typeof value === 'string'
    && Object.values(EVENT_TYPE_BY_STATE).includes(value as SnapshotBlobLeaseEventTypeV1);
}
