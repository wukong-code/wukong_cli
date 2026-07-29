import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  beginCandidateGateReview,
  canonicalDigest,
  canonicalJson,
  containsSensitiveText,
  completeCandidateGateAttempt,
  recordCandidateDeterministicGate,
  createCandidateGateAttempt,
  validateCandidateGateAttempt,
  type CandidateBootstrapPlanV1,
  type CandidateGateAttemptV1,
  type CandidateGateOutcomeV1,
  type CandidateReviewerVerdictStatusV1,
  type FreshCriteriaVerdictV1,
  type ReviewSubjectManifestV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

import {
  CandidateDeltaStore,
  type CandidateDeltaSealV1,
} from './candidate-delta-store';
import {
  type CandidateDeterministicGateResultV1,
} from './candidate-gate-executor';
import {
  type CandidateBrokeredReviewPlanV1,
  validateCandidateBrokeredReviewPlan,
} from './candidate-review-plan';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
} from './worktree-lease-store';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ATTEMPTS_DIRECTORY = 'candidate-gate-attempts';
const EVENTS_DIRECTORY = 'events';
const LOCK_FILE = '.candidate-gate-attempts.lock';
const EVENT_FILE_PATTERN = /^([0-9]{12})\.json$/u;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

export type CandidateGateAttemptStoreErrorCode =
  | 'candidate_gate_attempt_invalid_input'
  | 'candidate_gate_attempt_not_found'
  | 'candidate_gate_attempt_stale_binding'
  | 'candidate_gate_attempt_invalid_state'
  | 'candidate_gate_attempt_integrity_failed'
  | 'candidate_gate_attempt_root_unsafe'
  | 'candidate_gate_attempt_lock_failed';

export class CandidateGateAttemptStoreError extends Error {
  constructor(
    readonly reasonCode: CandidateGateAttemptStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateGateAttemptStoreError';
  }
}

export interface CandidateGateAttemptStoreOptions {
  readonly privateRootDirectory: string;
  readonly sourceRepositoryRoot: string;
  readonly now?: () => Date;
}

interface CandidateGateAttemptEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly candidateGateAttemptId: string;
  readonly sequence: number;
  readonly eventType:
    | 'prepared'
    | 'deterministic_completed'
    | 'review_started'
    | 'completed';
  readonly previousStateDigest: string | null;
  readonly nextState: CandidateGateAttemptV1;
  readonly occurredAt: string;
  readonly eventDigest: string;
}

interface LiveInput {
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly candidateDeltaStore: CandidateDeltaStore;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
}

export class CandidateGateAttemptStore {
  private readonly privateRootDirectory: string;
  private readonly sourceRepositoryRoot: string;
  private readonly now: () => Date;

  constructor(options: CandidateGateAttemptStoreOptions) {
    if (!isRecord(options)
      || typeof options.privateRootDirectory !== 'string'
      || !isAbsolute(options.privateRootDirectory)
      || typeof options.sourceRepositoryRoot !== 'string'
      || !isAbsolute(options.sourceRepositoryRoot)
      || (options.now !== undefined && typeof options.now !== 'function')) {
      invalidInput('Candidate Gate attempt store options are invalid.');
    }
    this.privateRootDirectory = resolve(options.privateRootDirectory);
    this.sourceRepositoryRoot = resolve(options.sourceRepositoryRoot);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(input: LiveInput & {
    readonly candidateGateAttemptId: string;
  }): Promise<CandidateGateAttemptV1> {
    if (!isUuid(input.candidateGateAttemptId)) {
      invalidInput('Candidate Gate attempt id is invalid.');
    }
    return this.withLiveCandidate(input, async ({ lease, seal, paths }) =>
      this.withLock(paths, async () => {
        const existing = await this.loadOrRecover(paths);
        if (existing !== null) {
          assertAttemptBinding(existing, lease, seal);
          return existing;
        }
        const createdAt = canonicalTimestamp(this.now());
        const attempt = createCandidateGateAttempt({
          candidateGateAttemptId: input.candidateGateAttemptId,
          candidateId: lease.candidateId,
          leaseId: lease.leaseId,
          leaseCasRevision: lease.casRevision,
          verifyingLeaseDigest: lease.leaseDigest,
          candidateDeltaDigest: seal.delta.candidateDeltaDigest,
          candidateDeltaSealDigest: seal.sealDigest,
          gatePlanDigest: lease.gatePlanDigest,
          createdAt,
        });
        await this.persistTransition(paths, null, attempt, 'prepared');
        return attempt;
      }));
  }

  async recordDeterministic(input: LiveInput & {
    readonly expected: CandidateGateAttemptV1;
    readonly deterministicGate: CandidateDeterministicGateResultV1;
    readonly reviewPlan: CandidateBrokeredReviewPlanV1 | null;
  }): Promise<CandidateGateAttemptV1> {
    if (!validateCandidateGateAttempt(input.expected)
      || (input.reviewPlan !== null
        && !validateCandidateBrokeredReviewPlan(input.reviewPlan))) {
      invalidInput('Candidate deterministic Gate attempt input is invalid.');
    }
    return this.withLiveCandidate(input, async ({ lease, seal, paths }) =>
      this.withLock(paths, async () => {
        const current = await this.requireAttempt(paths, input.expected);
        assertAttemptBinding(current, lease, seal);
        assertDeterministicBinding(
          current,
          input.deterministicGate,
          input.reviewPlan,
        );
        const deterministicGateResultDigest = canonicalDigest(
          'wukong/candidate-deterministic-gate-result/v1',
          input.deterministicGate,
        );
        if (current.stateDigest !== input.expected.stateDigest
          || current.casRevision !== input.expected.casRevision) {
          if (current.deterministicGateResultDigest
              === deterministicGateResultDigest
            && current.reviewPlanDigest
              === (input.reviewPlan?.reviewPlanDigest ?? null)) {
            return current;
          }
          staleBinding('Candidate Gate attempt CAS binding is stale.');
        }
        if (current.state !== 'prepared') {
          if (current.deterministicGateResultDigest
              === deterministicGateResultDigest
            && current.reviewPlanDigest
              === (input.reviewPlan?.reviewPlanDigest ?? null)) {
            return current;
          }
          invalidState('Candidate deterministic Gate evidence is already bound.');
        }
        const next = recordCandidateDeterministicGate(current, {
          deterministicGateResultDigest,
          deterministicGateStatus: input.deterministicGate.status,
          reviewPlanDigest: input.reviewPlan?.reviewPlanDigest ?? null,
          occurredAt: canonicalTimestamp(this.now(), current.updatedAt),
        });
        await this.persistTransition(
          paths,
          current,
          next,
          'deterministic_completed',
        );
        return next;
      }));
  }

  async beginReview(input: LiveInput & {
    readonly expected: CandidateGateAttemptV1;
    readonly reviewPlan: CandidateBrokeredReviewPlanV1;
    readonly manifest: ReviewSubjectManifestV1;
    readonly reviewerInputDigest: string;
  }): Promise<CandidateGateAttemptV1> {
    if (!validateCandidateGateAttempt(input.expected)
      || !validateCandidateBrokeredReviewPlan(input.reviewPlan)
      || !isDigest(input.reviewerInputDigest)) {
      invalidInput('Candidate reviewer start input is invalid.');
    }
    return this.withLiveCandidate(input, async ({ lease, seal, paths }) =>
      this.withLock(paths, async () => {
        const current = await this.requireAttempt(paths, input.expected);
        assertAttemptBinding(current, lease, seal);
        assertReviewManifestBinding(current, input.reviewPlan, input.manifest);
        if (current.stateDigest !== input.expected.stateDigest
          || current.casRevision !== input.expected.casRevision) {
          if (current.reviewSubjectManifestDigest
              === input.manifest.manifestDigest
            && current.reviewerInputDigest === input.reviewerInputDigest) {
            return current;
          }
          staleBinding('Candidate Gate attempt CAS binding is stale.');
        }
        if (current.state !== 'deterministic_completed') {
          if (current.reviewSubjectManifestDigest
              === input.manifest.manifestDigest
            && current.reviewerInputDigest === input.reviewerInputDigest) {
            return current;
          }
          invalidState('Candidate reviewer has already started.');
        }
        const next = beginCandidateGateReview(current, {
          reviewSubjectManifestDigest: input.manifest.manifestDigest,
          reviewerInputDigest: input.reviewerInputDigest,
          occurredAt: canonicalTimestamp(this.now(), current.updatedAt),
        });
        await this.persistTransition(paths, current, next, 'review_started');
        return next;
      }));
  }

  async complete(input: LiveInput & {
    readonly expected: CandidateGateAttemptV1;
    readonly outcome: CandidateGateOutcomeV1;
    readonly reasonCode: string;
    readonly reviewerPayloadDigest: string | null;
    readonly verdict: FreshCriteriaVerdictV1 | null;
    readonly reviewerVerdictStatus:
      CandidateReviewerVerdictStatusV1 | null;
  }): Promise<CandidateGateAttemptV1> {
    if (!validateCandidateGateAttempt(input.expected)
      || !isReasonCode(input.reasonCode)) {
      invalidInput('Candidate Gate completion input is invalid.');
    }
    return this.withLiveCandidate(input, async ({ lease, seal, paths }) =>
      this.withLock(paths, async () => {
        const current = await this.requireAttempt(paths, input.expected);
        assertAttemptBinding(current, lease, seal);
        const verdictDigest = input.verdict === null
          ? null
          : canonicalDigest(
              'wukong/fresh-criteria-verdict/v1',
              input.verdict,
            );
        if (input.verdict !== null
          && (input.verdict.attemptId !== current.candidateGateAttemptId
            || input.verdict.reviewerInputDigest
              !== current.reviewerInputDigest)) {
          staleBinding('Candidate reviewer verdict has a stale binding.');
        }
        if (current.stateDigest !== input.expected.stateDigest
          || current.casRevision !== input.expected.casRevision) {
          if (current.candidateGateResult?.candidateGateOutcome
              === input.outcome
            && current.reasonCode === input.reasonCode
            && current.reviewerPayloadDigest === input.reviewerPayloadDigest
            && current.freshCriteriaVerdictDigest === verdictDigest
            && current.reviewerVerdictStatus
              === input.reviewerVerdictStatus) {
            return current;
          }
          staleBinding('Candidate Gate attempt CAS binding is stale.');
        }
        if (current.state === 'completed') {
          if (current.candidateGateResult?.candidateGateOutcome
              === input.outcome
            && current.reasonCode === input.reasonCode
            && current.reviewerPayloadDigest === input.reviewerPayloadDigest
            && current.freshCriteriaVerdictDigest === verdictDigest
            && current.reviewerVerdictStatus
              === input.reviewerVerdictStatus) {
            return current;
          }
          invalidState('Candidate Gate attempt is already complete.');
        }
        const next = completeCandidateGateAttempt(current, {
          outcome: input.outcome,
          reasonCode: input.reasonCode,
          reviewerPayloadDigest: input.reviewerPayloadDigest,
          freshCriteriaVerdictDigest: verdictDigest,
          reviewerVerdictStatus: input.reviewerVerdictStatus,
          occurredAt: canonicalTimestamp(this.now(), current.updatedAt),
        });
        await this.persistTransition(paths, current, next, 'completed');
        return next;
      }));
  }

  async inspect(input: {
    readonly candidateId: string;
    readonly candidateGateAttemptId: string;
  }): Promise<CandidateGateAttemptV1> {
    if (!isUuid(input.candidateId)
      || !isUuid(input.candidateGateAttemptId)) {
      invalidInput('Candidate Gate attempt identity is invalid.');
    }
    let paths: AttemptPaths;
    try {
      paths = await this.preparePaths(
        input.candidateId,
        input.candidateGateAttemptId,
        undefined,
        false,
      );
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      throw new CandidateGateAttemptStoreError(
        'candidate_gate_attempt_not_found',
        'Candidate Gate attempt was not found.',
      );
    }
    return this.withLock(paths, async () => {
      const attempt = await this.loadOrRecover(paths);
      if (attempt === null) {
        throw new CandidateGateAttemptStoreError(
          'candidate_gate_attempt_not_found',
          'Candidate Gate attempt was not found.',
        );
      }
      return attempt;
    });
  }

  private async withLiveCandidate<Result>(
    input: LiveInput,
    callback: (value: {
      readonly lease: WorktreeLeaseV1;
      readonly seal: CandidateDeltaSealV1;
      readonly paths: AttemptPaths;
    }) => Promise<Result>,
  ): Promise<Result> {
    assertLiveInput(input);
    const seal = await input.candidateDeltaStore.sealDelta({
      worktreeLeaseStore: input.worktreeLeaseStore,
      rootCapability: input.rootCapability,
      bootstrapPlan: input.bootstrapPlan,
    });
    return input.worktreeLeaseStore.withCandidateRoot(
      input.rootCapability,
      async (view) => {
        const lease = await input.worktreeLeaseStore.inspect(
          input.rootCapability.candidateId,
        );
        if (lease.state !== 'verifying'
          || lease.casRevision !== seal.leaseCasRevision
          || lease.leaseDigest !== seal.verifyingLeaseDigest) {
          staleBinding('Candidate Gate attempt requires the exact verifying lease.');
        }
        const attemptId = 'candidateGateAttemptId' in input
          && typeof input.candidateGateAttemptId === 'string'
          ? input.candidateGateAttemptId
          : 'expected' in input
              && isRecord(input.expected)
              && typeof input.expected['candidateGateAttemptId'] === 'string'
            ? input.expected['candidateGateAttemptId']
            : null;
        if (attemptId === null) invalidInput('Candidate Gate attempt id is missing.');
        const paths = await this.preparePaths(
          lease.candidateId,
          attemptId,
          view.candidateDirectory,
        );
        return callback({ lease, seal, paths });
      },
    );
  }

  private async preparePaths(
    candidateId: string,
    attemptId: string,
    candidateDirectory?: string,
    create = true,
  ): Promise<AttemptPaths> {
    const [privateRoot, sourceRoot] = await Promise.all([
      realpath(this.privateRootDirectory),
      realpath(this.sourceRepositoryRoot),
    ]);
    await assertPrivateDirectory(privateRoot);
    if (isInside(sourceRoot, privateRoot)) {
      unsafeRoot('Candidate Gate artifacts cannot be stored in source.');
    }
    if (candidateDirectory !== undefined) {
      const candidateRoot = await realpath(candidateDirectory);
      if (isInside(candidateRoot, privateRoot)) {
        unsafeRoot('Candidate Gate artifacts cannot be stored in candidate.');
      }
    }
    const ownerDirectory = join(privateRoot, candidateId);
    if (create) {
      await ensurePrivateDirectory(ownerDirectory);
    } else {
      await assertPrivateDirectory(ownerDirectory);
    }
    const directory = join(ownerDirectory, ATTEMPTS_DIRECTORY);
    if (create) {
      await ensurePrivateDirectory(directory);
    } else {
      await assertPrivateDirectory(directory);
    }
    const eventsRoot = join(directory, EVENTS_DIRECTORY);
    if (create) {
      await ensurePrivateDirectory(eventsRoot);
    } else {
      await assertPrivateDirectory(eventsRoot);
    }
    const events = join(eventsRoot, attemptId);
    if (create) {
      await ensurePrivateDirectory(events);
    } else {
      await assertPrivateDirectory(events);
    }
    return {
      directory,
      state: join(directory, `${attemptId}.json`),
      events,
      lock: join(directory, LOCK_FILE),
    };
  }

  private async requireAttempt(
    paths: AttemptPaths,
    expected: CandidateGateAttemptV1,
  ): Promise<CandidateGateAttemptV1> {
    const current = await this.loadOrRecover(paths);
    if (current === null) {
      throw new CandidateGateAttemptStoreError(
        'candidate_gate_attempt_not_found',
        'Candidate Gate attempt was not found.',
      );
    }
    if (current.candidateGateAttemptId
      !== expected.candidateGateAttemptId) {
      staleBinding('Candidate Gate attempt identity is stale.');
    }
    return current;
  }

  private async persistTransition(
    paths: AttemptPaths,
    current: CandidateGateAttemptV1 | null,
    next: CandidateGateAttemptV1,
    eventType: CandidateGateAttemptEventV1['eventType'],
  ): Promise<void> {
    const eventCore = {
      schemaVersion: 1 as const,
      eventId: randomUUID(),
      candidateGateAttemptId: next.candidateGateAttemptId,
      sequence: next.casRevision,
      eventType,
      previousStateDigest: current?.stateDigest ?? null,
      nextState: next,
      occurredAt: next.updatedAt,
    };
    const event: CandidateGateAttemptEventV1 = {
      ...eventCore,
      eventDigest: canonicalDigest(
        'wukong/candidate-gate-attempt-event/v1',
        eventCore,
      ),
    };
    await writePrivateExclusive(
      join(paths.events, eventFilename(event.sequence)),
      canonicalJson(event),
    );
    await syncDirectory(paths.events);
    await writePrivateAtomic(paths.state, canonicalJson(next));
  }

  private async loadOrRecover(
    paths: AttemptPaths,
  ): Promise<CandidateGateAttemptV1 | null> {
    const state = await readAttemptOrNull(paths.state);
    const events = await readEvents(paths.events);
    if (events.length === 0) {
      if (state !== null) integrity('Candidate Gate state has no journal.');
      return null;
    }
    validateEventChain(events);
    const latest = events.at(-1)!.nextState;
    if (state === null) {
      await writePrivateAtomic(paths.state, canonicalJson(latest));
      return latest;
    }
    if (state.stateDigest === latest.stateDigest) return state;
    const latestEvent = events.at(-1)!;
    if (latestEvent.sequence === state.casRevision + 1
      && latestEvent.previousStateDigest === state.stateDigest) {
      await writePrivateAtomic(paths.state, canonicalJson(latest));
      return latest;
    }
    integrity('Candidate Gate state and journal diverged.');
  }

  private async withLock<Result>(
    paths: AttemptPaths,
    callback: () => Promise<Result>,
  ): Promise<Result> {
    try {
      await writePrivateExclusive(paths.lock, '');
      await syncDirectory(paths.directory);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    await readPrivateFile(paths.lock, 1);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(paths.lock, {
        realpath: true,
        retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      throw new CandidateGateAttemptStoreError(
        'candidate_gate_attempt_lock_failed',
        'Unable to lock Candidate Gate attempts.',
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

interface AttemptPaths {
  readonly directory: string;
  readonly state: string;
  readonly events: string;
  readonly lock: string;
}

function assertLiveInput(input: LiveInput): void {
  if (!(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.candidateDeltaStore instanceof CandidateDeltaStore)
    || !(input.rootCapability instanceof CandidateRootCapabilityV1)) {
    invalidInput('Candidate Gate live authority is invalid.');
  }
}

function assertAttemptBinding(
  attempt: CandidateGateAttemptV1,
  lease: WorktreeLeaseV1,
  seal: CandidateDeltaSealV1,
): void {
  if (attempt.candidateId !== lease.candidateId
    || attempt.leaseId !== lease.leaseId
    || attempt.leaseCasRevision !== lease.casRevision
    || attempt.verifyingLeaseDigest !== lease.leaseDigest
    || attempt.candidateDeltaDigest !== seal.delta.candidateDeltaDigest
    || attempt.candidateDeltaSealDigest !== seal.sealDigest
    || attempt.gatePlanDigest !== lease.gatePlanDigest) {
    staleBinding('Candidate Gate attempt binding is stale.');
  }
}

function assertDeterministicBinding(
  attempt: CandidateGateAttemptV1,
  gate: CandidateDeterministicGateResultV1,
  reviewPlan: CandidateBrokeredReviewPlanV1 | null,
): void {
  if (gate.candidateId !== attempt.candidateId
    || gate.leaseId !== attempt.leaseId
    || gate.candidateDeltaDigest !== attempt.candidateDeltaDigest
    || gate.candidateDeltaSealDigest !== attempt.candidateDeltaSealDigest
    || gate.gatePlanDigest !== attempt.gatePlanDigest
    || (gate.status === 'passed') !== (reviewPlan !== null)
    || (reviewPlan !== null
      && (reviewPlan.candidateId !== attempt.candidateId
        || reviewPlan.leaseId !== attempt.leaseId
        || reviewPlan.candidateDeltaDigest !== attempt.candidateDeltaDigest
        || reviewPlan.candidateDeltaSealDigest
          !== attempt.candidateDeltaSealDigest))) {
    staleBinding('Candidate deterministic Gate result is stale.');
  }
}

function assertReviewManifestBinding(
  attempt: CandidateGateAttemptV1,
  reviewPlan: CandidateBrokeredReviewPlanV1,
  manifest: ReviewSubjectManifestV1,
): void {
  if (attempt.reviewPlanDigest !== reviewPlan.reviewPlanDigest
    || manifest.attemptId !== attempt.candidateGateAttemptId
    || manifest.workspaceFingerprint !== reviewPlan.workspaceFingerprint) {
    staleBinding('Candidate reviewer manifest binding is stale.');
  }
}

async function readAttemptOrNull(
  path: string,
): Promise<CandidateGateAttemptV1 | null> {
  const value = await readJsonOrNull(path);
  if (value === null) return null;
  if (!validateCandidateGateAttempt(value)) {
    integrity('Candidate Gate attempt record is invalid.');
  }
  return value;
}

async function readEvents(
  directory: string,
): Promise<readonly CandidateGateAttemptEventV1[]> {
  const names = (await readdir(directory))
    .filter((name) => EVENT_FILE_PATTERN.test(name))
    .toSorted();
  const events: CandidateGateAttemptEventV1[] = [];
  for (const name of names) {
    const value = await readJsonOrNull(join(directory, name));
    if (!validateEvent(value)) {
      integrity('Candidate Gate attempt event is invalid.');
    }
    events.push(value);
  }
  return events;
}

function validateEvent(value: unknown): value is CandidateGateAttemptEventV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'candidateGateAttemptId',
      'eventDigest',
      'eventId',
      'eventType',
      'nextState',
      'occurredAt',
      'previousStateDigest',
      'schemaVersion',
      'sequence',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['eventId'])
    || !isUuid(value['candidateGateAttemptId'])
    || !isNonNegativeInteger(value['sequence'])
    || (value['eventType'] !== 'prepared'
      && value['eventType'] !== 'deterministic_completed'
      && value['eventType'] !== 'review_started'
      && value['eventType'] !== 'completed')
    || (value['previousStateDigest'] !== null
      && !isDigest(value['previousStateDigest']))
    || !validateCandidateGateAttempt(value['nextState'])
    || !isCanonicalTimestamp(value['occurredAt'])
    || !isDigest(value['eventDigest'])) {
    return false;
  }
  const event = value as unknown as CandidateGateAttemptEventV1;
  const { eventDigest, ...core } = event;
  return event.nextState.candidateGateAttemptId
      === event.candidateGateAttemptId
    && event.nextState.casRevision === event.sequence
    && event.nextState.updatedAt === event.occurredAt
    && canonicalDigest('wukong/candidate-gate-attempt-event/v1', core)
      === eventDigest;
}

function validateEventChain(
  events: readonly CandidateGateAttemptEventV1[],
): void {
  for (const [index, event] of events.entries()) {
    const prior = events[index - 1];
    if (event.sequence !== index
      || event.eventType !== expectedEventType(event.nextState.state)
      || event.previousStateDigest !== (prior?.nextState.stateDigest ?? null)) {
      integrity('Candidate Gate attempt event chain is invalid.');
    }
  }
}

function expectedEventType(
  state: CandidateGateAttemptV1['state'],
): CandidateGateAttemptEventV1['eventType'] {
  if (state === 'prepared') return 'prepared';
  if (state === 'deterministic_completed') return 'deterministic_completed';
  if (state === 'reviewing') return 'review_started';
  return 'completed';
}

async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(
      (await readPrivateFile(path, MAX_RECORD_BYTES)).toString('utf8'),
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    if (error instanceof SyntaxError) {
      integrity('Candidate Gate private record is not valid JSON.');
    }
    throw error;
  }
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const linked = await lstat(path);
  if (!linked.isFile()
    || linked.isSymbolicLink()
    || linked.nlink !== 1
    || linked.size > maxBytes
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== PRIVATE_FILE_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))) {
    integrity('Candidate Gate private file is unsafe.');
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY
      | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
  );
  try {
    const before = await handle.stat();
    if (!sameFile(before, linked)) {
      integrity('Candidate Gate private file changed before reading.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.length > maxBytes) {
      integrity('Candidate Gate private file changed while reading.');
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
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
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
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${path.slice(directory.length + 1)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  await writePrivateExclusive(temporary, content);
  await rename(temporary, path);
  await syncDirectory(directory);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  if (process.platform === 'win32' && created) {
    protectWindowsPrivateRootSecurity(path);
  }
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const [actual, linked] = await Promise.all([stat(path), lstat(path)]);
  if (!actual.isDirectory()
    || !linked.isDirectory()
    || linked.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))) {
    unsafeRoot('Candidate Gate state directory is not private.');
  }
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch {
      unsafeRoot(
        'Candidate Gate state directory has an unsafe Windows ACL.',
      );
    }
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

function eventFilename(sequence: number): string {
  if (!isNonNegativeInteger(sequence) || sequence > 999_999_999_999) {
    invalidInput('Candidate Gate event sequence is invalid.');
  }
  return `${String(sequence).padStart(12, '0')}.json`;
}

function canonicalTimestamp(now: Date, minimum?: string): string {
  if (!Number.isFinite(now.getTime())) invalidInput('Current time is invalid.');
  const time = minimum === undefined
    ? now.getTime()
    : Math.max(now.getTime(), Date.parse(minimum));
  return new Date(time).toISOString();
}

function sameFile(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    && !containsSensitiveText(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function invalidInput(message: string): never {
  throw new CandidateGateAttemptStoreError(
    'candidate_gate_attempt_invalid_input',
    message,
  );
}

function staleBinding(message: string): never {
  throw new CandidateGateAttemptStoreError(
    'candidate_gate_attempt_stale_binding',
    message,
  );
}

function invalidState(message: string): never {
  throw new CandidateGateAttemptStoreError(
    'candidate_gate_attempt_invalid_state',
    message,
  );
}

function integrity(message: string): never {
  throw new CandidateGateAttemptStoreError(
    'candidate_gate_attempt_integrity_failed',
    message,
  );
}

function unsafeRoot(message: string): never {
  throw new CandidateGateAttemptStoreError(
    'candidate_gate_attempt_root_unsafe',
    message,
  );
}
