import { canonicalDigest } from './finish-line';
import type { CandidateChangeOperationV1 } from './candidate-delta';

export type PromotionPathPresenceV1 = 'absent' | 'present';
export type PromotionPathFileTypeV1 =
  | 'regular'
  | 'directory'
  | 'symlink'
  | 'other';

export interface PromotionPathStateV1 {
  readonly schemaVersion: 1;
  readonly candidateRelativePath: string;
  readonly presence: PromotionPathPresenceV1;
  readonly fileType: PromotionPathFileTypeV1 | null;
  readonly mode: number | null;
  readonly contentDigest: string | null;
  readonly stateDigest: string;
}

export type PromotionChangeEventTypeV1 =
  | 'prepared'
  | 'applied'
  | 'reconciled'
  | 'conflict';

export interface PromotionChangeEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly previousEventDigest: string | null;
  readonly changeIndex: number;
  readonly operation: CandidateChangeOperationV1;
  readonly eventType: PromotionChangeEventTypeV1;
  readonly expectedPreimages: readonly PromotionPathStateV1[];
  readonly expectedPostimages: readonly PromotionPathStateV1[];
  readonly observedStates: readonly PromotionPathStateV1[];
  readonly targetFencingTokenDigest: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly eventDigest: string;
}

export type PromotionApplyJournalStateV1 =
  | 'applying'
  | 'applied'
  | 'conflicted'
  | 'reconciliation_required';

export interface PromotionApplyJournalV1 {
  readonly schemaVersion: 1;
  readonly journalId: string;
  readonly promotionId: string;
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly createdByTargetFencingTokenDigest: string;
  readonly currentTargetFencingTokenDigest: string;
  readonly targetFencingTokenLineage: readonly string[];
  readonly candidateId: string;
  readonly candidateDeltaDigest: string;
  readonly orderedChangeManifestDigest: string;
  readonly changeCount: number;
  readonly targetBeforeFingerprintDigest: string;
  readonly targetBeforeContentDigest: string;
  readonly materializedSourceDigest: string;
  readonly agentDeltaDigest: string;
  readonly events: readonly PromotionChangeEventV1[];
  readonly targetAfterFingerprintDigest: string | null;
  readonly state: PromotionApplyJournalStateV1;
  readonly journalHeadDigest: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000]+$/u;
const MAX_CHANGES = 400_000;

export function createPromotionPathState(input: {
  readonly candidateRelativePath: string;
  readonly presence: PromotionPathPresenceV1;
  readonly fileType: PromotionPathFileTypeV1 | null;
  readonly mode: number | null;
  readonly contentDigest: string | null;
}): PromotionPathStateV1 {
  const core = {
    schemaVersion: 1 as const,
    ...input,
  };
  const value = Object.freeze({
    ...core,
    stateDigest: canonicalDigest('wukong/promotion-path-state/v1', core),
  });
  if (!validatePromotionPathState(value)) {
    throw new TypeError('Promotion path state input is invalid.');
  }
  return value;
}

export function validatePromotionPathState(
  value: unknown,
): value is PromotionPathStateV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'candidateRelativePath',
      'contentDigest',
      'fileType',
      'mode',
      'presence',
      'schemaVersion',
      'stateDigest',
    ])
    || value['schemaVersion'] !== 1
    || !isPortablePath(value['candidateRelativePath'])
    || (value['presence'] !== 'absent' && value['presence'] !== 'present')
    || !isNullableFileType(value['fileType'])
    || !isNullableMode(value['mode'])
    || !isNullableDigest(value['contentDigest'])
    || !isDigest(value['stateDigest'])) {
    return false;
  }
  if (value['presence'] === 'absent'
    ? value['fileType'] !== null
      || value['mode'] !== null
      || value['contentDigest'] !== null
    : value['fileType'] === null
      || value['mode'] === null
      || (value['fileType'] === 'regular'
        ? value['contentDigest'] === null
        : value['contentDigest'] !== null)) {
    return false;
  }
  const state = value as unknown as PromotionPathStateV1;
  const { stateDigest, ...core } = state;
  return canonicalDigest('wukong/promotion-path-state/v1', core)
    === stateDigest;
}

export function createPromotionApplyJournal(input: {
  readonly journalId: string;
  readonly promotionId: string;
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly createdByTargetFencingTokenDigest: string;
  readonly candidateId: string;
  readonly candidateDeltaDigest: string;
  readonly orderedChangeManifestDigest: string;
  readonly changeCount: number;
  readonly targetBeforeFingerprintDigest: string;
  readonly targetBeforeContentDigest: string;
  readonly materializedSourceDigest: string;
  readonly agentDeltaDigest: string;
}): PromotionApplyJournalV1 {
  return sealJournal({
    schemaVersion: 1,
    ...input,
    currentTargetFencingTokenDigest:
      input.createdByTargetFencingTokenDigest,
    targetFencingTokenLineage: Object.freeze([
      input.createdByTargetFencingTokenDigest,
    ]),
    events: Object.freeze([]),
    targetAfterFingerprintDigest: null,
    state: 'applying',
  });
}

export function appendPromotionChangeEvent(
  journal: PromotionApplyJournalV1,
  input: Omit<
    PromotionChangeEventV1,
    'schemaVersion' | 'sequence' | 'previousEventDigest' | 'eventDigest'
  >,
): PromotionApplyJournalV1 {
  if (!validatePromotionApplyJournal(journal)
    || journal.state !== 'applying'
    || input.targetFencingTokenDigest
      !== journal.currentTargetFencingTokenDigest) {
    throw new TypeError('Promotion journal cannot accept this event.');
  }
  const previous = journal.events.at(-1);
  const eventCore = {
    schemaVersion: 1 as const,
    eventId: input.eventId,
    sequence: journal.events.length,
    previousEventDigest: previous?.eventDigest ?? null,
    changeIndex: input.changeIndex,
    operation: input.operation,
    eventType: input.eventType,
    expectedPreimages: Object.freeze([...input.expectedPreimages]),
    expectedPostimages: Object.freeze([...input.expectedPostimages]),
    observedStates: Object.freeze([...input.observedStates]),
    targetFencingTokenDigest: input.targetFencingTokenDigest,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
  };
  const event = Object.freeze({
    ...eventCore,
    eventDigest: canonicalDigest(
      'wukong/promotion-change-event/v1',
      eventCore,
    ),
  });
  if (!validatePromotionChangeEvent(event)
    || event.changeIndex >= journal.changeCount
    || !validNextEvent(previous, event)) {
    throw new TypeError('Promotion change event ordering is invalid.');
  }
  return sealJournal({
    ...journal,
    events: Object.freeze([...journal.events, event]),
    state: event.eventType === 'conflict'
      ? 'conflicted'
      : journal.state,
  });
}

export function adoptPromotionApplyJournalOwnership(
  journal: PromotionApplyJournalV1,
  input: {
    readonly expectedTargetFencingTokenDigest: string;
    readonly nextTargetFencingTokenDigest: string;
  },
): PromotionApplyJournalV1 {
  if (!validatePromotionApplyJournal(journal)
    || (journal.state !== 'applying' && journal.state !== 'applied')
    || input.expectedTargetFencingTokenDigest
      !== journal.currentTargetFencingTokenDigest
    || !isDigest(input.nextTargetFencingTokenDigest)
    || input.nextTargetFencingTokenDigest
      === journal.currentTargetFencingTokenDigest
    || journal.targetFencingTokenLineage.includes(
      input.nextTargetFencingTokenDigest,
    )) {
    throw new TypeError(
      'Promotion journal ownership adoption is invalid.',
    );
  }
  return sealJournal({
    ...journal,
    currentTargetFencingTokenDigest:
      input.nextTargetFencingTokenDigest,
    targetFencingTokenLineage: Object.freeze([
      ...journal.targetFencingTokenLineage,
      input.nextTargetFencingTokenDigest,
    ]),
  });
}

export function completePromotionApplyJournal(
  journal: PromotionApplyJournalV1,
  targetAfterFingerprintDigest: string,
): PromotionApplyJournalV1 {
  if (!validatePromotionApplyJournal(journal)
    || journal.state !== 'applying'
    || !isDigest(targetAfterFingerprintDigest)
    || !hasCompletedEveryChange(journal)) {
    throw new TypeError('Promotion journal is not complete.');
  }
  return sealJournal({
    ...journal,
    targetAfterFingerprintDigest,
    state: 'applied',
  });
}

export function requirePromotionReconciliation(
  journal: PromotionApplyJournalV1,
): PromotionApplyJournalV1 {
  if (!validatePromotionApplyJournal(journal)
    || journal.state === 'applied') {
    throw new TypeError('Promotion journal cannot require reconciliation.');
  }
  return sealJournal({
    ...journal,
    state: 'reconciliation_required',
  });
}

export function validatePromotionChangeEvent(
  value: unknown,
): value is PromotionChangeEventV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'changeIndex',
      'eventDigest',
      'eventId',
      'eventType',
      'expectedPostimages',
      'expectedPreimages',
      'idempotencyKey',
      'observedStates',
      'occurredAt',
      'operation',
      'previousEventDigest',
      'schemaVersion',
      'sequence',
      'targetFencingTokenDigest',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['eventId'])
    || !isNonNegativeInteger(value['sequence'])
    || !isNullableDigest(value['previousEventDigest'])
    || !isNonNegativeInteger(value['changeIndex'])
    || !isOperation(value['operation'])
    || !isEventType(value['eventType'])
    || !pathStateList(value['expectedPreimages'])
    || !pathStateList(value['expectedPostimages'])
    || !pathStateList(value['observedStates'])
    || !isDigest(value['targetFencingTokenDigest'])
    || !isDigest(value['idempotencyKey'])
    || !isTimestamp(value['occurredAt'])
    || !isDigest(value['eventDigest'])) {
    return false;
  }
  const event = value as unknown as PromotionChangeEventV1;
  const { eventDigest, ...core } = event;
  return canonicalDigest('wukong/promotion-change-event/v1', core)
    === eventDigest;
}

export function validatePromotionApplyJournal(
  value: unknown,
): value is PromotionApplyJournalV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'agentDeltaDigest',
      'candidateDeltaDigest',
      'candidateId',
      'changeCount',
      'createdByTargetFencingTokenDigest',
      'currentTargetFencingTokenDigest',
      'events',
      'journalHeadDigest',
      'journalId',
      'materializedSourceDigest',
      'orderedChangeManifestDigest',
      'promotionId',
      'schemaVersion',
      'state',
      'targetAfterFingerprintDigest',
      'targetBeforeContentDigest',
      'targetBeforeFingerprintDigest',
      'targetFencingTokenLineage',
      'targetPromotionLeaseId',
      'targetRegistryKey',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['journalId'])
    || !isUuid(value['promotionId'])
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetRegistryKey'])
    || !isDigest(value['createdByTargetFencingTokenDigest'])
    || !isDigest(value['currentTargetFencingTokenDigest'])
    || !Array.isArray(value['targetFencingTokenLineage'])
    || value['targetFencingTokenLineage'].length === 0
    || value['targetFencingTokenLineage'].length > MAX_CHANGES * 2 + 2
    || !value['targetFencingTokenLineage'].every(isDigest)
    || !isUuid(value['candidateId'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isDigest(value['orderedChangeManifestDigest'])
    || !isNonNegativeInteger(value['changeCount'])
    || value['changeCount'] > MAX_CHANGES
    || !isDigest(value['targetBeforeFingerprintDigest'])
    || !isDigest(value['targetBeforeContentDigest'])
    || !isDigest(value['materializedSourceDigest'])
    || !isDigest(value['agentDeltaDigest'])
    || !Array.isArray(value['events'])
    || value['events'].length > value['changeCount'] * 2
    || !isNullableDigest(value['targetAfterFingerprintDigest'])
    || !isJournalState(value['state'])
    || !isDigest(value['journalHeadDigest'])) {
    return false;
  }
  const journal = value as unknown as PromotionApplyJournalV1;
  if (journal.targetFencingTokenLineage[0]
      !== journal.createdByTargetFencingTokenDigest
    || journal.targetFencingTokenLineage.at(-1)
      !== journal.currentTargetFencingTokenDigest
    || new Set(journal.targetFencingTokenLineage).size
      !== journal.targetFencingTokenLineage.length) {
    return false;
  }
  let previous: PromotionChangeEventV1 | undefined;
  for (const event of journal.events) {
    if (!validatePromotionChangeEvent(event)
      || event.sequence !== (previous?.sequence ?? -1) + 1
      || event.previousEventDigest !== (previous?.eventDigest ?? null)
      || event.changeIndex >= journal.changeCount
      || !journal.targetFencingTokenLineage.includes(
        event.targetFencingTokenDigest,
      )
      || !validNextEvent(previous, event)) {
      return false;
    }
    previous = event;
  }
  if ((journal.state === 'applied'
      && (journal.targetAfterFingerprintDigest === null
        || !hasCompletedEveryChange(journal)))
    || (journal.state !== 'applied'
      && journal.targetAfterFingerprintDigest !== null)
    || (journal.state === 'conflicted'
      && previous?.eventType !== 'conflict')) {
    return false;
  }
  const { journalHeadDigest, ...core } = journal;
  return canonicalDigest('wukong/promotion-apply-journal/v1', core)
    === journalHeadDigest;
}

function sealJournal(
  input:
    | Omit<PromotionApplyJournalV1, 'journalHeadDigest'>
    | PromotionApplyJournalV1,
): PromotionApplyJournalV1 {
  const {
    journalHeadDigest: _discardedJournalHeadDigest,
    ...core
  } = input as PromotionApplyJournalV1;
  const value = Object.freeze({
    ...core,
    journalHeadDigest: canonicalDigest(
      'wukong/promotion-apply-journal/v1',
      core,
    ),
  });
  if (!validatePromotionApplyJournal(value)) {
    throw new TypeError('Promotion apply journal input is invalid.');
  }
  return value;
}

function validNextEvent(
  previous: PromotionChangeEventV1 | undefined,
  event: PromotionChangeEventV1,
): boolean {
  if (previous === undefined) {
    return event.changeIndex === 0 && event.eventType === 'prepared';
  }
  if (previous.eventType === 'prepared') {
    return event.changeIndex === previous.changeIndex
      && event.operation === previous.operation
      && event.idempotencyKey === previous.idempotencyKey
      && (event.eventType === 'applied'
        || event.eventType === 'reconciled'
        || event.eventType === 'conflict');
  }
  return (previous.eventType === 'applied'
      || previous.eventType === 'reconciled')
    && event.changeIndex === previous.changeIndex + 1
    && event.eventType === 'prepared';
}

function hasCompletedEveryChange(
  journal: PromotionApplyJournalV1,
): boolean {
  if (journal.changeCount === 0) return journal.events.length === 0;
  const last = journal.events.at(-1);
  return last?.changeIndex === journal.changeCount - 1
    && (last.eventType === 'applied' || last.eventType === 'reconciled');
}

function pathStateList(value: unknown): value is PromotionPathStateV1[] {
  return Array.isArray(value)
    && value.length <= 2
    && value.every(validatePromotionPathState)
    && new Set(value.map((entry) => entry.candidateRelativePath)).size
      === value.length;
}

function isPortablePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value) <= 4_096
    && value.split('/').every((segment) =>
      PORTABLE_SEGMENT.test(segment)
      && Buffer.byteLength(segment) <= 255);
}

function isNullableFileType(
  value: unknown,
): value is PromotionPathFileTypeV1 | null {
  return value === null
    || value === 'regular'
    || value === 'directory'
    || value === 'symlink'
    || value === 'other';
}

function isNullableMode(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 0
      && value <= 0o7777);
}

function isOperation(value: unknown): value is CandidateChangeOperationV1 {
  return value === 'create'
    || value === 'update'
    || value === 'delete'
    || value === 'rename'
    || value === 'mode';
}

function isEventType(value: unknown): value is PromotionChangeEventTypeV1 {
  return value === 'prepared'
    || value === 'applied'
    || value === 'reconciled'
    || value === 'conflict';
}

function isJournalState(value: unknown): value is PromotionApplyJournalStateV1 {
  return value === 'applying'
    || value === 'applied'
    || value === 'conflicted'
    || value === 'reconciliation_required';
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).toSorted().join(',')
    === [...expected].toSorted().join(',');
}
