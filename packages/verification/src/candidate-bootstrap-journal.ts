import { canonicalDigest } from './finish-line';

export type BootstrapExecutionJournalStateV1 =
  | 'ready'
  | 'step_prepared'
  | 'step_running'
  | 'blocked';

export type BootstrapExecutionEventTypeV1 =
  | 'prepared'
  | 'started'
  | 'observed'
  | 'reconciled'
  | 'failed'
  | 'ownership_adopted';

export interface BootstrapExecutionJournalV1 {
  readonly schemaVersion: 1;
  readonly journalId: string;
  readonly bootstrapPlanDigest: string;
  readonly leaseId: string;
  readonly createdByWorktreeFencingTokenDigest: string;
  readonly currentWorktreeFencingTokenDigest: string;
  readonly state: BootstrapExecutionJournalStateV1;
  readonly activeStepId: string | null;
  readonly revision: number;
  readonly journalHeadDigest: string;
  readonly journalDigest: string;
}

export interface BootstrapExecutionEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly journalId: string;
  readonly sequence: number;
  readonly previousEventDigest: string;
  readonly eventType: BootstrapExecutionEventTypeV1;
  readonly previousWorktreeFencingTokenDigest: string | null;
  readonly worktreeFencingTokenDigest: string;
  readonly stepId: string | null;
  readonly reservationId: string | null;
  readonly argvDigest: string | null;
  readonly effectiveEnvironmentDigest: string | null;
  readonly generatedScopeFingerprint: string | null;
  readonly exitCode: number | null;
  readonly idempotencyKey: string;
  readonly eventDigest: string;
}

export interface CreateBootstrapExecutionJournalInputV1 {
  readonly journalId: string;
  readonly bootstrapPlanDigest: string;
  readonly leaseId: string;
  readonly worktreeFencingTokenDigest: string;
}

export interface AppendBootstrapStepEventInputV1 {
  readonly eventId: string;
  readonly eventType: Exclude<
    BootstrapExecutionEventTypeV1,
    'ownership_adopted'
  >;
  readonly worktreeFencingTokenDigest: string;
  readonly stepId: string;
  readonly reservationId: string;
  readonly argvDigest: string;
  readonly effectiveEnvironmentDigest: string;
  readonly generatedScopeFingerprint?: string;
  readonly exitCode?: number;
  readonly idempotencyKey: string;
}

export interface AdoptBootstrapJournalOwnershipInputV1 {
  readonly eventId: string;
  readonly previousWorktreeFencingTokenDigest: string;
  readonly currentWorktreeFencingTokenDigest: string;
  readonly observedGeneratedScopeFingerprint: string;
  readonly idempotencyKey: string;
}

export interface BootstrapExecutionJournalTransitionV1 {
  readonly journal: BootstrapExecutionJournalV1;
  readonly event: BootstrapExecutionEventV1;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const JOURNAL_KEYS = [
  'schemaVersion',
  'journalId',
  'bootstrapPlanDigest',
  'leaseId',
  'createdByWorktreeFencingTokenDigest',
  'currentWorktreeFencingTokenDigest',
  'state',
  'activeStepId',
  'revision',
  'journalHeadDigest',
  'journalDigest',
] as const;

const EVENT_KEYS = [
  'schemaVersion',
  'eventId',
  'journalId',
  'sequence',
  'previousEventDigest',
  'eventType',
  'previousWorktreeFencingTokenDigest',
  'worktreeFencingTokenDigest',
  'stepId',
  'reservationId',
  'argvDigest',
  'effectiveEnvironmentDigest',
  'generatedScopeFingerprint',
  'exitCode',
  'idempotencyKey',
  'eventDigest',
] as const;

export function createBootstrapExecutionJournal(
  input: CreateBootstrapExecutionJournalInputV1,
): BootstrapExecutionJournalV1 {
  const genesis = canonicalDigest('wukong/bootstrap-execution-genesis/v1', {
    journalId: input.journalId,
    bootstrapPlanDigest: input.bootstrapPlanDigest,
    leaseId: input.leaseId,
    worktreeFencingTokenDigest: input.worktreeFencingTokenDigest,
  });
  const core = {
    schemaVersion: 1 as const,
    journalId: input.journalId,
    bootstrapPlanDigest: input.bootstrapPlanDigest,
    leaseId: input.leaseId,
    createdByWorktreeFencingTokenDigest:
      input.worktreeFencingTokenDigest,
    currentWorktreeFencingTokenDigest:
      input.worktreeFencingTokenDigest,
    state: 'ready' as const,
    activeStepId: null,
    revision: 0,
    journalHeadDigest: genesis,
  };
  const journal = sealJournal(core);
  if (!validateBootstrapExecutionJournal(journal)) {
    throw new TypeError('The bootstrap execution journal input is invalid.');
  }
  return journal;
}

export function appendBootstrapStepEvent(
  current: BootstrapExecutionJournalV1,
  input: AppendBootstrapStepEventInputV1,
): BootstrapExecutionJournalTransitionV1 {
  if (!validateBootstrapExecutionJournal(current)
    || !UUID.test(input.eventId)
    || !isStepEventType(input.eventType)
    || input.worktreeFencingTokenDigest
      !== current.currentWorktreeFencingTokenDigest
    || !isOpaque(input.stepId)
    || !UUID.test(input.reservationId)
    || !isDigest(input.argvDigest)
    || !isDigest(input.effectiveEnvironmentDigest)
    || !isOpaque(input.idempotencyKey)) {
    throw new TypeError('The bootstrap step event input is invalid.');
  }
  assertStepTransition(current, input);
  const terminalObservation =
    input.eventType === 'observed'
    || input.eventType === 'reconciled'
    || input.eventType === 'failed';
  const successfulObservation =
    input.eventType === 'observed'
    || input.eventType === 'reconciled';
  const generatedScopeFingerprint =
    input.generatedScopeFingerprint ?? null;
  const exitCode = input.exitCode ?? null;
  if (terminalObservation !== (
    isDigest(generatedScopeFingerprint)
    && Number.isSafeInteger(exitCode)
  )
    || (successfulObservation && exitCode !== 0)
    || (input.eventType === 'failed' && exitCode === 0)) {
    throw new TypeError('The bootstrap step observation is invalid.');
  }
  const event = sealEvent({
    schemaVersion: 1,
    eventId: input.eventId,
    journalId: current.journalId,
    sequence: current.revision + 1,
    previousEventDigest: current.journalHeadDigest,
    eventType: input.eventType,
    previousWorktreeFencingTokenDigest: null,
    worktreeFencingTokenDigest: input.worktreeFencingTokenDigest,
    stepId: input.stepId,
    reservationId: input.reservationId,
    argvDigest: input.argvDigest,
    effectiveEnvironmentDigest: input.effectiveEnvironmentDigest,
    generatedScopeFingerprint,
    exitCode,
    idempotencyKey: input.idempotencyKey,
  });
  const nextState: BootstrapExecutionJournalStateV1 =
    input.eventType === 'prepared'
      ? 'step_prepared'
      : input.eventType === 'started'
        ? 'step_running'
        : input.eventType === 'failed'
          ? 'blocked'
          : 'ready';
  const journal = sealJournal({
    ...withoutJournalDigest(current),
    state: nextState,
    activeStepId:
      nextState === 'step_prepared' || nextState === 'step_running'
        ? input.stepId
        : null,
    revision: event.sequence,
    journalHeadDigest: event.eventDigest,
  });
  if (!validateBootstrapExecutionJournalTransition(current, event, journal)) {
    throw new Error('Unable to append a valid bootstrap step event.');
  }
  return { journal, event };
}

export function adoptBootstrapJournalOwnership(
  current: BootstrapExecutionJournalV1,
  input: AdoptBootstrapJournalOwnershipInputV1,
): BootstrapExecutionJournalTransitionV1 {
  if (!validateBootstrapExecutionJournal(current)
    || current.state !== 'ready'
    || !UUID.test(input.eventId)
    || input.previousWorktreeFencingTokenDigest
      !== current.currentWorktreeFencingTokenDigest
    || !isDigest(input.currentWorktreeFencingTokenDigest)
    || input.currentWorktreeFencingTokenDigest
      === current.currentWorktreeFencingTokenDigest
    || !isDigest(input.observedGeneratedScopeFingerprint)
    || !isOpaque(input.idempotencyKey)) {
    throw new TypeError('The bootstrap journal adoption input is invalid.');
  }
  const event = sealEvent({
    schemaVersion: 1,
    eventId: input.eventId,
    journalId: current.journalId,
    sequence: current.revision + 1,
    previousEventDigest: current.journalHeadDigest,
    eventType: 'ownership_adopted',
    previousWorktreeFencingTokenDigest:
      input.previousWorktreeFencingTokenDigest,
    worktreeFencingTokenDigest:
      input.currentWorktreeFencingTokenDigest,
    stepId: null,
    reservationId: null,
    argvDigest: null,
    effectiveEnvironmentDigest: null,
    generatedScopeFingerprint:
      input.observedGeneratedScopeFingerprint,
    exitCode: null,
    idempotencyKey: input.idempotencyKey,
  });
  const journal = sealJournal({
    ...withoutJournalDigest(current),
    currentWorktreeFencingTokenDigest:
      input.currentWorktreeFencingTokenDigest,
    revision: event.sequence,
    journalHeadDigest: event.eventDigest,
  });
  if (!validateBootstrapExecutionJournalTransition(current, event, journal)) {
    throw new Error('Unable to adopt the bootstrap execution journal.');
  }
  return { journal, event };
}

export function validateBootstrapExecutionJournal(
  value: unknown,
): value is BootstrapExecutionJournalV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, JOURNAL_KEYS)
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['journalId']))
    || !isDigest(value['bootstrapPlanDigest'])
    || !UUID.test(String(value['leaseId']))
    || !isDigest(value['createdByWorktreeFencingTokenDigest'])
    || !isDigest(value['currentWorktreeFencingTokenDigest'])
    || !isJournalState(value['state'])
    || (value['activeStepId'] !== null && !isOpaque(value['activeStepId']))
    || !isNonnegativeInteger(value['revision'])
    || !isDigest(value['journalHeadDigest'])
    || !isDigest(value['journalDigest'])) {
    return false;
  }
  const hasActiveStep = value['activeStepId'] !== null;
  if (hasActiveStep !== (
    value['state'] === 'step_prepared'
    || value['state'] === 'step_running'
  )) {
    return false;
  }
  const { journalDigest, ...core } =
    value as unknown as BootstrapExecutionJournalV1;
  return canonicalDigest('wukong/bootstrap-execution-journal/v1', core)
    === journalDigest;
}

export function validateBootstrapExecutionEvent(
  value: unknown,
): value is BootstrapExecutionEventV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, EVENT_KEYS)
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['eventId']))
    || !UUID.test(String(value['journalId']))
    || !isPositiveInteger(value['sequence'])
    || !isDigest(value['previousEventDigest'])
    || !isEventType(value['eventType'])
    || (value['previousWorktreeFencingTokenDigest'] !== null
      && !isDigest(value['previousWorktreeFencingTokenDigest']))
    || !isDigest(value['worktreeFencingTokenDigest'])
    || (value['stepId'] !== null && !isOpaque(value['stepId']))
    || (value['reservationId'] !== null
      && (typeof value['reservationId'] !== 'string'
        || !UUID.test(value['reservationId'])))
    || (value['argvDigest'] !== null && !isDigest(value['argvDigest']))
    || (value['effectiveEnvironmentDigest'] !== null
      && !isDigest(value['effectiveEnvironmentDigest']))
    || (value['generatedScopeFingerprint'] !== null
      && !isDigest(value['generatedScopeFingerprint']))
    || (value['exitCode'] !== null
      && !Number.isSafeInteger(value['exitCode']))
    || !isOpaque(value['idempotencyKey'])
    || !isDigest(value['eventDigest'])) {
    return false;
  }
  const event = value as unknown as BootstrapExecutionEventV1;
  const adoption = event.eventType === 'ownership_adopted';
  const terminalStep = event.eventType === 'observed'
    || event.eventType === 'reconciled'
    || event.eventType === 'failed';
  if (adoption) {
    if (event.previousWorktreeFencingTokenDigest === null
      || event.previousWorktreeFencingTokenDigest
        === event.worktreeFencingTokenDigest
      || event.stepId !== null
      || event.reservationId !== null
      || event.argvDigest !== null
      || event.effectiveEnvironmentDigest !== null
      || event.generatedScopeFingerprint === null
      || event.exitCode !== null) {
      return false;
    }
  } else if (event.previousWorktreeFencingTokenDigest !== null
    || event.stepId === null
    || event.reservationId === null
    || event.argvDigest === null
    || event.effectiveEnvironmentDigest === null
    || terminalStep !== (
      event.generatedScopeFingerprint !== null
      && event.exitCode !== null
    )
    || ((event.eventType === 'observed'
      || event.eventType === 'reconciled')
      && event.exitCode !== 0)
    || (event.eventType === 'failed' && event.exitCode === 0)) {
    return false;
  }
  const { eventDigest, ...core } = event;
  return canonicalDigest('wukong/bootstrap-execution-event/v1', core)
    === eventDigest;
}

export function validateBootstrapExecutionJournalTransition(
  previous: BootstrapExecutionJournalV1,
  event: BootstrapExecutionEventV1,
  next: BootstrapExecutionJournalV1,
): boolean {
  if (!validateBootstrapExecutionJournal(previous)
    || !validateBootstrapExecutionEvent(event)
    || !validateBootstrapExecutionJournal(next)
    || event.journalId !== previous.journalId
    || event.sequence !== previous.revision + 1
    || event.previousEventDigest !== previous.journalHeadDigest
    || next.revision !== event.sequence
    || next.journalHeadDigest !== event.eventDigest
    || immutableJournalBinding(previous) !== immutableJournalBinding(next)) {
    return false;
  }
  if (event.eventType === 'ownership_adopted') {
    return previous.state === 'ready'
      && next.state === 'ready'
      && next.activeStepId === null
      && event.previousWorktreeFencingTokenDigest
        === previous.currentWorktreeFencingTokenDigest
      && event.worktreeFencingTokenDigest
        === next.currentWorktreeFencingTokenDigest;
  }
  if (event.worktreeFencingTokenDigest
      !== previous.currentWorktreeFencingTokenDigest
    || next.currentWorktreeFencingTokenDigest
      !== previous.currentWorktreeFencingTokenDigest) {
    return false;
  }
  if (!isValidStepEventFrom(previous, event.eventType, event.stepId)) {
    return false;
  }
  const expectedState: BootstrapExecutionJournalStateV1 =
    event.eventType === 'prepared'
      ? 'step_prepared'
      : event.eventType === 'started'
        ? 'step_running'
        : event.eventType === 'failed'
          ? 'blocked'
          : 'ready';
  return next.state === expectedState
    && next.activeStepId === (
      expectedState === 'step_prepared' || expectedState === 'step_running'
        ? event.stepId
        : null
    );
}

function assertStepTransition(
  current: BootstrapExecutionJournalV1,
  input: AppendBootstrapStepEventInputV1,
): void {
  if (!isValidStepEventFrom(current, input.eventType, input.stepId)) {
    throw new Error('The bootstrap step event is out of order.');
  }
}

function isValidStepEventFrom(
  current: BootstrapExecutionJournalV1,
  eventType: BootstrapExecutionEventTypeV1,
  stepId: string | null,
): boolean {
  return (eventType === 'prepared'
      && current.state === 'ready'
      && current.activeStepId === null
      && stepId !== null)
    || (eventType === 'started'
      && current.state === 'step_prepared'
      && current.activeStepId === stepId)
    || ((eventType === 'observed'
      || eventType === 'reconciled'
      || eventType === 'failed')
      && (current.state === 'step_prepared'
        || current.state === 'step_running')
      && current.activeStepId === stepId);
}

function immutableJournalBinding(
  journal: BootstrapExecutionJournalV1,
): string {
  return canonicalDigest('wukong/bootstrap-journal-immutable-binding/v1', {
    schemaVersion: journal.schemaVersion,
    journalId: journal.journalId,
    bootstrapPlanDigest: journal.bootstrapPlanDigest,
    leaseId: journal.leaseId,
    createdByWorktreeFencingTokenDigest:
      journal.createdByWorktreeFencingTokenDigest,
  });
}

function sealEvent(
  core: Omit<BootstrapExecutionEventV1, 'eventDigest'>,
): BootstrapExecutionEventV1 {
  return Object.freeze({
    ...core,
    eventDigest: canonicalDigest(
      'wukong/bootstrap-execution-event/v1',
      core,
    ),
  });
}

function sealJournal(
  core: Omit<BootstrapExecutionJournalV1, 'journalDigest'>,
): BootstrapExecutionJournalV1 {
  return Object.freeze({
    ...core,
    journalDigest: canonicalDigest(
      'wukong/bootstrap-execution-journal/v1',
      core,
    ),
  });
}

function withoutJournalDigest(
  journal: BootstrapExecutionJournalV1,
): Omit<BootstrapExecutionJournalV1, 'journalDigest'> {
  const { journalDigest: _, ...core } = journal;
  return core;
}

function isJournalState(
  value: unknown,
): value is BootstrapExecutionJournalStateV1 {
  return value === 'ready'
    || value === 'step_prepared'
    || value === 'step_running'
    || value === 'blocked';
}

function isEventType(value: unknown): value is BootstrapExecutionEventTypeV1 {
  return value === 'prepared'
    || value === 'started'
    || value === 'observed'
    || value === 'reconciled'
    || value === 'failed'
    || value === 'ownership_adopted';
}

function isStepEventType(
  value: unknown,
): value is Exclude<BootstrapExecutionEventTypeV1, 'ownership_adopted'> {
  return value === 'prepared'
    || value === 'started'
    || value === 'observed'
    || value === 'reconciled'
    || value === 'failed';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
