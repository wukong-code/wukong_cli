import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createBootstrapBudget,
  reserveBootstrapBudget,
  transitionBootstrapBudgetReservation,
  validateBootstrapBudget,
  validateBootstrapBudgetEvent,
  validateBootstrapBudgetReservation,
  validateBootstrapBudgetReservationTransition,
  validateBootstrapBudgetTransition,
} from '../src';

const BUDGET_ID = '019f8bb0-0000-7abc-8def-0123456789ab';
const PLAN_ID = '019f8bb0-0001-7abc-8def-0123456789ab';

function digest(label: string): string {
  return canonicalDigest('wukong/test/bootstrap-budget/v1', label);
}

function budget(overrides: Record<string, unknown> = {}) {
  return createBootstrapBudget({
    budgetId: BUDGET_ID,
    bootstrapPlanId: PLAN_ID,
    wallClockLimitMs: 100_000,
    generatedByteLimit: 1_000,
    processOutputByteLimit: 500,
    stepLimit: 4,
    ...overrides,
  });
}

function reserve(
  current = budget(),
  reservations: Parameters<typeof reserveBootstrapBudget>[1] = [],
  suffix = '1',
  overrides: Record<string, unknown> = {},
) {
  return reserveBootstrapBudget(current, reservations, {
    reservationId: `019f8bb0-001${suffix}-7abc-8def-0123456789ab`,
    eventId: `019f8bb0-002${suffix}-7abc-8def-0123456789ab`,
    stepId: `step_${suffix}`,
    worktreeFencingTokenDigest: digest('fencing'),
    reservedWallClockMs: 40_000,
    reservedGeneratedBytes: 400,
    reservedOutputBytes: 200,
    idempotencyKey: `bootstrap_step_${suffix}`,
    ...overrides,
  });
}

describe('BootstrapBudgetV1', () => {
  it('reserves, starts and settles verified actual usage', () => {
    const initial = budget();
    const reserved = reserve(initial);
    const running = transitionBootstrapBudgetReservation(
      reserved.budget,
      reserved.reservation,
      {
        eventId: '019f8bb0-0031-7abc-8def-0123456789ab',
        toState: 'running',
      },
    );
    const settled = transitionBootstrapBudgetReservation(
      running.budget,
      running.reservation,
      {
        eventId: '019f8bb0-0041-7abc-8def-0123456789ab',
        toState: 'settled',
        actualWallClockMs: 10_000,
        actualGeneratedBytes: 100,
        actualOutputBytes: 50,
      },
    );

    expect(validateBootstrapBudget(initial)).toBe(true);
    expect(validateBootstrapBudgetReservation(settled.reservation)).toBe(true);
    expect(validateBootstrapBudgetEvent(settled.event)).toBe(true);
    expect(validateBootstrapBudgetTransition(
      running.budget,
      settled.event,
      settled.budget,
    )).toBe(true);
    expect(validateBootstrapBudgetReservationTransition(
      running.reservation,
      settled.event,
      settled.reservation,
    )).toBe(true);
    expect(settled.reservation).toMatchObject({
      state: 'settled',
      actualWallClockMs: 10_000,
      actualGeneratedBytes: 100,
      actualOutputBytes: 50,
    });
  });

  it('charges active and retained-unknown reservations at their full amount', () => {
    const initial = budget({ wallClockLimitMs: 60_000 });
    const first = reserve(initial, [], '1', {
      reservedWallClockMs: 40_000,
    });

    expect(() => reserve(first.budget, [first.reservation], '2', {
      reservedWallClockMs: 30_000,
    })).toThrow(/enough capacity/u);
    const running = transitionBootstrapBudgetReservation(
      first.budget,
      first.reservation,
      {
        eventId: '019f8bb0-0031-7abc-8def-0123456789ab',
        toState: 'running',
      },
    );
    const unknown = transitionBootstrapBudgetReservation(
      running.budget,
      running.reservation,
      {
        eventId: '019f8bb0-0041-7abc-8def-0123456789ab',
        toState: 'retained_unknown',
      },
    );
    expect(() => reserve(unknown.budget, [unknown.reservation], '2', {
      reservedWallClockMs: 30_000,
    })).toThrow(/enough capacity/u);
  });

  it('releases a cancelled reservation and settled unused capacity', () => {
    const initial = budget({ wallClockLimitMs: 60_000 });
    const first = reserve(initial, [], '1', {
      reservedWallClockMs: 40_000,
    });
    const cancelled = transitionBootstrapBudgetReservation(
      first.budget,
      first.reservation,
      {
        eventId: '019f8bb0-0031-7abc-8def-0123456789ab',
        toState: 'cancelled',
      },
    );
    expect(() => reserve(
      cancelled.budget,
      [cancelled.reservation],
      '2',
      { reservedWallClockMs: 60_000 },
    )).not.toThrow();

    const secondInitial = budget({ wallClockLimitMs: 60_000 });
    const second = reserve(secondInitial, [], '1', {
      reservedWallClockMs: 40_000,
    });
    const running = transitionBootstrapBudgetReservation(
      second.budget,
      second.reservation,
      {
        eventId: '019f8bb0-0031-7abc-8def-0123456789ab',
        toState: 'running',
      },
    );
    const settled = transitionBootstrapBudgetReservation(
      running.budget,
      running.reservation,
      {
        eventId: '019f8bb0-0041-7abc-8def-0123456789ab',
        toState: 'settled',
        actualWallClockMs: 10_000,
        actualGeneratedBytes: 0,
        actualOutputBytes: 0,
      },
    );
    expect(() => reserve(
      settled.budget,
      [settled.reservation],
      '2',
      { reservedWallClockMs: 50_000 },
    )).not.toThrow();
  });

  it('rejects usage greater than the durable reservation', () => {
    const reserved = reserve();
    const running = transitionBootstrapBudgetReservation(
      reserved.budget,
      reserved.reservation,
      {
        eventId: '019f8bb0-0031-7abc-8def-0123456789ab',
        toState: 'running',
      },
    );

    expect(() => transitionBootstrapBudgetReservation(
      running.budget,
      running.reservation,
      {
        eventId: '019f8bb0-0041-7abc-8def-0123456789ab',
        toState: 'settled',
        actualWallClockMs: 40_001,
        actualGeneratedBytes: 0,
        actualOutputBytes: 0,
      },
    )).toThrow(/exceeded/u);
  });

  it('rejects duplicate reservation and idempotency identities', () => {
    const first = reserve();

    expect(() => reserve(first.budget, [first.reservation], '1'))
      .toThrow(TypeError);
    expect(() => reserve(first.budget, [first.reservation], '2', {
      idempotencyKey: first.reservation.idempotencyKey,
    })).toThrow(TypeError);
  });

  it('binds every event to the previous budget and reservation digests', () => {
    const first = reserve();
    const running = transitionBootstrapBudgetReservation(
      first.budget,
      first.reservation,
      {
        eventId: '019f8bb0-0031-7abc-8def-0123456789ab',
        toState: 'running',
      },
    );

    expect(validateBootstrapBudgetEvent({
      ...running.event,
      previousEventDigest: digest('wrong-head'),
    })).toBe(false);
    expect(validateBootstrapBudgetReservationTransition(
      {
        ...first.reservation,
        worktreeFencingTokenDigest: digest('stale-fencing'),
      },
      running.event,
      running.reservation,
    )).toBe(false);
  });

  it('permits zero generated/output reservations without permitting zero time', () => {
    expect(() => reserve(budget(), [], '1', {
      reservedGeneratedBytes: 0,
      reservedOutputBytes: 0,
    })).not.toThrow();
    expect(() => reserve(budget(), [], '1', {
      reservedWallClockMs: 0,
    })).toThrow(TypeError);
  });
});
