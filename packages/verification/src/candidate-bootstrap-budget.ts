import { canonicalDigest } from './finish-line';

export type BootstrapBudgetReservationStateV1 =
  | 'reserved'
  | 'running'
  | 'settled'
  | 'retained_unknown'
  | 'cancelled';

export type BootstrapBudgetEventTypeV1 =
  | 'reserved'
  | 'started'
  | 'settled'
  | 'retained_unknown'
  | 'cancelled';

export interface BootstrapBudgetV1 {
  readonly schemaVersion: 1;
  readonly budgetId: string;
  readonly bootstrapPlanId: string;
  readonly wallClockLimitMs: number;
  readonly generatedByteLimit: number;
  readonly processOutputByteLimit: number;
  readonly stepLimit: number;
  readonly revision: number;
  readonly ledgerHeadDigest: string;
  readonly budgetDigest: string;
}

export interface BootstrapBudgetReservationV1 {
  readonly schemaVersion: 1;
  readonly reservationId: string;
  readonly budgetId: string;
  readonly bootstrapPlanId: string;
  readonly stepId: string;
  readonly worktreeFencingTokenDigest: string;
  readonly reservedWallClockMs: number;
  readonly reservedGeneratedBytes: number;
  readonly reservedOutputBytes: number;
  readonly actualWallClockMs: number | null;
  readonly actualGeneratedBytes: number | null;
  readonly actualOutputBytes: number | null;
  readonly state: BootstrapBudgetReservationStateV1;
  readonly casRevision: number;
  readonly idempotencyKey: string;
  readonly reservationDigest: string;
}

export interface BootstrapBudgetEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly budgetId: string;
  readonly bootstrapPlanId: string;
  readonly sequence: number;
  readonly previousEventDigest: string;
  readonly eventType: BootstrapBudgetEventTypeV1;
  readonly previousReservationDigest: string | null;
  readonly reservation: BootstrapBudgetReservationV1;
  readonly eventDigest: string;
}

export interface CreateBootstrapBudgetInputV1 {
  readonly budgetId: string;
  readonly bootstrapPlanId: string;
  readonly wallClockLimitMs: number;
  readonly generatedByteLimit: number;
  readonly processOutputByteLimit: number;
  readonly stepLimit: number;
}

export interface ReserveBootstrapBudgetInputV1 {
  readonly reservationId: string;
  readonly eventId: string;
  readonly stepId: string;
  readonly worktreeFencingTokenDigest: string;
  readonly reservedWallClockMs: number;
  readonly reservedGeneratedBytes: number;
  readonly reservedOutputBytes: number;
  readonly idempotencyKey: string;
}

export interface TransitionBootstrapBudgetReservationInputV1 {
  readonly eventId: string;
  readonly toState: Exclude<
    BootstrapBudgetReservationStateV1,
    'reserved'
  >;
  readonly actualWallClockMs?: number;
  readonly actualGeneratedBytes?: number;
  readonly actualOutputBytes?: number;
}

export interface BootstrapBudgetTransitionV1 {
  readonly budget: BootstrapBudgetV1;
  readonly reservation: BootstrapBudgetReservationV1;
  readonly event: BootstrapBudgetEventV1;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_WALL_CLOCK_MS = 60 * 60_000;
const MAX_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_STEPS = 64;

const BUDGET_KEYS = [
  'schemaVersion',
  'budgetId',
  'bootstrapPlanId',
  'wallClockLimitMs',
  'generatedByteLimit',
  'processOutputByteLimit',
  'stepLimit',
  'revision',
  'ledgerHeadDigest',
  'budgetDigest',
] as const;

const RESERVATION_KEYS = [
  'schemaVersion',
  'reservationId',
  'budgetId',
  'bootstrapPlanId',
  'stepId',
  'worktreeFencingTokenDigest',
  'reservedWallClockMs',
  'reservedGeneratedBytes',
  'reservedOutputBytes',
  'actualWallClockMs',
  'actualGeneratedBytes',
  'actualOutputBytes',
  'state',
  'casRevision',
  'idempotencyKey',
  'reservationDigest',
] as const;

const EVENT_KEYS = [
  'schemaVersion',
  'eventId',
  'budgetId',
  'bootstrapPlanId',
  'sequence',
  'previousEventDigest',
  'eventType',
  'previousReservationDigest',
  'reservation',
  'eventDigest',
] as const;

const EVENT_BY_STATE = {
  reserved: 'reserved',
  running: 'started',
  settled: 'settled',
  retained_unknown: 'retained_unknown',
  cancelled: 'cancelled',
} as const satisfies Record<
  BootstrapBudgetReservationStateV1,
  BootstrapBudgetEventTypeV1
>;

const ALLOWED_TRANSITIONS = {
  reserved: ['running', 'cancelled'],
  running: ['settled', 'retained_unknown'],
  settled: [],
  retained_unknown: [],
  cancelled: [],
} as const satisfies Record<
  BootstrapBudgetReservationStateV1,
  readonly BootstrapBudgetReservationStateV1[]
>;

export function createBootstrapBudget(
  input: CreateBootstrapBudgetInputV1,
): BootstrapBudgetV1 {
  const genesis = canonicalDigest('wukong/bootstrap-budget-genesis/v1', {
    budgetId: input.budgetId,
    bootstrapPlanId: input.bootstrapPlanId,
  });
  const core = {
    schemaVersion: 1 as const,
    budgetId: input.budgetId,
    bootstrapPlanId: input.bootstrapPlanId,
    wallClockLimitMs: input.wallClockLimitMs,
    generatedByteLimit: input.generatedByteLimit,
    processOutputByteLimit: input.processOutputByteLimit,
    stepLimit: input.stepLimit,
    revision: 0,
    ledgerHeadDigest: genesis,
  };
  const budget = Object.freeze({
    ...core,
    budgetDigest: canonicalDigest('wukong/bootstrap-budget/v1', core),
  });
  if (!validateBootstrapBudget(budget)) {
    throw new TypeError('The bootstrap budget is invalid.');
  }
  return budget;
}

export function reserveBootstrapBudget(
  current: BootstrapBudgetV1,
  reservations: readonly BootstrapBudgetReservationV1[],
  input: ReserveBootstrapBudgetInputV1,
): BootstrapBudgetTransitionV1 {
  if (!validateBootstrapBudget(current)
    || !validateReservationSet(current, reservations)
    || reservations.some((item) =>
      item.reservationId === input.reservationId
      || item.idempotencyKey === input.idempotencyKey)
    || !UUID.test(input.reservationId)
    || !UUID.test(input.eventId)
    || !isOpaque(input.stepId)
    || !isDigest(input.worktreeFencingTokenDigest)
    || !isPositiveInteger(input.reservedWallClockMs)
    || !isNonnegativeInteger(input.reservedGeneratedBytes)
    || !isNonnegativeInteger(input.reservedOutputBytes)
    || !isOpaque(input.idempotencyKey)) {
    throw new TypeError('The bootstrap budget reservation input is invalid.');
  }
  const usage = chargedUsage(reservations);
  if (reservations.length >= current.stepLimit
    || usage.wallClockMs + input.reservedWallClockMs
      > current.wallClockLimitMs
    || usage.generatedBytes + input.reservedGeneratedBytes
      > current.generatedByteLimit
    || usage.outputBytes + input.reservedOutputBytes
      > current.processOutputByteLimit) {
    throw new Error('The bootstrap budget does not have enough capacity.');
  }
  const reservationCore = {
    schemaVersion: 1 as const,
    reservationId: input.reservationId,
    budgetId: current.budgetId,
    bootstrapPlanId: current.bootstrapPlanId,
    stepId: input.stepId,
    worktreeFencingTokenDigest: input.worktreeFencingTokenDigest,
    reservedWallClockMs: input.reservedWallClockMs,
    reservedGeneratedBytes: input.reservedGeneratedBytes,
    reservedOutputBytes: input.reservedOutputBytes,
    actualWallClockMs: null,
    actualGeneratedBytes: null,
    actualOutputBytes: null,
    state: 'reserved' as const,
    casRevision: 0,
    idempotencyKey: input.idempotencyKey,
  };
  const reservation = sealReservation(reservationCore);
  return sealTransition(current, reservation, input.eventId, null);
}

export function transitionBootstrapBudgetReservation(
  currentBudget: BootstrapBudgetV1,
  currentReservation: BootstrapBudgetReservationV1,
  input: TransitionBootstrapBudgetReservationInputV1,
): BootstrapBudgetTransitionV1 {
  if (!validateBootstrapBudget(currentBudget)
    || !validateBootstrapBudgetReservation(currentReservation)
    || currentReservation.budgetId !== currentBudget.budgetId
    || currentReservation.bootstrapPlanId !== currentBudget.bootstrapPlanId
    || !UUID.test(input.eventId)
    || !ALLOWED_TRANSITIONS[currentReservation.state]
      .includes(input.toState as never)) {
    throw new TypeError('The bootstrap budget transition input is invalid.');
  }
  const settling = input.toState === 'settled';
  const actuals = [
    input.actualWallClockMs,
    input.actualGeneratedBytes,
    input.actualOutputBytes,
  ];
  if (settling
    ? !actuals.every(isNonnegativeInteger)
    : actuals.some((value) => value !== undefined)) {
    throw new TypeError('The bootstrap budget actual usage is invalid.');
  }
  if (settling
    && (input.actualWallClockMs! > currentReservation.reservedWallClockMs
      || input.actualGeneratedBytes!
        > currentReservation.reservedGeneratedBytes
      || input.actualOutputBytes! > currentReservation.reservedOutputBytes)) {
    throw new Error('Bootstrap usage exceeded its reservation.');
  }
  const reservation = sealReservation({
    ...withoutReservationDigest(currentReservation),
    actualWallClockMs: settling ? input.actualWallClockMs! : null,
    actualGeneratedBytes: settling ? input.actualGeneratedBytes! : null,
    actualOutputBytes: settling ? input.actualOutputBytes! : null,
    state: input.toState,
    casRevision: currentReservation.casRevision + 1,
  });
  const transitioned = sealTransition(
    currentBudget,
    reservation,
    input.eventId,
    currentReservation.reservationDigest,
  );
  if (!validateBootstrapBudgetReservationTransition(
    currentReservation,
    transitioned.event,
    transitioned.reservation,
  )) {
    throw new Error('Unable to create a valid bootstrap reservation transition.');
  }
  return transitioned;
}

export function validateBootstrapBudget(
  value: unknown,
): value is BootstrapBudgetV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, BUDGET_KEYS)
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['budgetId']))
    || !UUID.test(String(value['bootstrapPlanId']))
    || !isBoundedPositiveInteger(
      value['wallClockLimitMs'],
      MAX_WALL_CLOCK_MS,
    )
    || !isBoundedPositiveInteger(value['generatedByteLimit'], MAX_BYTES)
    || !isBoundedPositiveInteger(value['processOutputByteLimit'], MAX_BYTES)
    || !isBoundedPositiveInteger(value['stepLimit'], MAX_STEPS)
    || !isNonnegativeInteger(value['revision'])
    || !isDigest(value['ledgerHeadDigest'])
    || !isDigest(value['budgetDigest'])) {
    return false;
  }
  const { budgetDigest, ...core } = value as unknown as BootstrapBudgetV1;
  return canonicalDigest('wukong/bootstrap-budget/v1', core) === budgetDigest;
}

export function validateBootstrapBudgetReservation(
  value: unknown,
): value is BootstrapBudgetReservationV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, RESERVATION_KEYS)
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['reservationId']))
    || !UUID.test(String(value['budgetId']))
    || !UUID.test(String(value['bootstrapPlanId']))
    || !isOpaque(value['stepId'])
    || !isDigest(value['worktreeFencingTokenDigest'])
    || !isPositiveInteger(value['reservedWallClockMs'])
    || !isNonnegativeInteger(value['reservedGeneratedBytes'])
    || !isNonnegativeInteger(value['reservedOutputBytes'])
    || !isReservationState(value['state'])
    || !isNonnegativeInteger(value['casRevision'])
    || !isOpaque(value['idempotencyKey'])
    || !isDigest(value['reservationDigest'])) {
    return false;
  }
  const actuals = [
    value['actualWallClockMs'],
    value['actualGeneratedBytes'],
    value['actualOutputBytes'],
  ];
  if ((value['state'] === 'settled') !== actuals.every(isNonnegativeInteger)
    || (value['state'] !== 'settled'
      && actuals.some((item) => item !== null))) {
    return false;
  }
  const reservation =
    value as unknown as BootstrapBudgetReservationV1;
  if (reservation.state === 'settled'
    && (reservation.actualWallClockMs! > reservation.reservedWallClockMs
      || reservation.actualGeneratedBytes!
        > reservation.reservedGeneratedBytes
      || reservation.actualOutputBytes! > reservation.reservedOutputBytes)) {
    return false;
  }
  const { reservationDigest, ...core } = reservation;
  return canonicalDigest('wukong/bootstrap-budget-reservation/v1', core)
    === reservationDigest;
}

export function validateBootstrapBudgetEvent(
  value: unknown,
): value is BootstrapBudgetEventV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, EVENT_KEYS)
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['eventId']))
    || !UUID.test(String(value['budgetId']))
    || !UUID.test(String(value['bootstrapPlanId']))
    || !isPositiveInteger(value['sequence'])
    || !isDigest(value['previousEventDigest'])
    || !isEventType(value['eventType'])
    || (value['previousReservationDigest'] !== null
      && !isDigest(value['previousReservationDigest']))
    || !validateBootstrapBudgetReservation(value['reservation'])
    || !isDigest(value['eventDigest'])) {
    return false;
  }
  const event = value as unknown as BootstrapBudgetEventV1;
  if (event.budgetId !== event.reservation.budgetId
    || event.bootstrapPlanId !== event.reservation.bootstrapPlanId
    || event.eventType !== EVENT_BY_STATE[event.reservation.state]
    || (event.reservation.casRevision === 0)
      !== (event.previousReservationDigest === null)) {
    return false;
  }
  const { eventDigest, ...core } = event;
  return canonicalDigest('wukong/bootstrap-budget-event/v1', core)
    === eventDigest;
}

export function validateBootstrapBudgetTransition(
  previousBudget: BootstrapBudgetV1,
  event: BootstrapBudgetEventV1,
  nextBudget: BootstrapBudgetV1,
): boolean {
  return validateBootstrapBudget(previousBudget)
    && validateBootstrapBudgetEvent(event)
    && validateBootstrapBudget(nextBudget)
    && event.budgetId === previousBudget.budgetId
    && event.bootstrapPlanId === previousBudget.bootstrapPlanId
    && event.sequence === previousBudget.revision + 1
    && event.previousEventDigest === previousBudget.ledgerHeadDigest
    && nextBudget.revision === event.sequence
    && nextBudget.ledgerHeadDigest === event.eventDigest
    && nextBudget.budgetId === previousBudget.budgetId
    && nextBudget.bootstrapPlanId === previousBudget.bootstrapPlanId
    && nextBudget.wallClockLimitMs === previousBudget.wallClockLimitMs
    && nextBudget.generatedByteLimit === previousBudget.generatedByteLimit
    && nextBudget.processOutputByteLimit
      === previousBudget.processOutputByteLimit
    && nextBudget.stepLimit === previousBudget.stepLimit;
}

export function validateBootstrapBudgetReservationTransition(
  previous: BootstrapBudgetReservationV1,
  event: BootstrapBudgetEventV1,
  next: BootstrapBudgetReservationV1,
): boolean {
  return validateBootstrapBudgetReservation(previous)
    && validateBootstrapBudgetEvent(event)
    && validateBootstrapBudgetReservation(next)
    && event.reservation.reservationDigest === next.reservationDigest
    && event.previousReservationDigest === previous.reservationDigest
    && next.reservationId === previous.reservationId
    && next.budgetId === previous.budgetId
    && next.bootstrapPlanId === previous.bootstrapPlanId
    && next.stepId === previous.stepId
    && next.worktreeFencingTokenDigest
      === previous.worktreeFencingTokenDigest
    && next.reservedWallClockMs === previous.reservedWallClockMs
    && next.reservedGeneratedBytes === previous.reservedGeneratedBytes
    && next.reservedOutputBytes === previous.reservedOutputBytes
    && next.idempotencyKey === previous.idempotencyKey
    && next.casRevision === previous.casRevision + 1
    && ALLOWED_TRANSITIONS[previous.state].includes(next.state as never);
}

function sealTransition(
  current: BootstrapBudgetV1,
  reservation: BootstrapBudgetReservationV1,
  eventId: string,
  previousReservationDigest: string | null,
): BootstrapBudgetTransitionV1 {
  const eventCore = {
    schemaVersion: 1 as const,
    eventId,
    budgetId: current.budgetId,
    bootstrapPlanId: current.bootstrapPlanId,
    sequence: current.revision + 1,
    previousEventDigest: current.ledgerHeadDigest,
    eventType: EVENT_BY_STATE[reservation.state],
    previousReservationDigest,
    reservation,
  };
  const event = Object.freeze({
    ...eventCore,
    eventDigest: canonicalDigest('wukong/bootstrap-budget-event/v1', eventCore),
  });
  const budgetCore = {
    ...withoutBudgetDigest(current),
    revision: event.sequence,
    ledgerHeadDigest: event.eventDigest,
  };
  const budget = Object.freeze({
    ...budgetCore,
    budgetDigest: canonicalDigest('wukong/bootstrap-budget/v1', budgetCore),
  });
  if (!validateBootstrapBudgetReservation(reservation)
    || !validateBootstrapBudgetEvent(event)
    || !validateBootstrapBudgetTransition(current, event, budget)) {
    throw new Error('Unable to create a valid bootstrap budget transition.');
  }
  return { budget, reservation, event };
}

function validateReservationSet(
  budget: BootstrapBudgetV1,
  reservations: readonly BootstrapBudgetReservationV1[],
): boolean {
  const reservationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  return reservations.length <= budget.stepLimit
    && reservations.every((reservation) => {
      if (!validateBootstrapBudgetReservation(reservation)
        || reservation.budgetId !== budget.budgetId
        || reservation.bootstrapPlanId !== budget.bootstrapPlanId
        || reservationIds.has(reservation.reservationId)
        || idempotencyKeys.has(reservation.idempotencyKey)) {
        return false;
      }
      reservationIds.add(reservation.reservationId);
      idempotencyKeys.add(reservation.idempotencyKey);
      return true;
    });
}

function chargedUsage(
  reservations: readonly BootstrapBudgetReservationV1[],
): {
  readonly wallClockMs: number;
  readonly generatedBytes: number;
  readonly outputBytes: number;
} {
  return reservations.reduce((total, reservation) => {
    if (reservation.state === 'cancelled') return total;
    return {
      wallClockMs: total.wallClockMs
        + (reservation.actualWallClockMs ?? reservation.reservedWallClockMs),
      generatedBytes: total.generatedBytes
        + (reservation.actualGeneratedBytes
          ?? reservation.reservedGeneratedBytes),
      outputBytes: total.outputBytes
        + (reservation.actualOutputBytes ?? reservation.reservedOutputBytes),
    };
  }, { wallClockMs: 0, generatedBytes: 0, outputBytes: 0 });
}

function sealReservation(
  core: Omit<BootstrapBudgetReservationV1, 'reservationDigest'>,
): BootstrapBudgetReservationV1 {
  return Object.freeze({
    ...core,
    reservationDigest: canonicalDigest(
      'wukong/bootstrap-budget-reservation/v1',
      core,
    ),
  });
}

function withoutBudgetDigest(
  budget: BootstrapBudgetV1,
): Omit<BootstrapBudgetV1, 'budgetDigest'> {
  const { budgetDigest: _, ...core } = budget;
  return core;
}

function withoutReservationDigest(
  reservation: BootstrapBudgetReservationV1,
): Omit<BootstrapBudgetReservationV1, 'reservationDigest'> {
  const { reservationDigest: _, ...core } = reservation;
  return core;
}

function isReservationState(
  value: unknown,
): value is BootstrapBudgetReservationStateV1 {
  return typeof value === 'string' && value in ALLOWED_TRANSITIONS;
}

function isEventType(value: unknown): value is BootstrapBudgetEventTypeV1 {
  return typeof value === 'string'
    && Object.values(EVENT_BY_STATE).includes(
      value as BootstrapBudgetEventTypeV1,
    );
}

function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  return isPositiveInteger(value) && value <= maximum;
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
