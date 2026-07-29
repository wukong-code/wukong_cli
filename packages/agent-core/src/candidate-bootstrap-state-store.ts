import { constants as fsConstants, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  lstat,
  open,
  rename,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  adoptBootstrapJournalOwnership,
  appendBootstrapStepEvent,
  canonicalDigest,
  canonicalJson,
  createBootstrapBudget,
  createBootstrapExecutionJournal,
  reserveBootstrapBudget,
  transitionBootstrapBudgetReservation,
  validateBootstrapBudget,
  validateBootstrapBudgetEvent,
  validateBootstrapBudgetReservation,
  validateBootstrapExecutionEvent,
  validateBootstrapExecutionJournal,
  validateCandidateBootstrapPlan,
  validateCandidateBootstrapStep,
  validateWorktreeLease,
  type BootstrapBudgetEventV1,
  type BootstrapBudgetReservationV1,
  type BootstrapBudgetV1,
  type BootstrapExecutionEventV1,
  type BootstrapExecutionJournalV1,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapStepV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STATE_FILE = 'bootstrap-state.json';
const LOCK_FILE = '.bootstrap-state.lock';
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 1_024;

export type CandidateBootstrapStateStoreErrorCode =
  | 'candidate_bootstrap_state_invalid_input'
  | 'candidate_bootstrap_state_root_unsafe'
  | 'candidate_bootstrap_state_not_found'
  | 'candidate_bootstrap_state_conflict'
  | 'candidate_bootstrap_state_integrity_failed'
  | 'candidate_bootstrap_state_stale_binding'
  | 'candidate_bootstrap_state_invalid_transition'
  | 'candidate_bootstrap_state_lock_failed';

export class CandidateBootstrapStateStoreError extends Error {
  constructor(
    readonly reasonCode: CandidateBootstrapStateStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateBootstrapStateStoreError';
  }
}

export interface CandidateBootstrapStateStoreOptions {
  readonly rootDirectory: string;
}

export interface CandidateBootstrapStateV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly bootstrapPlanDigest: string;
  readonly worktreeLeaseDigest: string;
  readonly worktreeFencingTokenDigest: string;
  readonly initialBudgetDigest: string;
  readonly budget: BootstrapBudgetV1;
  readonly reservations: readonly BootstrapBudgetReservationV1[];
  readonly budgetEvents: readonly BootstrapBudgetEventV1[];
  readonly journal: BootstrapExecutionJournalV1;
  readonly journalEvents: readonly BootstrapExecutionEventV1[];
  readonly revision: number;
  readonly stateDigest: string;
}

export interface InitializeCandidateBootstrapStateV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly bootstrapBudget: BootstrapBudgetV1;
  readonly journalId: string;
}

export interface PrepareCandidateBootstrapStepV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly step: CandidateBootstrapStepV1;
  readonly reservationId: string;
  readonly budgetEventId: string;
  readonly journalEventId: string;
  readonly reservedWallClockMs: number;
  readonly reservedGeneratedBytes: number;
  readonly reservedOutputBytes: number;
  readonly idempotencyKey: string;
}

export interface StartCandidateBootstrapStepV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly step: CandidateBootstrapStepV1;
  readonly reservationId: string;
  readonly budgetEventId: string;
  readonly journalEventId: string;
  readonly idempotencyKey: string;
}

export interface FinishCandidateBootstrapStepV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly step: CandidateBootstrapStepV1;
  readonly reservationId: string;
  readonly budgetEventId: string;
  readonly journalEventId: string;
  readonly eventType: 'observed' | 'failed';
  readonly generatedScopeFingerprint: string;
  readonly exitCode: number;
  readonly actualWallClockMs: number;
  readonly actualGeneratedBytes: number;
  readonly actualOutputBytes: number;
  readonly idempotencyKey: string;
}

export interface RetainUnknownCandidateBootstrapStepV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly step: CandidateBootstrapStepV1;
  readonly reservationId: string;
  readonly budgetEventId: string;
}

export interface FailPreparedCandidateBootstrapStepV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly step: CandidateBootstrapStepV1;
  readonly reservationId: string;
  readonly budgetEventId: string;
  readonly journalEventId: string;
  readonly generatedScopeFingerprint: string;
  readonly idempotencyKey: string;
}

export interface AdoptCandidateBootstrapStateV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly expectedPreviousStateDigest: string;
  readonly journalEventId: string;
  readonly observedGeneratedScopeFingerprint: string;
  readonly idempotencyKey: string;
}

export interface CandidateBootstrapOwnershipRecoveryV1 {
  readonly status: 'current' | 'requires_adoption';
  readonly stateDigest: string;
  readonly generatedPathScopes: readonly string[];
}

export class CandidateBootstrapStateStore {
  private readonly rootDirectory: string;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(options: CandidateBootstrapStateStoreOptions) {
    if (!isRecord(options)
      || typeof options.rootDirectory !== 'string'
      || options.rootDirectory.length === 0) {
      fail(
        'candidate_bootstrap_state_invalid_input',
        'A private bootstrap state root is required.',
      );
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.statePath = join(this.rootDirectory, STATE_FILE);
    this.lockPath = join(this.rootDirectory, LOCK_FILE);
  }

  async initialize(
    input: InitializeCandidateBootstrapStateV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.withLock(async () => {
      assertLeasePlan(input.worktreeLease, input.bootstrapPlan);
      if (!validateBootstrapBudget(input.bootstrapBudget)
        || input.bootstrapBudget.bootstrapPlanId
          !== input.bootstrapPlan.bootstrapPlanId
        || input.bootstrapBudget.budgetDigest
          !== input.bootstrapPlan.bootstrapBudgetDigest) {
        invalidInput('The bootstrap budget does not match the frozen plan.');
      }
      const existing = await readStateOrNull(this.statePath);
      if (existing !== null) {
        assertCurrentBinding(
          existing,
          input.worktreeLease,
          input.bootstrapPlan,
        );
        if (existing.initialBudgetDigest
          !== input.bootstrapBudget.budgetDigest
          || existing.journal.journalId !== input.journalId) {
          conflict('A different bootstrap state already exists.');
        }
        return existing;
      }
      const journal = createBootstrapExecutionJournal({
        journalId: input.journalId,
        bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
        leaseId: input.worktreeLease.leaseId,
        worktreeFencingTokenDigest:
          input.worktreeLease.fencingTokenDigest,
      });
      const state = sealState({
        schemaVersion: 1,
        leaseId: input.worktreeLease.leaseId,
        candidateId: input.worktreeLease.candidateId,
        bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
        worktreeLeaseDigest: input.worktreeLease.leaseDigest,
        worktreeFencingTokenDigest:
          input.worktreeLease.fencingTokenDigest,
        initialBudgetDigest: input.bootstrapBudget.budgetDigest,
        budget: input.bootstrapBudget,
        reservations: [],
        budgetEvents: [],
        journal,
        journalEvents: [],
        revision: 0,
      });
      await writePrivateAtomic(this.statePath, canonicalJson(state));
      return state;
    });
  }

  async inspect(
    worktreeLease: WorktreeLeaseV1,
    bootstrapPlan: CandidateBootstrapPlanV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.withLock(async () => {
      assertLeasePlan(worktreeLease, bootstrapPlan);
      const state = await readState(this.statePath);
      assertCurrentBinding(state, worktreeLease, bootstrapPlan);
      return state;
    });
  }

  async inspectOwnershipRecovery(input: {
    readonly worktreeLease: WorktreeLeaseV1;
    readonly bootstrapPlan: CandidateBootstrapPlanV1;
    readonly ownershipAncestors: readonly {
      readonly leaseDigest: string;
      readonly fencingTokenDigest: string;
      readonly state: string;
    }[];
  }): Promise<CandidateBootstrapOwnershipRecoveryV1 | null> {
    return this.withLock(async () => {
      assertLeasePlan(input.worktreeLease, input.bootstrapPlan);
      if (!Array.isArray(input.ownershipAncestors)
        || input.ownershipAncestors.some((ancestor) =>
          !isRecord(ancestor)
          || !isDigest(ancestor['leaseDigest'])
          || !isDigest(ancestor['fencingTokenDigest'])
          || ancestor['state'] !== 'bootstrapping'
          || ancestor['leaseDigest']
            === input.worktreeLease.leaseDigest
          || ancestor['fencingTokenDigest']
            === input.worktreeLease.fencingTokenDigest)) {
        invalidInput(
          'The bootstrap ownership recovery binding is invalid.',
        );
      }
      const state = await readStateOrNull(this.statePath);
      if (state === null) return null;
      if (state.leaseId !== input.worktreeLease.leaseId
        || state.candidateId !== input.worktreeLease.candidateId
        || state.bootstrapPlanDigest
          !== input.bootstrapPlan.bootstrapPlanDigest
        || state.worktreeFencingTokenDigest
          !== state.journal.currentWorktreeFencingTokenDigest) {
        stale('The bootstrap state cannot be recovered by this owner.');
      }
      if (state.worktreeLeaseDigest
          === input.worktreeLease.leaseDigest
        && state.worktreeFencingTokenDigest
          === input.worktreeLease.fencingTokenDigest) {
        return Object.freeze({
          status: 'current' as const,
          stateDigest: state.stateDigest,
          generatedPathScopes: Object.freeze([]),
        });
      }
      const exactAncestor = input.ownershipAncestors.some(
        (ancestor) =>
          ancestor.leaseDigest === state.worktreeLeaseDigest
          && ancestor.fencingTokenDigest
            === state.worktreeFencingTokenDigest,
      );
      if (!exactAncestor
        || state.journal.state !== 'ready'
        || state.reservations.some((reservation) =>
          reservation.state === 'reserved'
          || reservation.state === 'running')) {
        stale('The bootstrap state cannot be recovered by this owner.');
      }
      const lastSuccessfulStep = state.journalEvents.findLast(
        (event) => event.eventType === 'observed'
          || event.eventType === 'reconciled',
      );
      const generatedPathScopes =
        lastSuccessfulStep === undefined
          ? []
          : input.bootstrapPlan.steps.find(
              (step) => step.stepId === lastSuccessfulStep.stepId,
            )?.generatedPathScopes;
      if (generatedPathScopes === undefined) {
        integrity(
          'The bootstrap recovery journal references an unknown step.',
        );
      }
      return Object.freeze({
        status: 'requires_adoption' as const,
        stateDigest: state.stateDigest,
        generatedPathScopes:
          Object.freeze([...generatedPathScopes]),
      });
    });
  }

  async prepareStep(
    input: PrepareCandidateBootstrapStepV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.update(input, (state) => {
      if (exactTransitionAlreadyCommitted(state, {
        budgetEventId: input.budgetEventId,
        budgetEventType: 'reserved',
        journalEventId: input.journalEventId,
        journalEventType: 'prepared',
        journalIdempotencyKey: `${input.idempotencyKey}:prepared`,
        step: input.step,
        reservationId: input.reservationId,
      })) {
        return state;
      }
      assertNextStep(state, input.bootstrapPlan, input.step);
      let budgetTransition;
      let journalTransition;
      try {
        budgetTransition = reserveBootstrapBudget(
          state.budget,
          state.reservations,
          {
            reservationId: input.reservationId,
            eventId: input.budgetEventId,
            stepId: input.step.stepId,
            worktreeFencingTokenDigest:
              input.worktreeLease.fencingTokenDigest,
            reservedWallClockMs: input.reservedWallClockMs,
            reservedGeneratedBytes: input.reservedGeneratedBytes,
            reservedOutputBytes: input.reservedOutputBytes,
            idempotencyKey: `${input.idempotencyKey}:budget`,
          },
        );
        journalTransition = appendBootstrapStepEvent(state.journal, {
          eventId: input.journalEventId,
          eventType: 'prepared',
          worktreeFencingTokenDigest:
            input.worktreeLease.fencingTokenDigest,
          stepId: input.step.stepId,
          reservationId: input.reservationId,
          argvDigest: input.step.argvDigest,
          effectiveEnvironmentDigest:
            input.step.effectiveEnvironmentDigest,
          idempotencyKey: `${input.idempotencyKey}:prepared`,
        });
      } catch (error) {
        invalidTransition('Unable to prepare the bootstrap step.', error);
      }
      return evolveState(state, {
        budget: budgetTransition.budget,
        reservations: [
          ...state.reservations,
          budgetTransition.reservation,
        ],
        budgetEvents: [...state.budgetEvents, budgetTransition.event],
        journal: journalTransition.journal,
        journalEvents: [...state.journalEvents, journalTransition.event],
      });
    });
  }

  async startStep(
    input: StartCandidateBootstrapStepV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.update(input, (state) => {
      if (exactTransitionAlreadyCommitted(state, {
        budgetEventId: input.budgetEventId,
        budgetEventType: 'started',
        journalEventId: input.journalEventId,
        journalEventType: 'started',
        journalIdempotencyKey: `${input.idempotencyKey}:started`,
        step: input.step,
        reservationId: input.reservationId,
      })) {
        return state;
      }
      const reservation = assertActiveReservation(
        state,
        input.step,
        input.reservationId,
        'reserved',
      );
      let budgetTransition;
      let journalTransition;
      try {
        budgetTransition = transitionBootstrapBudgetReservation(
          state.budget,
          reservation,
          {
            eventId: input.budgetEventId,
            toState: 'running',
          },
        );
        journalTransition = appendBootstrapStepEvent(state.journal, {
          eventId: input.journalEventId,
          eventType: 'started',
          worktreeFencingTokenDigest:
            input.worktreeLease.fencingTokenDigest,
          stepId: input.step.stepId,
          reservationId: input.reservationId,
          argvDigest: input.step.argvDigest,
          effectiveEnvironmentDigest:
            input.step.effectiveEnvironmentDigest,
          idempotencyKey: `${input.idempotencyKey}:started`,
        });
      } catch (error) {
        invalidTransition('Unable to start the bootstrap step.', error);
      }
      return withReservationTransition(
        state,
        budgetTransition,
        journalTransition,
      );
    });
  }

  async finishStep(
    input: FinishCandidateBootstrapStepV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.update(input, (state) => {
      if (exactTransitionAlreadyCommitted(state, {
        budgetEventId: input.budgetEventId,
        budgetEventType: 'settled',
        journalEventId: input.journalEventId,
        journalEventType: input.eventType,
        journalIdempotencyKey:
          `${input.idempotencyKey}:${input.eventType}`,
        step: input.step,
        reservationId: input.reservationId,
      })) {
        return state;
      }
      const reservation = assertActiveReservation(
        state,
        input.step,
        input.reservationId,
        'running',
      );
      let budgetTransition;
      let journalTransition;
      try {
        budgetTransition = transitionBootstrapBudgetReservation(
          state.budget,
          reservation,
          {
            eventId: input.budgetEventId,
            toState: 'settled',
            actualWallClockMs: input.actualWallClockMs,
            actualGeneratedBytes: input.actualGeneratedBytes,
            actualOutputBytes: input.actualOutputBytes,
          },
        );
        journalTransition = appendBootstrapStepEvent(state.journal, {
          eventId: input.journalEventId,
          eventType: input.eventType,
          worktreeFencingTokenDigest:
            input.worktreeLease.fencingTokenDigest,
          stepId: input.step.stepId,
          reservationId: input.reservationId,
          argvDigest: input.step.argvDigest,
          effectiveEnvironmentDigest:
            input.step.effectiveEnvironmentDigest,
          generatedScopeFingerprint:
            input.generatedScopeFingerprint,
          exitCode: input.exitCode,
          idempotencyKey: `${input.idempotencyKey}:${input.eventType}`,
        });
      } catch (error) {
        invalidTransition('Unable to finish the bootstrap step.', error);
      }
      return withReservationTransition(
        state,
        budgetTransition,
        journalTransition,
      );
    });
  }

  async retainUnknown(
    input: RetainUnknownCandidateBootstrapStepV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.update(input, (state) => {
      const prior = state.budgetEvents.find(
        (event) => event.eventId === input.budgetEventId,
      );
      if (prior !== undefined) {
        if (prior.eventType !== 'retained_unknown'
          || prior.reservation.reservationId !== input.reservationId
          || prior.reservation.stepId !== input.step.stepId) {
          conflict('The bootstrap retained-unknown event was reused.');
        }
        return state;
      }
      const reservation = assertActiveReservation(
        state,
        input.step,
        input.reservationId,
        'running',
      );
      let transition;
      try {
        transition = transitionBootstrapBudgetReservation(
          state.budget,
          reservation,
          {
            eventId: input.budgetEventId,
            toState: 'retained_unknown',
          },
        );
      } catch (error) {
        invalidTransition(
          'Unable to retain unknown bootstrap usage.',
          error,
        );
      }
      return evolveState(state, {
        budget: transition.budget,
        reservations: replaceReservation(
          state.reservations,
          transition.reservation,
        ),
        budgetEvents: [...state.budgetEvents, transition.event],
      });
    });
  }

  async failPrepared(
    input: FailPreparedCandidateBootstrapStepV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.update(input, (state) => {
      if (exactTransitionAlreadyCommitted(state, {
        budgetEventId: input.budgetEventId,
        budgetEventType: 'cancelled',
        journalEventId: input.journalEventId,
        journalEventType: 'failed',
        journalIdempotencyKey:
          `${input.idempotencyKey}:prepared_recovery_failed`,
        step: input.step,
        reservationId: input.reservationId,
      })) {
        return state;
      }
      const reservation = assertActiveReservation(
        state,
        input.step,
        input.reservationId,
        'reserved',
      );
      let budgetTransition;
      let journalTransition;
      try {
        budgetTransition = transitionBootstrapBudgetReservation(
          state.budget,
          reservation,
          {
            eventId: input.budgetEventId,
            toState: 'cancelled',
          },
        );
        journalTransition = appendBootstrapStepEvent(state.journal, {
          eventId: input.journalEventId,
          eventType: 'failed',
          worktreeFencingTokenDigest:
            input.worktreeLease.fencingTokenDigest,
          stepId: input.step.stepId,
          reservationId: input.reservationId,
          argvDigest: input.step.argvDigest,
          effectiveEnvironmentDigest:
            input.step.effectiveEnvironmentDigest,
          generatedScopeFingerprint:
            input.generatedScopeFingerprint,
          exitCode: -1,
          idempotencyKey:
            `${input.idempotencyKey}:prepared_recovery_failed`,
        });
      } catch (error) {
        invalidTransition(
          'Unable to fail the unstarted bootstrap step.',
          error,
        );
      }
      return withReservationTransition(
        state,
        budgetTransition,
        journalTransition,
      );
    });
  }

  async adoptOwnership(
    input: AdoptCandidateBootstrapStateV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.withLock(async () => {
      assertLeasePlan(input.worktreeLease, input.bootstrapPlan);
      const state = await readState(this.statePath);
      const prior = state.journalEvents.find(
        (event) => event.eventId === input.journalEventId,
      );
      if (prior !== undefined) {
        if (prior.eventType !== 'ownership_adopted'
          || prior.idempotencyKey !== input.idempotencyKey
          || prior.worktreeFencingTokenDigest
            !== input.worktreeLease.fencingTokenDigest
          || state.worktreeLeaseDigest
            !== input.worktreeLease.leaseDigest
          || state.worktreeFencingTokenDigest
            !== input.worktreeLease.fencingTokenDigest) {
          conflict('The bootstrap ownership event was reused.');
        }
        return state;
      }
      if (!isDigest(input.expectedPreviousStateDigest)
        || state.stateDigest !== input.expectedPreviousStateDigest
        || state.leaseId !== input.worktreeLease.leaseId
        || state.candidateId !== input.worktreeLease.candidateId
        || state.bootstrapPlanDigest
          !== input.bootstrapPlan.bootstrapPlanDigest
        || state.worktreeFencingTokenDigest
          !== state.journal.currentWorktreeFencingTokenDigest
        || state.worktreeFencingTokenDigest
          === input.worktreeLease.fencingTokenDigest
        || state.journal.state !== 'ready'
        || state.reservations.some((reservation) =>
          reservation.state === 'reserved'
          || reservation.state === 'running')) {
        stale('The bootstrap state cannot adopt this worktree owner.');
      }
      let transition;
      try {
        transition = adoptBootstrapJournalOwnership(state.journal, {
          eventId: input.journalEventId,
          previousWorktreeFencingTokenDigest:
            state.worktreeFencingTokenDigest,
          currentWorktreeFencingTokenDigest:
            input.worktreeLease.fencingTokenDigest,
          observedGeneratedScopeFingerprint:
            input.observedGeneratedScopeFingerprint,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        invalidTransition(
          'Unable to adopt the bootstrap execution journal.',
          error,
        );
      }
      const next = evolveState(state, {
        worktreeLeaseDigest: input.worktreeLease.leaseDigest,
        worktreeFencingTokenDigest:
          input.worktreeLease.fencingTokenDigest,
        journal: transition.journal,
        journalEvents: [...state.journalEvents, transition.event],
      });
      await writePrivateAtomic(this.statePath, canonicalJson(next));
      return next;
    });
  }

  private async update<
    Input extends {
      readonly worktreeLease: WorktreeLeaseV1;
      readonly bootstrapPlan: CandidateBootstrapPlanV1;
      readonly step: CandidateBootstrapStepV1;
    },
  >(
    input: Input,
    callback: (state: CandidateBootstrapStateV1) =>
      CandidateBootstrapStateV1,
  ): Promise<CandidateBootstrapStateV1> {
    return this.withLock(async () => {
      assertLeasePlanStep(
        input.worktreeLease,
        input.bootstrapPlan,
        input.step,
      );
      const state = await readState(this.statePath);
      assertCurrentBinding(
        state,
        input.worktreeLease,
        input.bootstrapPlan,
      );
      const next = callback(state);
      await writePrivateAtomic(this.statePath, canonicalJson(next));
      return next;
    });
  }

  private async withLock<Result>(
    callback: () => Promise<Result>,
  ): Promise<Result> {
    await assertPrivateDirectory(this.rootDirectory);
    try {
      await writePrivateExclusive(this.lockPath, '');
      await syncDirectory(this.rootDirectory);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    await readPrivateFile(this.lockPath);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.lockPath, {
        realpath: true,
        retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      throw new CandidateBootstrapStateStoreError(
        'candidate_bootstrap_state_lock_failed',
        'Unable to lock the bootstrap state store.',
        { cause: error },
      );
    }
    try {
      return await callback();
    } finally {
      await release();
    }
  }
}

function withReservationTransition(
  state: CandidateBootstrapStateV1,
  budgetTransition: ReturnType<
    typeof transitionBootstrapBudgetReservation
  >,
  journalTransition: ReturnType<typeof appendBootstrapStepEvent>,
): CandidateBootstrapStateV1 {
  return evolveState(state, {
    budget: budgetTransition.budget,
    reservations: replaceReservation(
      state.reservations,
      budgetTransition.reservation,
    ),
    budgetEvents: [...state.budgetEvents, budgetTransition.event],
    journal: journalTransition.journal,
    journalEvents: [...state.journalEvents, journalTransition.event],
  });
}

function exactTransitionAlreadyCommitted(
  state: CandidateBootstrapStateV1,
  expected: {
    readonly budgetEventId: string;
    readonly budgetEventType:
      | 'reserved'
      | 'started'
      | 'settled'
      | 'cancelled';
    readonly journalEventId: string;
    readonly journalEventType: 'prepared' | 'started' | 'observed' | 'failed';
    readonly journalIdempotencyKey: string;
    readonly step: CandidateBootstrapStepV1;
    readonly reservationId: string;
  },
): boolean {
  const budgetEvent = state.budgetEvents.find(
    (event) => event.eventId === expected.budgetEventId,
  );
  const journalEvent = state.journalEvents.find(
    (event) => event.eventId === expected.journalEventId,
  );
  if (budgetEvent === undefined && journalEvent === undefined) return false;
  if (budgetEvent === undefined
    || journalEvent === undefined
    || budgetEvent.eventType !== expected.budgetEventType
    || budgetEvent.reservation.reservationId !== expected.reservationId
    || budgetEvent.reservation.stepId !== expected.step.stepId
    || journalEvent.eventType !== expected.journalEventType
    || journalEvent.idempotencyKey !== expected.journalIdempotencyKey
    || journalEvent.stepId !== expected.step.stepId
    || journalEvent.reservationId !== expected.reservationId
    || journalEvent.argvDigest !== expected.step.argvDigest
    || journalEvent.effectiveEnvironmentDigest
      !== expected.step.effectiveEnvironmentDigest) {
    conflict('A bootstrap transition identity was only partially reused.');
  }
  return true;
}

function evolveState(
  state: CandidateBootstrapStateV1,
  change: Partial<Omit<CandidateBootstrapStateV1, 'stateDigest'>>,
): CandidateBootstrapStateV1 {
  return sealState({
    ...withoutStateDigest(state),
    ...change,
    revision: state.revision + 1,
  });
}

function sealState(
  core: Omit<CandidateBootstrapStateV1, 'stateDigest'>,
): CandidateBootstrapStateV1 {
  const frozen = {
    ...core,
    reservations: Object.freeze([...core.reservations]),
    budgetEvents: Object.freeze([...core.budgetEvents]),
    journalEvents: Object.freeze([...core.journalEvents]),
  };
  return Object.freeze({
    ...frozen,
    stateDigest: canonicalDigest(
      'wukong/candidate-bootstrap-state/v1',
      frozen,
    ),
  });
}

function withoutStateDigest(
  state: CandidateBootstrapStateV1,
): Omit<CandidateBootstrapStateV1, 'stateDigest'> {
  const { stateDigest: _, ...core } = state;
  return core;
}

function replaceReservation(
  reservations: readonly BootstrapBudgetReservationV1[],
  next: BootstrapBudgetReservationV1,
): readonly BootstrapBudgetReservationV1[] {
  return reservations.map((reservation) =>
    reservation.reservationId === next.reservationId ? next : reservation);
}

function assertActiveReservation(
  state: CandidateBootstrapStateV1,
  step: CandidateBootstrapStepV1,
  reservationId: string,
  expectedState: 'reserved' | 'running',
): BootstrapBudgetReservationV1 {
  const reservation = state.reservations.find(
    (candidate) => candidate.reservationId === reservationId,
  );
  if (reservation === undefined
    || reservation.stepId !== step.stepId
    || reservation.state !== expectedState
    || state.journal.activeStepId !== step.stepId) {
    invalidTransition('The active bootstrap reservation is stale.');
  }
  return reservation;
}

function assertNextStep(
  state: CandidateBootstrapStateV1,
  plan: CandidateBootstrapPlanV1,
  step: CandidateBootstrapStepV1,
): void {
  if (state.journal.state !== 'ready') {
    invalidTransition('A bootstrap step is already active or blocked.');
  }
  const completed = new Set(
    state.journalEvents
      .filter((event) =>
        event.eventType === 'observed'
        || event.eventType === 'reconciled')
      .map((event) => event.stepId),
  );
  const next = plan.steps.find(
    (candidate) => !completed.has(candidate.stepId),
  );
  if (next?.stepDigest !== step.stepDigest
    || state.journalEvents.some((event) =>
      event.stepId === step.stepId
      && event.eventType !== 'ownership_adopted')) {
    invalidTransition('The bootstrap step is not the exact next plan step.');
  }
}

function assertLeasePlan(
  lease: WorktreeLeaseV1,
  plan: CandidateBootstrapPlanV1,
): void {
  if (!validateWorktreeLease(lease)
    || lease.state !== 'bootstrapping'
    || !validateCandidateBootstrapPlan(plan)
    || lease.bootstrapPlanDigest !== plan.bootstrapPlanDigest
    || lease.sourceSnapshotDigest !== plan.sourceSnapshotDigest
    || lease.gatePlanDigest !== plan.gatePlanDigest) {
    invalidInput('The bootstrap state lease/plan binding is invalid.');
  }
}

function assertLeasePlanStep(
  lease: WorktreeLeaseV1,
  plan: CandidateBootstrapPlanV1,
  step: CandidateBootstrapStepV1,
): void {
  assertLeasePlan(lease, plan);
  if (!validateCandidateBootstrapStep(step)
    || !plan.steps.some(
      (candidate) => candidate.stepDigest === step.stepDigest,
    )) {
    invalidInput('The bootstrap step is not part of the frozen plan.');
  }
}

function assertCurrentBinding(
  state: CandidateBootstrapStateV1,
  lease: WorktreeLeaseV1,
  plan: CandidateBootstrapPlanV1,
): void {
  if (state.leaseId !== lease.leaseId
    || state.candidateId !== lease.candidateId
    || state.bootstrapPlanDigest !== plan.bootstrapPlanDigest
    || state.worktreeLeaseDigest !== lease.leaseDigest
    || state.worktreeFencingTokenDigest !== lease.fencingTokenDigest) {
    stale('The bootstrap state worktree binding is stale.');
  }
}

function validateState(value: unknown): value is CandidateBootstrapStateV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'bootstrapPlanDigest',
      'budget',
      'budgetEvents',
      'candidateId',
      'initialBudgetDigest',
      'journal',
      'journalEvents',
      'leaseId',
      'reservations',
      'revision',
      'schemaVersion',
      'stateDigest',
      'worktreeFencingTokenDigest',
      'worktreeLeaseDigest',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || typeof value['leaseId'] !== 'string'
    || typeof value['candidateId'] !== 'string'
    || !isDigest(value['bootstrapPlanDigest'])
    || !isDigest(value['worktreeLeaseDigest'])
    || !isDigest(value['worktreeFencingTokenDigest'])
    || !isDigest(value['initialBudgetDigest'])
    || !validateBootstrapBudget(value['budget'])
    || !Array.isArray(value['reservations'])
    || !value['reservations'].every(validateBootstrapBudgetReservation)
    || !Array.isArray(value['budgetEvents'])
    || !value['budgetEvents'].every(validateBootstrapBudgetEvent)
    || !validateBootstrapExecutionJournal(value['journal'])
    || !Array.isArray(value['journalEvents'])
    || !value['journalEvents'].every(validateBootstrapExecutionEvent)
    || !Number.isSafeInteger(value['revision'])
    || Number(value['revision']) < 0
    || !isDigest(value['stateDigest'])) {
    return false;
  }
  const state = value as unknown as CandidateBootstrapStateV1;
  if (state.budgetEvents.length > MAX_EVENTS
    || state.journalEvents.length > MAX_EVENTS
    || state.budget.revision !== state.budgetEvents.length
    || state.journal.revision !== state.journalEvents.length
    || state.journal.leaseId !== state.leaseId
    || state.journal.bootstrapPlanDigest !== state.bootstrapPlanDigest
    || state.journal.currentWorktreeFencingTokenDigest
      !== state.worktreeFencingTokenDigest
    || canonicalDigest(
      'wukong/candidate-bootstrap-state/v1',
      withoutStateDigest(state),
    ) !== state.stateDigest) {
    return false;
  }
  return replayBudget(state) && replayJournal(state);
}

function replayBudget(state: CandidateBootstrapStateV1): boolean {
  let budget: BootstrapBudgetV1;
  try {
    budget = createBootstrapBudget({
      budgetId: state.budget.budgetId,
      bootstrapPlanId: state.budget.bootstrapPlanId,
      wallClockLimitMs: state.budget.wallClockLimitMs,
      generatedByteLimit: state.budget.generatedByteLimit,
      processOutputByteLimit: state.budget.processOutputByteLimit,
      stepLimit: state.budget.stepLimit,
    });
  } catch {
    return false;
  }
  if (budget.budgetDigest !== state.initialBudgetDigest) return false;
  const reservations: BootstrapBudgetReservationV1[] = [];
  for (const event of state.budgetEvents) {
    try {
      const previous = reservations.find(
        (item) => item.reservationId === event.reservation.reservationId,
      );
      const transition = previous === undefined
        ? reserveBootstrapBudget(budget, reservations, {
            reservationId: event.reservation.reservationId,
            eventId: event.eventId,
            stepId: event.reservation.stepId,
            worktreeFencingTokenDigest:
              event.reservation.worktreeFencingTokenDigest,
            reservedWallClockMs:
              event.reservation.reservedWallClockMs,
            reservedGeneratedBytes:
              event.reservation.reservedGeneratedBytes,
            reservedOutputBytes:
              event.reservation.reservedOutputBytes,
            idempotencyKey: event.reservation.idempotencyKey,
          })
        : transitionBootstrapBudgetReservation(
            budget,
            previous,
            {
              eventId: event.eventId,
              toState: event.reservation.state as Exclude<
                BootstrapBudgetReservationV1['state'],
                'reserved'
              >,
              ...(event.reservation.state === 'settled'
                ? {
                    actualWallClockMs:
                      event.reservation.actualWallClockMs!,
                    actualGeneratedBytes:
                      event.reservation.actualGeneratedBytes!,
                    actualOutputBytes:
                      event.reservation.actualOutputBytes!,
                  }
                : {}),
            },
          );
      if (canonicalJson(transition.event) !== canonicalJson(event)) {
        return false;
      }
      budget = transition.budget;
      const index = reservations.findIndex(
        (item) => item.reservationId
          === transition.reservation.reservationId,
      );
      if (index === -1) reservations.push(transition.reservation);
      else reservations[index] = transition.reservation;
    } catch {
      return false;
    }
  }
  return canonicalJson(budget) === canonicalJson(state.budget)
    && canonicalJson(reservations)
      === canonicalJson(state.reservations);
}

function replayJournal(state: CandidateBootstrapStateV1): boolean {
  let journal: BootstrapExecutionJournalV1;
  try {
    journal = createBootstrapExecutionJournal({
      journalId: state.journal.journalId,
      bootstrapPlanDigest: state.journal.bootstrapPlanDigest,
      leaseId: state.journal.leaseId,
      worktreeFencingTokenDigest:
        state.journal.createdByWorktreeFencingTokenDigest,
    });
  } catch {
    return false;
  }
  for (const event of state.journalEvents) {
    try {
      const transition = event.eventType === 'ownership_adopted'
        ? adoptBootstrapJournalOwnership(journal, {
            eventId: event.eventId,
            previousWorktreeFencingTokenDigest:
              event.previousWorktreeFencingTokenDigest!,
            currentWorktreeFencingTokenDigest:
              event.worktreeFencingTokenDigest,
            observedGeneratedScopeFingerprint:
              event.generatedScopeFingerprint!,
            idempotencyKey: event.idempotencyKey,
          })
        : appendBootstrapStepEvent(journal, {
            eventId: event.eventId,
            eventType: event.eventType,
            worktreeFencingTokenDigest:
              event.worktreeFencingTokenDigest,
            stepId: event.stepId!,
            reservationId: event.reservationId!,
            argvDigest: event.argvDigest!,
            effectiveEnvironmentDigest:
              event.effectiveEnvironmentDigest!,
            ...(event.generatedScopeFingerprint === null
              ? {}
              : {
                  generatedScopeFingerprint:
                    event.generatedScopeFingerprint,
                  exitCode: event.exitCode!,
                }),
            idempotencyKey: event.idempotencyKey,
          });
      if (canonicalJson(transition.event) !== canonicalJson(event)) {
        return false;
      }
      journal = transition.journal;
    } catch {
      return false;
    }
  }
  return canonicalJson(journal) === canonicalJson(state.journal);
}

async function readState(
  path: string,
): Promise<CandidateBootstrapStateV1> {
  let value: unknown;
  try {
    value = JSON.parse((await readPrivateFile(path)).toString('utf8'));
  } catch (error) {
    if (error instanceof CandidateBootstrapStateStoreError) throw error;
    if (isNodeError(error, 'ENOENT')) {
      fail(
        'candidate_bootstrap_state_not_found',
        'The bootstrap state was not found.',
      );
    }
    integrity('The bootstrap state is not valid JSON.', error);
  }
  if (!validateState(value)) {
    integrity('The persisted bootstrap state is invalid.');
  }
  return value;
}

async function readStateOrNull(
  path: string,
): Promise<CandidateBootstrapStateV1 | null> {
  try {
    return await readState(path);
  } catch (error) {
    if (error instanceof CandidateBootstrapStateStoreError
      && error.reasonCode === 'candidate_bootstrap_state_not_found') {
      return null;
    }
    throw error;
  }
}

async function readPrivateFile(path: string): Promise<Buffer> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertPrivateFile(before);
    if (before.size > MAX_STATE_BYTES) {
      integrity('A bootstrap state file is oversized.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.byteLength !== after.size) {
      integrity('A bootstrap state file changed while reading.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivateExclusive(
  path: string,
  content: string,
): Promise<void> {
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

async function writePrivateAtomic(
  path: string,
  content: string,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.bootstrap-state-${canonicalDigest(
      'wukong/bootstrap-state-temp/v1',
      `${process.pid}:${Date.now()}:${randomBytes(16).toString('hex')}`,
    ).slice('sha256:'.length)}.tmp`,
  );
  await writePrivateExclusive(temporary, content);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      'candidate_bootstrap_state_root_unsafe',
      'The bootstrap state root is not a directory.',
    );
  }
  if (process.platform !== 'win32'
    && ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      || (typeof process.getuid === 'function'
        && info.uid !== process.getuid()))) {
    fail(
      'candidate_bootstrap_state_root_unsafe',
      'The bootstrap state root is not mode 0700 for the current owner.',
    );
  }
}

function assertPrivateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    integrity('A bootstrap state file has an unsafe identity.');
  }
  if (process.platform !== 'win32'
    && ((info.mode & 0o777) !== PRIVATE_FILE_MODE
      || (typeof process.getuid === 'function'
        && info.uid !== process.getuid()))) {
    integrity('A bootstrap state file is not mode 0600 for the current owner.');
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

function sameFile(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): never {
  fail('candidate_bootstrap_state_invalid_input', message);
}

function conflict(message: string): never {
  fail('candidate_bootstrap_state_conflict', message);
}

function stale(message: string): never {
  fail('candidate_bootstrap_state_stale_binding', message);
}

function invalidTransition(message: string, cause?: unknown): never {
  throw new CandidateBootstrapStateStoreError(
    'candidate_bootstrap_state_invalid_transition',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function integrity(message: string, cause?: unknown): never {
  throw new CandidateBootstrapStateStoreError(
    'candidate_bootstrap_state_integrity_failed',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function fail(
  reasonCode: CandidateBootstrapStateStoreErrorCode,
  message: string,
): never {
  throw new CandidateBootstrapStateStoreError(reasonCode, message);
}
