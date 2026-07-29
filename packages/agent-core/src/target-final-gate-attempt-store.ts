import { randomUUID } from 'node:crypto';
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
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  validateTargetFinalGateAttemptResult,
  validateTargetFinalGateEvidenceSnapshot,
  type TargetFinalGateAttemptResultV1,
  type TargetFinalGateEvidenceSnapshotV1,
} from '@wukong/verification';

import type {
  TargetPromotionExclusiveLeaseViewV1,
} from './target-promotion-lease-store';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ATTEMPTS_DIRECTORY = 'target-final-gate-attempts';
const EVENTS_DIRECTORY = 'events';
const STATE_FILE = 'attempt.json';
const EVENT_PATTERN = /^([0-9]{12})\.json$/u;
const MAX_BYTES = 128 * 1024 * 1024;

export type TargetFinalGateAttemptStateNameV1 =
  | 'prepared'
  | 'evidence_recorded'
  | 'completed';

export interface TargetFinalGateAttemptStateV1 {
  readonly schemaVersion: 1;
  readonly finalGateAttemptId: string;
  readonly casRevision: number;
  readonly runId: string;
  readonly contractId: string;
  readonly acceptanceContractDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly sourceSnapshotDigest: string;
  readonly candidateDeltaDigest: string;
  readonly promotionJournalId: string;
  readonly promotionJournalHeadDigest: string;
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly createdByTargetFencingTokenDigest: string;
  readonly targetFencingTokenDigest: string;
  readonly targetFencingTokenLineage: readonly string[];
  readonly targetAfterFingerprintDigest: string;
  readonly state: TargetFinalGateAttemptStateNameV1;
  readonly evidence: TargetFinalGateEvidenceSnapshotV1 | null;
  readonly result: TargetFinalGateAttemptResultV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly previousStateDigest: string | null;
  readonly stateDigest: string;
}

export type TargetFinalGateAttemptStoreErrorCode =
  | 'target_final_gate_invalid_input'
  | 'target_final_gate_not_found'
  | 'target_final_gate_stale_binding'
  | 'target_final_gate_invalid_state'
  | 'target_final_gate_integrity_failed'
  | 'target_final_gate_root_unsafe';

export class TargetFinalGateAttemptStoreError extends Error {
  constructor(
    readonly reasonCode: TargetFinalGateAttemptStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TargetFinalGateAttemptStoreError';
  }
}

interface TargetFinalGateAttemptEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType:
    | TargetFinalGateAttemptStateNameV1
    | 'ownership_adopted';
  readonly previousEventDigest: string | null;
  readonly previousStateDigest: string | null;
  readonly nextState: TargetFinalGateAttemptStateV1;
  readonly occurredAt: string;
  readonly eventDigest: string;
}

interface AttemptPaths {
  readonly directory: string;
  readonly state: string;
  readonly events: string;
}

export class TargetFinalGateAttemptStore {
  private readonly now: () => Date;

  constructor(options?: { readonly now?: () => Date }) {
    if (options?.now !== undefined && typeof options.now !== 'function') {
      invalid('Target Final Gate attempt store options are invalid.');
    }
    this.now = options?.now ?? (() => new Date());
  }

  async initialize(
    view: TargetPromotionExclusiveLeaseViewV1,
    input: {
      readonly finalGateAttemptId: string;
      readonly runId: string;
      readonly contractId: string;
      readonly acceptanceContractDigest: string;
      readonly gatePlanDigest: string;
      readonly criteriaSelectionDigest: string;
      readonly sourceSnapshotDigest: string;
      readonly promotionJournalId: string;
      readonly promotionJournalHeadDigest: string;
      readonly targetAfterFingerprintDigest: string;
    },
  ): Promise<TargetFinalGateAttemptStateV1> {
    assertInitializeInput(view, input);
    await view.assertAuthority();
    const paths = await preparePaths(
      view.registryDirectory,
      input.finalGateAttemptId,
    );
    const existing = await loadOrRecover(paths);
    if (existing !== null) {
      assertImmutableBinding(existing.state, view, input);
      if (existing.state.targetFencingTokenDigest
          !== view.lease.fencingTokenDigest) {
        if (existing.state.targetFencingTokenLineage.includes(
          view.lease.fencingTokenDigest,
        )) {
          stale('Target Final Gate fencing lineage cannot cycle.');
        }
        const adopted = sealState({
          ...existing.state,
          casRevision: existing.state.casRevision + 1,
          targetFencingTokenDigest:
            view.lease.fencingTokenDigest,
          targetFencingTokenLineage: Object.freeze([
            ...existing.state.targetFencingTokenLineage,
            view.lease.fencingTokenDigest,
          ]),
          updatedAt: timestamp(
            this.now(),
            existing.state.updatedAt,
          ),
          previousStateDigest: existing.state.stateDigest,
        });
        await persistTransition(
          paths,
          existing.lastEvent,
          adopted,
          'ownership_adopted',
        );
        await view.assertAuthority();
        return adopted;
      }
      assertStateLease(existing.state, view);
      return existing.state;
    }
    const createdAt = timestamp(this.now());
    const state = sealState({
      schemaVersion: 1,
      finalGateAttemptId: input.finalGateAttemptId,
      casRevision: 0,
      runId: input.runId,
      contractId: input.contractId,
      acceptanceContractDigest: input.acceptanceContractDigest,
      gatePlanDigest: input.gatePlanDigest,
      criteriaSelectionDigest: input.criteriaSelectionDigest,
      promotionId: view.lease.promotionId,
      candidateId: view.lease.candidateId,
      sourceSnapshotDigest: input.sourceSnapshotDigest,
      candidateDeltaDigest: view.lease.candidateDeltaDigest,
      promotionJournalId: input.promotionJournalId,
      promotionJournalHeadDigest: input.promotionJournalHeadDigest,
      targetPromotionLeaseId:
        view.lease.targetPromotionLeaseId,
      targetRegistryKey: view.lease.targetRegistryKey,
      createdByTargetFencingTokenDigest:
        view.lease.fencingTokenDigest,
      targetFencingTokenDigest: view.lease.fencingTokenDigest,
      targetFencingTokenLineage: Object.freeze([
        view.lease.fencingTokenDigest,
      ]),
      targetAfterFingerprintDigest:
        input.targetAfterFingerprintDigest,
      state: 'prepared',
      evidence: null,
      result: null,
      createdAt,
      updatedAt: createdAt,
      previousStateDigest: null,
    });
    await persistTransition(paths, null, state);
    await view.assertAuthority();
    return state;
  }

  async recordEvidence(
    view: TargetPromotionExclusiveLeaseViewV1,
    expected: TargetFinalGateAttemptStateV1,
    evidence: TargetFinalGateEvidenceSnapshotV1,
  ): Promise<TargetFinalGateAttemptStateV1> {
    if (!validateTargetFinalGateAttemptState(expected)
      || !validateTargetFinalGateEvidenceSnapshot(evidence)) {
      invalid('Target Final Gate evidence input is invalid.');
    }
    await view.assertAuthority();
    const paths = await preparePaths(
      view.registryDirectory,
      expected.finalGateAttemptId,
    );
    const loaded = await requireState(paths);
    assertStateLease(loaded.state, view);
    assertEvidenceBinding(loaded.state, evidence);
    if (loaded.state.stateDigest !== expected.stateDigest
      || loaded.state.casRevision !== expected.casRevision) {
      if (loaded.state.evidence?.evidenceDigest
        === evidence.evidenceDigest) {
        return loaded.state;
      }
      stale('Target Final Gate evidence CAS is stale.');
    }
    if (loaded.state.state !== 'prepared') {
      if (loaded.state.evidence?.evidenceDigest
        === evidence.evidenceDigest) {
        return loaded.state;
      }
      invalidState('Target Final Gate evidence is already recorded.');
    }
    const next = sealState({
      ...loaded.state,
      casRevision: loaded.state.casRevision + 1,
      state: 'evidence_recorded',
      evidence,
      updatedAt: timestamp(this.now(), loaded.state.updatedAt),
      previousStateDigest: loaded.state.stateDigest,
    });
    await persistTransition(paths, loaded.lastEvent, next);
    await view.assertAuthority();
    return next;
  }

  async complete(
    view: TargetPromotionExclusiveLeaseViewV1,
    expected: TargetFinalGateAttemptStateV1,
    result: TargetFinalGateAttemptResultV1,
  ): Promise<TargetFinalGateAttemptStateV1> {
    if (!validateTargetFinalGateAttemptState(expected)
      || !validateTargetFinalGateAttemptResult(result)) {
      invalid('Target Final Gate completion input is invalid.');
    }
    await view.assertAuthority();
    const paths = await preparePaths(
      view.registryDirectory,
      expected.finalGateAttemptId,
    );
    const loaded = await requireState(paths);
    assertStateLease(loaded.state, view);
    assertResultBinding(loaded.state, result);
    if (loaded.state.stateDigest !== expected.stateDigest
      || loaded.state.casRevision !== expected.casRevision) {
      if (loaded.state.result?.resultDigest === result.resultDigest) {
        return loaded.state;
      }
      stale('Target Final Gate completion CAS is stale.');
    }
    if (loaded.state.state !== 'evidence_recorded') {
      if (loaded.state.result?.resultDigest === result.resultDigest) {
        return loaded.state;
      }
      invalidState('Target Final Gate attempt cannot complete.');
    }
    const next = sealState({
      ...loaded.state,
      casRevision: loaded.state.casRevision + 1,
      state: 'completed',
      result,
      updatedAt: timestamp(this.now(), loaded.state.updatedAt),
      previousStateDigest: loaded.state.stateDigest,
    });
    await persistTransition(paths, loaded.lastEvent, next);
    await view.assertAuthority();
    return next;
  }

  async inspect(
    view: TargetPromotionExclusiveLeaseViewV1,
    finalGateAttemptId: string,
  ): Promise<TargetFinalGateAttemptStateV1> {
    if (!isUuid(finalGateAttemptId)) {
      invalid('Target Final Gate attempt id is invalid.');
    }
    await view.assertAuthority();
    const paths = await preparePaths(
      view.registryDirectory,
      finalGateAttemptId,
    );
    const loaded = await requireState(paths);
    assertStateLease(loaded.state, view);
    await view.assertAuthority();
    return loaded.state;
  }
}

export function validateTargetFinalGateAttemptState(
  value: unknown,
): value is TargetFinalGateAttemptStateV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'acceptanceContractDigest',
      'candidateDeltaDigest',
      'candidateId',
      'casRevision',
      'contractId',
      'createdByTargetFencingTokenDigest',
      'createdAt',
      'criteriaSelectionDigest',
      'evidence',
      'finalGateAttemptId',
      'gatePlanDigest',
      'previousStateDigest',
      'promotionId',
      'promotionJournalHeadDigest',
      'promotionJournalId',
      'result',
      'runId',
      'schemaVersion',
      'sourceSnapshotDigest',
      'state',
      'stateDigest',
      'targetAfterFingerprintDigest',
      'targetFencingTokenDigest',
      'targetFencingTokenLineage',
      'targetPromotionLeaseId',
      'targetRegistryKey',
      'updatedAt',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['finalGateAttemptId'])
    || !isNonNegativeInteger(value['casRevision'])
    || !isIdentifier(value['runId'])
    || !isIdentifier(value['contractId'])
    || !isDigest(value['acceptanceContractDigest'])
    || !isDigest(value['gatePlanDigest'])
    || !isDigest(value['criteriaSelectionDigest'])
    || !isUuid(value['promotionId'])
    || !isUuid(value['candidateId'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isUuid(value['promotionJournalId'])
    || !isDigest(value['promotionJournalHeadDigest'])
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetRegistryKey'])
    || !isDigest(value['createdByTargetFencingTokenDigest'])
    || !isDigest(value['targetFencingTokenDigest'])
    || !Array.isArray(value['targetFencingTokenLineage'])
    || value['targetFencingTokenLineage'].length === 0
    || value['targetFencingTokenLineage'].length > 1_024
    || !value['targetFencingTokenLineage'].every(isDigest)
    || !isDigest(value['targetAfterFingerprintDigest'])
    || (value['state'] !== 'prepared'
      && value['state'] !== 'evidence_recorded'
      && value['state'] !== 'completed')
    || (value['evidence'] !== null
      && !validateTargetFinalGateEvidenceSnapshot(value['evidence']))
    || (value['result'] !== null
      && !validateTargetFinalGateAttemptResult(value['result']))
    || !isTimestamp(value['createdAt'])
    || !isTimestamp(value['updatedAt'])
    || Date.parse(value['updatedAt']) < Date.parse(value['createdAt'])
    || !isNullableDigest(value['previousStateDigest'])
    || !isDigest(value['stateDigest'])) {
    return false;
  }
  const state = value as unknown as TargetFinalGateAttemptStateV1;
  if (state.targetFencingTokenLineage[0]
      !== state.createdByTargetFencingTokenDigest
    || state.targetFencingTokenLineage.at(-1)
      !== state.targetFencingTokenDigest
    || new Set(state.targetFencingTokenLineage).size
      !== state.targetFencingTokenLineage.length
    || (state.evidence !== null
      && !state.targetFencingTokenLineage.includes(
        state.evidence.targetFencingTokenDigest,
      ))
    || (state.result !== null
      && (state.evidence === null
        || state.result.targetFencingTokenDigest
          !== state.evidence.targetFencingTokenDigest))
    || (state.state === 'prepared'
      && (state.evidence !== null || state.result !== null))
    || (state.state === 'evidence_recorded'
      && (state.evidence === null || state.result !== null))
    || (state.state === 'completed'
      && (state.evidence === null || state.result === null))
    || (state.casRevision === 0) !== (state.previousStateDigest === null)) {
    return false;
  }
  const { stateDigest, ...core } = state;
  return canonicalDigest(
    'wukong/target-final-gate-attempt-state/v1',
    core,
  ) === stateDigest;
}

function sealState(
  input:
    | Omit<TargetFinalGateAttemptStateV1, 'stateDigest'>
    | TargetFinalGateAttemptStateV1,
): TargetFinalGateAttemptStateV1 {
  const { stateDigest: _discarded, ...core } =
    input as TargetFinalGateAttemptStateV1;
  const value = Object.freeze({
    ...core,
    stateDigest: canonicalDigest(
      'wukong/target-final-gate-attempt-state/v1',
      core,
    ),
  });
  if (!validateTargetFinalGateAttemptState(value)) {
    invalid('Target Final Gate state is invalid.');
  }
  return value;
}

async function persistTransition(
  paths: AttemptPaths,
  previous: TargetFinalGateAttemptEventV1 | null,
  nextState: TargetFinalGateAttemptStateV1,
  eventType:
    TargetFinalGateAttemptEventV1['eventType'] = nextState.state,
): Promise<void> {
  const core = {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    sequence: nextState.casRevision,
    eventType,
    previousEventDigest: previous?.eventDigest ?? null,
    previousStateDigest: nextState.previousStateDigest,
    nextState,
    occurredAt: nextState.updatedAt,
  };
  const event = Object.freeze({
    ...core,
    eventDigest: canonicalDigest(
      'wukong/target-final-gate-attempt-event/v1',
      core,
    ),
  });
  await writePrivateExclusive(
    join(
      paths.events,
      `${String(event.sequence).padStart(12, '0')}.json`,
    ),
    canonicalJson(event),
  );
  await syncDirectory(paths.events);
  await writePrivateAtomic(paths.state, canonicalJson(nextState));
}

async function loadOrRecover(paths: AttemptPaths): Promise<{
  readonly state: TargetFinalGateAttemptStateV1;
  readonly lastEvent: TargetFinalGateAttemptEventV1;
} | null> {
  const [persisted, events] = await Promise.all([
    readStateOrNull(paths.state),
    readEvents(paths.events),
  ]);
  if (persisted === null && events.length === 0) return null;
  if (events.length === 0) integrity('Target Final Gate events are missing.');
  validateEventChain(events);
  const lastEvent = events.at(-1)!;
  if (persisted === null
    || (events.length >= 2
      && persisted.stateDigest
        === events.at(-2)!.nextState.stateDigest)) {
    await writePrivateAtomic(
      paths.state,
      canonicalJson(lastEvent.nextState),
    );
  } else if (persisted.stateDigest
      !== lastEvent.nextState.stateDigest) {
    integrity('Target Final Gate state diverges from its events.');
  }
  return { state: lastEvent.nextState, lastEvent };
}

async function requireState(paths: AttemptPaths): Promise<{
  readonly state: TargetFinalGateAttemptStateV1;
  readonly lastEvent: TargetFinalGateAttemptEventV1;
}> {
  const loaded = await loadOrRecover(paths);
  if (loaded === null) {
    throw new TargetFinalGateAttemptStoreError(
      'target_final_gate_not_found',
      'Target Final Gate attempt was not found.',
    );
  }
  return loaded;
}

async function readEvents(
  directory: string,
): Promise<readonly TargetFinalGateAttemptEventV1[]> {
  const names = await readdir(directory);
  if (names.some((name) => !EVENT_PATTERN.test(name))) {
    integrity('Target Final Gate event directory contains an unknown entry.');
  }
  const events: TargetFinalGateAttemptEventV1[] = [];
  for (const name of names.toSorted()) {
    const value = JSON.parse(
      await readPrivateFile(join(directory, name)),
    ) as unknown;
    if (!validateEvent(value)) {
      integrity('Target Final Gate event is invalid.');
    }
    events.push(value);
  }
  return events;
}

function validateEventChain(
  events: readonly TargetFinalGateAttemptEventV1[],
): void {
  let previous: TargetFinalGateAttemptEventV1 | undefined;
  for (const event of events) {
    if (!validEventSuccessor(previous, event)
      || event.sequence !== (previous?.sequence ?? -1) + 1
      || event.previousEventDigest
        !== (previous?.eventDigest ?? null)
      || event.previousStateDigest
        !== (previous?.nextState.stateDigest ?? null)) {
      integrity('Target Final Gate event chain is invalid.');
    }
    previous = event;
  }
}

function validEventSuccessor(
  previous: TargetFinalGateAttemptEventV1 | undefined,
  event: TargetFinalGateAttemptEventV1,
): boolean {
  if (previous === undefined) {
    return event.eventType === 'prepared'
      && event.nextState.state === 'prepared'
      && event.nextState.casRevision === 0
      && event.nextState.targetFencingTokenLineage.length === 1;
  }
  const current = previous.nextState;
  const next = event.nextState;
  try {
    if (event.eventType === 'ownership_adopted') {
      if (next.targetFencingTokenLineage.length
          !== current.targetFencingTokenLineage.length + 1
        || next.targetFencingTokenLineage.slice(0, -1).some(
          (digest, index) =>
            digest !== current.targetFencingTokenLineage[index],
        )
        || next.targetFencingTokenDigest
          === current.targetFencingTokenDigest) {
        return false;
      }
      return canonicalJson(sealState({
        ...current,
        casRevision: current.casRevision + 1,
        targetFencingTokenDigest:
          next.targetFencingTokenDigest,
        targetFencingTokenLineage:
          next.targetFencingTokenLineage,
        updatedAt: event.occurredAt,
        previousStateDigest: current.stateDigest,
      })) === canonicalJson(next);
    }
    const expectedState =
      current.state === 'prepared'
        ? 'evidence_recorded'
        : current.state === 'evidence_recorded'
          ? 'completed'
          : null;
    if (event.eventType !== expectedState
      || next.state !== expectedState) {
      return false;
    }
    return canonicalJson(sealState({
      ...current,
      casRevision: current.casRevision + 1,
      state: next.state,
      evidence: next.evidence,
      result: next.result,
      updatedAt: event.occurredAt,
      previousStateDigest: current.stateDigest,
    })) === canonicalJson(next);
  } catch {
    return false;
  }
}

function validateEvent(
  value: unknown,
): value is TargetFinalGateAttemptEventV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      'eventDigest',
      'eventId',
      'eventType',
      'nextState',
      'occurredAt',
      'previousEventDigest',
      'previousStateDigest',
      'schemaVersion',
      'sequence',
    ])
    || value['schemaVersion'] !== 1
    || !isUuid(value['eventId'])
    || !isNonNegativeInteger(value['sequence'])
    || (value['eventType'] !== 'prepared'
      && value['eventType'] !== 'evidence_recorded'
      && value['eventType'] !== 'completed'
      && value['eventType'] !== 'ownership_adopted')
    || !isNullableDigest(value['previousEventDigest'])
    || !isNullableDigest(value['previousStateDigest'])
    || !validateTargetFinalGateAttemptState(value['nextState'])
    || !isTimestamp(value['occurredAt'])
    || !isDigest(value['eventDigest'])) {
    return false;
  }
  const event = value as unknown as TargetFinalGateAttemptEventV1;
  const { eventDigest, ...core } = event;
  return event.sequence === event.nextState.casRevision
    && (event.eventType === 'ownership_adopted'
      || event.eventType === event.nextState.state)
    && event.previousStateDigest
      === event.nextState.previousStateDigest
    && canonicalDigest(
      'wukong/target-final-gate-attempt-event/v1',
      core,
    ) === eventDigest;
}

function assertInitializeInput(
  view: TargetPromotionExclusiveLeaseViewV1,
  input: Parameters<TargetFinalGateAttemptStore['initialize']>[1],
): void {
  if (typeof view?.assertAuthority !== 'function'
    || view.lease.state !== 'final_verifying'
    || !isUuid(input.finalGateAttemptId)
    || !isIdentifier(input.runId)
    || !isIdentifier(input.contractId)
    || !isDigest(input.acceptanceContractDigest)
    || !isDigest(input.gatePlanDigest)
    || !isDigest(input.criteriaSelectionDigest)
    || !isDigest(input.sourceSnapshotDigest)
    || !isUuid(input.promotionJournalId)
    || !isDigest(input.promotionJournalHeadDigest)
    || !isDigest(input.targetAfterFingerprintDigest)) {
    invalid('Target Final Gate initialization input is invalid.');
  }
}

function assertImmutableBinding(
  state: TargetFinalGateAttemptStateV1,
  view: TargetPromotionExclusiveLeaseViewV1,
  input: Parameters<TargetFinalGateAttemptStore['initialize']>[1],
): void {
  if (view.lease.state !== 'final_verifying'
    || state.promotionId !== view.lease.promotionId
    || state.candidateId !== view.lease.candidateId
    || state.candidateDeltaDigest
      !== view.lease.candidateDeltaDigest
    || state.targetPromotionLeaseId
      !== view.lease.targetPromotionLeaseId
    || state.targetRegistryKey !== view.lease.targetRegistryKey
    || state.runId !== input.runId
    || state.contractId !== input.contractId
    || state.acceptanceContractDigest
      !== input.acceptanceContractDigest
    || state.gatePlanDigest !== input.gatePlanDigest
    || state.criteriaSelectionDigest
      !== input.criteriaSelectionDigest
    || state.sourceSnapshotDigest !== input.sourceSnapshotDigest
    || state.promotionJournalId !== input.promotionJournalId
    || state.promotionJournalHeadDigest
      !== input.promotionJournalHeadDigest
    || state.targetAfterFingerprintDigest
      !== input.targetAfterFingerprintDigest) {
    stale('Target Final Gate immutable binding changed.');
  }
}

function assertStateLease(
  state: TargetFinalGateAttemptStateV1,
  view: TargetPromotionExclusiveLeaseViewV1,
): void {
  if (view.lease.state !== 'final_verifying'
    || state.promotionId !== view.lease.promotionId
    || state.candidateId !== view.lease.candidateId
    || state.candidateDeltaDigest
      !== view.lease.candidateDeltaDigest
    || state.targetPromotionLeaseId
      !== view.lease.targetPromotionLeaseId
    || state.targetRegistryKey !== view.lease.targetRegistryKey
    || state.targetFencingTokenDigest
      !== view.lease.fencingTokenDigest) {
    stale('Target Final Gate lease binding is stale.');
  }
}

function assertEvidenceBinding(
  state: TargetFinalGateAttemptStateV1,
  evidence: TargetFinalGateEvidenceSnapshotV1,
): void {
  if (evidence.finalGateAttemptId !== state.finalGateAttemptId
    || evidence.runId !== state.runId
    || evidence.contractId !== state.contractId
    || evidence.acceptanceContractDigest
      !== state.acceptanceContractDigest
    || evidence.gatePlanDigest !== state.gatePlanDigest
    || evidence.criteriaSelectionDigest
      !== state.criteriaSelectionDigest
    || evidence.promotionId !== state.promotionId
    || evidence.candidateId !== state.candidateId
    || evidence.sourceSnapshotDigest !== state.sourceSnapshotDigest
    || evidence.candidateDeltaDigest !== state.candidateDeltaDigest
    || evidence.promotionJournalId !== state.promotionJournalId
    || evidence.promotionJournalHeadDigest
      !== state.promotionJournalHeadDigest
    || evidence.targetPromotionLeaseId
      !== state.targetPromotionLeaseId
    || !state.targetFencingTokenLineage.includes(
      evidence.targetFencingTokenDigest,
    )
    || evidence.targetAfterFingerprintDigest
      !== state.targetAfterFingerprintDigest) {
    stale('Target Final Gate evidence binding is stale.');
  }
}

function assertResultBinding(
  state: TargetFinalGateAttemptStateV1,
  result: TargetFinalGateAttemptResultV1,
): void {
  if (state.evidence === null
    || result.finalGateAttemptId !== state.finalGateAttemptId
    || result.runId !== state.runId
    || result.contractId !== state.contractId
    || result.promotionId !== state.promotionId
    || result.candidateId !== state.candidateId
    || result.promotionJournalId !== state.promotionJournalId
    || result.promotionJournalHeadDigest
      !== state.promotionJournalHeadDigest
    || result.targetPromotionLeaseId
      !== state.targetPromotionLeaseId
    || result.targetFencingTokenDigest
      !== state.evidence.targetFencingTokenDigest
    || result.targetAfterFingerprintDigest
      !== state.targetAfterFingerprintDigest
    || result.evidenceSnapshotId
      !== state.evidence.evidenceSnapshotId
    || result.evidenceDigest !== state.evidence.evidenceDigest
    || result.requiredGateCoverageDigest
      !== state.evidence.requiredGateCoverageDigest) {
    stale('Target Final Gate result binding is stale.');
  }
}

async function preparePaths(
  registryDirectory: string,
  attemptId: string,
): Promise<AttemptPaths> {
  const root = join(registryDirectory, ATTEMPTS_DIRECTORY);
  await ensurePrivateDirectory(root);
  const directory = join(root, attemptId);
  await ensurePrivateDirectory(directory);
  const events = join(directory, EVENTS_DIRECTORY);
  await ensurePrivateDirectory(events);
  return {
    directory,
    state: join(directory, STATE_FILE),
    events,
  };
}

async function readStateOrNull(
  path: string,
): Promise<TargetFinalGateAttemptStateV1 | null> {
  try {
    const value = JSON.parse(await readPrivateFile(path)) as unknown;
    if (!validateTargetFinalGateAttemptState(value)) {
      integrity('Target Final Gate state is invalid.');
    }
    return value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
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
      'target_final_gate_root_unsafe',
      'Target Final Gate directory is unsafe.',
    );
  }
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch {
      fail(
        'target_final_gate_root_unsafe',
        'Target Final Gate directory has an unsafe Windows ACL.',
      );
    }
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
    integrity('Target Final Gate private file is unsafe.');
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
    invalid('Target Final Gate time is invalid.');
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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).toSorted().join(',')
    === [...expected].toSorted().join(',');
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function invalid(message: string): never {
  fail('target_final_gate_invalid_input', message);
}

function stale(message: string): never {
  fail('target_final_gate_stale_binding', message);
}

function invalidState(message: string): never {
  fail('target_final_gate_invalid_state', message);
}

function integrity(message: string, cause?: unknown): never {
  fail('target_final_gate_integrity_failed', message, cause);
}

function fail(
  reasonCode: TargetFinalGateAttemptStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new TargetFinalGateAttemptStoreError(
    reasonCode,
    message,
    cause === undefined ? undefined : { cause },
  );
}
