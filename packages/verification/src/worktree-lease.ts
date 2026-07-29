import { canonicalDigest } from './finish-line';
import { containsSensitiveText } from './redaction';

export type WorktreeLeaseStateV1 =
  | 'creating'
  | 'materializing'
  | 'bootstrapping'
  | 'active'
  | 'verifying'
  | 'awaiting_promotion'
  | 'promoting'
  | 'promoted'
  | 'retained'
  | 'released';

export type WorktreeLeaseEventTypeV1 =
  | 'reserved'
  | 'materialization_started'
  | 'materialization_completed'
  | 'activated'
  | 'verification_started'
  | 'verification_needs_work'
  | 'promotion_awaited'
  | 'promotion_started'
  | 'promoted'
  | 'retained'
  | 'released'
  | 'ownership_adopted';

export interface WorktreeLeaseV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly goalId: string;
  readonly contractId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly snapshotBlobLeaseId: string;
  readonly snapshotBlobLeaseDigest: string;
  readonly manifestDigest: string;
  readonly materializationPolicyDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string | null;
  readonly repositoryIdentity: string;
  readonly baseCommit: string;
  readonly repositoryRelativeCwd: string;
  readonly worktreeIdentity: string | null;
  readonly materializedSourceDigest: string | null;
  readonly candidateBranch: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly state: WorktreeLeaseStateV1;
  readonly casRevision: number;
  readonly fencingTokenDigest: string;
  readonly journalHeadDigest: string;
  readonly leaseDigest: string;
}

export interface WorktreeLeaseEventV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly sequence: number;
  readonly eventType: WorktreeLeaseEventTypeV1;
  readonly fromState: WorktreeLeaseStateV1 | null;
  readonly toState: WorktreeLeaseStateV1;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest: string;
  readonly previousOwnerProcessIdentityDigest: string | null;
  readonly fencingTokenDigest: string;
  readonly previousFencingTokenDigest: string | null;
  readonly previousLeaseDigest: string | null;
  readonly previousEventDigest: string | null;
  readonly worktreeIdentity: string | null;
  readonly materializedSourceDigest: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
  readonly eventDigest: string;
}

export interface CreateWorktreeLeaseInputV1 {
  readonly leaseId: string;
  readonly candidateId: string;
  readonly goalId: string;
  readonly contractId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly snapshotBlobLeaseId: string;
  readonly snapshotBlobLeaseDigest: string;
  readonly manifestDigest: string;
  readonly materializationPolicyDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string | null;
  readonly repositoryIdentity: string;
  readonly baseCommit: string;
  readonly repositoryRelativeCwd: string;
  readonly candidateBranch: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fencingTokenDigest: string;
}

export interface TransitionWorktreeLeaseInputV1 {
  readonly toState: Exclude<WorktreeLeaseStateV1, 'creating'>;
  readonly occurredAt: string;
  readonly worktreeIdentity?: string;
  readonly materializedSourceDigest?: string;
  readonly reasonCode?: string | null;
}

export interface AdoptWorktreeLeaseInputV1 {
  readonly newRunId: string;
  readonly newOwnerRunId: string;
  readonly newOwnerProcessIdentityDigest: string;
  readonly newFencingTokenDigest: string;
  readonly occurredAt: string;
  readonly reasonCode: string;
}

export interface WorktreeLeaseTransitionV1 {
  readonly lease: WorktreeLeaseV1;
  readonly event: WorktreeLeaseEventV1;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CANDIDATE_BRANCH = /^wukong\/candidate\/[0-9a-f-]{36}$/u;

const ALLOWED_TRANSITIONS = {
  creating: ['materializing', 'retained', 'released'],
  materializing: ['bootstrapping', 'active', 'retained'],
  bootstrapping: ['active', 'retained'],
  active: ['verifying', 'retained', 'released'],
  verifying: ['active', 'awaiting_promotion', 'retained'],
  awaiting_promotion: ['active', 'promoting', 'retained', 'released'],
  promoting: ['promoted', 'retained'],
  promoted: ['released'],
  retained: [],
  released: [],
} as const satisfies Record<WorktreeLeaseStateV1, readonly WorktreeLeaseStateV1[]>;

const EVENT_BY_TRANSITION: Record<string, WorktreeLeaseEventTypeV1> = {
  'creating:materializing': 'materialization_started',
  'creating:retained': 'retained',
  'creating:released': 'released',
  'materializing:bootstrapping': 'materialization_completed',
  'materializing:active': 'activated',
  'materializing:retained': 'retained',
  'bootstrapping:active': 'activated',
  'bootstrapping:retained': 'retained',
  'active:verifying': 'verification_started',
  'active:retained': 'retained',
  'active:released': 'released',
  'verifying:active': 'verification_needs_work',
  'verifying:awaiting_promotion': 'promotion_awaited',
  'verifying:retained': 'retained',
  'awaiting_promotion:active': 'verification_needs_work',
  'awaiting_promotion:promoting': 'promotion_started',
  'awaiting_promotion:retained': 'retained',
  'awaiting_promotion:released': 'released',
  'promoting:promoted': 'promoted',
  'promoting:retained': 'retained',
  'promoted:released': 'released',
};

export function createWorktreeLease(
  input: CreateWorktreeLeaseInputV1,
): WorktreeLeaseTransitionV1 {
  assertCreateInput(input);
  const eventCore = {
    schemaVersion: 1 as const,
    leaseId: input.leaseId,
    candidateId: input.candidateId,
    sequence: 0,
    eventType: 'reserved' as const,
    fromState: null,
    toState: 'creating' as const,
    runId: input.runId,
    ownerRunId: input.ownerRunId,
    ownerProcessIdentityDigest:
      input.ownerProcessIdentityDigest,
    previousOwnerProcessIdentityDigest: null,
    fencingTokenDigest: input.fencingTokenDigest,
    previousFencingTokenDigest: null,
    previousLeaseDigest: null,
    previousEventDigest: null,
    worktreeIdentity: null,
    materializedSourceDigest: null,
    occurredAt: input.createdAt,
    reasonCode: null,
  };
  const event: WorktreeLeaseEventV1 = {
    ...eventCore,
    eventDigest: canonicalDigest('wukong/worktree-lease-event/v1', eventCore),
  };
  const leaseCore = {
    schemaVersion: 1 as const,
    leaseId: input.leaseId,
    candidateId: input.candidateId,
    goalId: input.goalId,
    contractId: input.contractId,
    runId: input.runId,
    ownerRunId: input.ownerRunId,
    ownerProcessIdentityDigest:
      input.ownerProcessIdentityDigest,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    snapshotBlobLeaseId: input.snapshotBlobLeaseId,
    snapshotBlobLeaseDigest: input.snapshotBlobLeaseDigest,
    manifestDigest: input.manifestDigest,
    materializationPolicyDigest: input.materializationPolicyDigest,
    bootstrapPlanDigest: input.bootstrapPlanDigest,
    gatePlanDigest: input.gatePlanDigest,
    criteriaSelectionDigest: input.criteriaSelectionDigest,
    repositoryIdentity: input.repositoryIdentity,
    baseCommit: input.baseCommit,
    repositoryRelativeCwd: input.repositoryRelativeCwd,
    worktreeIdentity: null,
    materializedSourceDigest: null,
    candidateBranch: input.candidateBranch,
    createdByRunId: input.createdByRunId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    expiresAt: input.expiresAt,
    state: 'creating' as const,
    casRevision: 0,
    fencingTokenDigest: input.fencingTokenDigest,
    journalHeadDigest: event.eventDigest,
  };
  const lease: WorktreeLeaseV1 = {
    ...leaseCore,
    leaseDigest: canonicalDigest('wukong/worktree-lease/v1', leaseCore),
  };
  if (!validateWorktreeLease(lease)
    || !validateInitialWorktreeLease(lease, event)) {
    throw new Error('Unable to create a valid worktree lease.');
  }
  return { lease, event };
}

export function transitionWorktreeLease(
  current: WorktreeLeaseV1,
  input: TransitionWorktreeLeaseInputV1,
): WorktreeLeaseTransitionV1 {
  if (!validateWorktreeLease(current)) {
    throw new Error('The current worktree lease is invalid.');
  }
  if (!ALLOWED_TRANSITIONS[current.state].includes(input.toState as never)) {
    throw new Error(`Invalid worktree lease transition: ${current.state} -> ${input.toState}.`);
  }
  assertTransitionTime(current, input.occurredAt);
  if ((current.state === 'creating' || current.state === 'materializing')
    && Date.parse(input.occurredAt) >= Date.parse(current.expiresAt)
    && input.toState !== 'retained') {
    throw new Error('The worktree lease expired before the requested transition.');
  }
  const completingMaterialization = current.state === 'materializing'
    && (input.toState === 'bootstrapping' || input.toState === 'active');
  if (completingMaterialization !== (
    isDigest(input.worktreeIdentity)
    && isDigest(input.materializedSourceDigest)
  )) {
    throw new Error('The worktree materialization completion binding is invalid.');
  }
  const reasonCode = input.reasonCode ?? null;
  const reasonPolicy = transitionReasonPolicy(current.state, input.toState);
  if ((reasonPolicy === 'required' && reasonCode === null)
    || (reasonPolicy === 'forbidden' && reasonCode !== null)
    || (reasonCode !== null && !isReasonCode(reasonCode))) {
    throw new Error('The worktree lease transition reason is invalid.');
  }
  const eventType = EVENT_BY_TRANSITION[`${current.state}:${input.toState}`];
  if (eventType === undefined) throw new Error('The worktree lease event type is invalid.');
  const eventCore = {
    schemaVersion: 1 as const,
    leaseId: current.leaseId,
    candidateId: current.candidateId,
    sequence: current.casRevision + 1,
    eventType,
    fromState: current.state,
    toState: input.toState,
    runId: current.runId,
    ownerRunId: current.ownerRunId,
    ownerProcessIdentityDigest:
      current.ownerProcessIdentityDigest,
    previousOwnerProcessIdentityDigest: null,
    fencingTokenDigest: current.fencingTokenDigest,
    previousFencingTokenDigest: null,
    previousLeaseDigest: current.leaseDigest,
    previousEventDigest: current.journalHeadDigest,
    worktreeIdentity: completingMaterialization
      ? input.worktreeIdentity ?? null
      : null,
    materializedSourceDigest: completingMaterialization
      ? input.materializedSourceDigest ?? null
      : null,
    occurredAt: input.occurredAt,
    reasonCode,
  };
  const event = sealEvent(eventCore);
  const leaseCore = {
    ...withoutLeaseDigest(current),
    worktreeIdentity: input.worktreeIdentity ?? current.worktreeIdentity,
    materializedSourceDigest:
      input.materializedSourceDigest ?? current.materializedSourceDigest,
    updatedAt: input.occurredAt,
    state: input.toState,
    casRevision: event.sequence,
    journalHeadDigest: event.eventDigest,
  };
  const lease = sealLease(leaseCore);
  if (!validateWorktreeLeaseTransition(current, event, lease)) {
    throw new Error('Unable to create a valid worktree lease transition.');
  }
  return { lease, event };
}

export function adoptWorktreeLease(
  current: WorktreeLeaseV1,
  input: AdoptWorktreeLeaseInputV1,
): WorktreeLeaseTransitionV1 {
  if (!validateWorktreeLease(current)
    || current.state === 'promoting'
    || current.state === 'promoted'
    || current.state === 'retained'
    || current.state === 'released'
    || !isOpaqueId(input.newRunId)
    || !isOpaqueId(input.newOwnerRunId)
    || !isDigest(input.newOwnerProcessIdentityDigest)
    || input.newOwnerProcessIdentityDigest
      === current.ownerProcessIdentityDigest
    || !isDigest(input.newFencingTokenDigest)
    || input.newFencingTokenDigest === current.fencingTokenDigest
    || !isReasonCode(input.reasonCode)) {
    throw new Error('The worktree lease adoption input is invalid.');
  }
  assertTransitionTime(current, input.occurredAt);
  const eventCore = {
    schemaVersion: 1 as const,
    leaseId: current.leaseId,
    candidateId: current.candidateId,
    sequence: current.casRevision + 1,
    eventType: 'ownership_adopted' as const,
    fromState: current.state,
    toState: current.state,
    runId: input.newRunId,
    ownerRunId: input.newOwnerRunId,
    ownerProcessIdentityDigest:
      input.newOwnerProcessIdentityDigest,
    previousOwnerProcessIdentityDigest:
      current.ownerProcessIdentityDigest,
    fencingTokenDigest: input.newFencingTokenDigest,
    previousFencingTokenDigest: current.fencingTokenDigest,
    previousLeaseDigest: current.leaseDigest,
    previousEventDigest: current.journalHeadDigest,
    worktreeIdentity: null,
    materializedSourceDigest: null,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
  };
  const event = sealEvent(eventCore);
  const leaseCore = {
    ...withoutLeaseDigest(current),
    runId: input.newRunId,
    ownerRunId: input.newOwnerRunId,
    ownerProcessIdentityDigest:
      input.newOwnerProcessIdentityDigest,
    updatedAt: input.occurredAt,
    casRevision: event.sequence,
    fencingTokenDigest: input.newFencingTokenDigest,
    journalHeadDigest: event.eventDigest,
  };
  const lease = sealLease(leaseCore);
  if (!validateWorktreeLeaseTransition(current, event, lease)) {
    throw new Error('Unable to adopt the worktree lease.');
  }
  return { lease, event };
}

export function validateWorktreeLease(value: unknown): value is WorktreeLeaseV1 {
  if (!isRecord(value) || !hasExactKeys(value, LEASE_KEYS)) return false;
  const lease = value as unknown as WorktreeLeaseV1;
  if (lease.schemaVersion !== 1
    || !UUID.test(lease.leaseId)
    || !UUID.test(lease.candidateId)
    || !isOpaqueId(lease.goalId)
    || !isOpaqueId(lease.contractId)
    || !isOpaqueId(lease.runId)
    || !isOpaqueId(lease.ownerRunId)
    || !isDigest(lease.ownerProcessIdentityDigest)
    || !isDigest(lease.sourceSnapshotDigest)
    || !UUID.test(lease.snapshotBlobLeaseId)
    || !isDigest(lease.snapshotBlobLeaseDigest)
    || !isDigest(lease.manifestDigest)
    || !isDigest(lease.materializationPolicyDigest)
    || !isDigest(lease.bootstrapPlanDigest)
    || !isDigest(lease.gatePlanDigest)
    || (lease.criteriaSelectionDigest !== null
      && !isDigest(lease.criteriaSelectionDigest))
    || !isDigest(lease.repositoryIdentity)
    || !GIT_OBJECT_ID.test(lease.baseCommit)
    || !isRepositoryRelativeCwd(lease.repositoryRelativeCwd)
    || (lease.worktreeIdentity !== null && !isDigest(lease.worktreeIdentity))
    || (lease.materializedSourceDigest !== null
      && !isDigest(lease.materializedSourceDigest))
    || !CANDIDATE_BRANCH.test(lease.candidateBranch)
    || !isOpaqueId(lease.createdByRunId)
    || !isCanonicalTimestamp(lease.createdAt)
    || !isCanonicalTimestamp(lease.updatedAt)
    || !isCanonicalTimestamp(lease.expiresAt)
    || Date.parse(lease.createdAt) > Date.parse(lease.updatedAt)
    || Date.parse(lease.createdAt) >= Date.parse(lease.expiresAt)
    || !isState(lease.state)
    || !Number.isSafeInteger(lease.casRevision)
    || lease.casRevision < 0
    || !isDigest(lease.fencingTokenDigest)
    || !isDigest(lease.journalHeadDigest)
    || !isDigest(lease.leaseDigest)) return false;
  const materialized = lease.worktreeIdentity !== null
    && lease.materializedSourceDigest !== null;
  if ((lease.worktreeIdentity === null)
      !== (lease.materializedSourceDigest === null)
    || ((lease.state === 'creating' || lease.state === 'materializing')
      ? materialized
      : !materialized)) return false;
  const { leaseDigest, ...core } = lease;
  return canonicalDigest('wukong/worktree-lease/v1', core) === leaseDigest;
}

export function validateWorktreeLeaseEvent(
  value: unknown,
): value is WorktreeLeaseEventV1 {
  if (!isRecord(value) || !hasExactKeys(value, EVENT_KEYS)) return false;
  const event = value as unknown as WorktreeLeaseEventV1;
  if (event.schemaVersion !== 1
    || !UUID.test(event.leaseId)
    || !UUID.test(event.candidateId)
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 0
    || !isEventType(event.eventType)
    || !isNullableState(event.fromState)
    || !isState(event.toState)
    || !isOpaqueId(event.runId)
    || !isOpaqueId(event.ownerRunId)
    || !isDigest(event.ownerProcessIdentityDigest)
    || (event.previousOwnerProcessIdentityDigest !== null
      && !isDigest(event.previousOwnerProcessIdentityDigest))
    || !isDigest(event.fencingTokenDigest)
    || (event.previousFencingTokenDigest !== null
      && !isDigest(event.previousFencingTokenDigest))
    || (event.previousLeaseDigest !== null && !isDigest(event.previousLeaseDigest))
    || (event.previousEventDigest !== null && !isDigest(event.previousEventDigest))
    || (event.worktreeIdentity !== null && !isDigest(event.worktreeIdentity))
    || (event.materializedSourceDigest !== null
      && !isDigest(event.materializedSourceDigest))
    || !isCanonicalTimestamp(event.occurredAt)
    || (event.reasonCode !== null && !isReasonCode(event.reasonCode))
    || !isDigest(event.eventDigest)) return false;
  if (event.sequence === 0) {
    if (event.eventType !== 'reserved'
      || event.fromState !== null
      || event.toState !== 'creating'
      || event.previousOwnerProcessIdentityDigest !== null
      || event.previousFencingTokenDigest !== null
      || event.previousLeaseDigest !== null
      || event.previousEventDigest !== null
      || event.worktreeIdentity !== null
      || event.materializedSourceDigest !== null
      || event.reasonCode !== null) return false;
  } else if (event.eventType === 'ownership_adopted') {
    if (event.fromState === null
      || event.fromState !== event.toState
      || event.previousFencingTokenDigest === null
      || event.previousFencingTokenDigest === event.fencingTokenDigest
      || event.previousOwnerProcessIdentityDigest === null
      || event.previousOwnerProcessIdentityDigest
        === event.ownerProcessIdentityDigest
      || event.worktreeIdentity !== null
      || event.materializedSourceDigest !== null
      || event.reasonCode === null) return false;
  } else if (event.fromState === null
    || EVENT_BY_TRANSITION[`${event.fromState}:${event.toState}`]
      !== event.eventType
    || event.previousOwnerProcessIdentityDigest !== null
    || event.previousFencingTokenDigest !== null
    || (transitionReasonPolicy(event.fromState, event.toState) === 'required'
      && event.reasonCode === null)
    || (transitionReasonPolicy(event.fromState, event.toState) === 'forbidden'
      && event.reasonCode !== null)) return false;
  const completesMaterialization = event.fromState === 'materializing'
    && (event.toState === 'bootstrapping' || event.toState === 'active');
  if (completesMaterialization !== (
    event.worktreeIdentity !== null
    && event.materializedSourceDigest !== null
  )) return false;
  const { eventDigest, ...core } = event;
  return canonicalDigest('wukong/worktree-lease-event/v1', core) === eventDigest;
}

export function validateInitialWorktreeLease(
  lease: WorktreeLeaseV1,
  event: WorktreeLeaseEventV1,
): boolean {
  return validateWorktreeLease(lease)
    && validateWorktreeLeaseEvent(event)
    && lease.state === 'creating'
    && lease.casRevision === 0
    && lease.journalHeadDigest === event.eventDigest
    && lease.createdAt === event.occurredAt
    && lease.leaseId === event.leaseId
    && lease.candidateId === event.candidateId
    && lease.runId === event.runId
    && lease.ownerRunId === event.ownerRunId
    && lease.ownerProcessIdentityDigest
      === event.ownerProcessIdentityDigest
    && lease.fencingTokenDigest === event.fencingTokenDigest;
}

export function validateWorktreeLeaseTransition(
  previous: WorktreeLeaseV1,
  event: WorktreeLeaseEventV1,
  next: WorktreeLeaseV1,
): boolean {
  if (!validateWorktreeLease(previous)
    || !validateWorktreeLeaseEvent(event)
    || !validateWorktreeLease(next)
    || event.sequence !== previous.casRevision + 1
    || next.casRevision !== event.sequence
    || event.leaseId !== previous.leaseId
    || event.candidateId !== previous.candidateId
    || next.leaseId !== previous.leaseId
    || next.candidateId !== previous.candidateId
    || event.fromState !== previous.state
    || event.toState !== next.state
    || event.previousLeaseDigest !== previous.leaseDigest
    || event.previousEventDigest !== previous.journalHeadDigest
    || next.journalHeadDigest !== event.eventDigest
    || next.updatedAt !== event.occurredAt
    || immutableLeaseBinding(previous) !== immutableLeaseBinding(next)) return false;
  const adoption = event.eventType === 'ownership_adopted';
  if (adoption) {
    return event.fromState === event.toState
      && event.previousFencingTokenDigest === previous.fencingTokenDigest
      && next.fencingTokenDigest === event.fencingTokenDigest
      && next.runId === event.runId
      && next.ownerRunId === event.ownerRunId
      && event.previousOwnerProcessIdentityDigest
        === previous.ownerProcessIdentityDigest
      && next.ownerProcessIdentityDigest
        === event.ownerProcessIdentityDigest
      && next.worktreeIdentity === previous.worktreeIdentity
      && next.materializedSourceDigest === previous.materializedSourceDigest;
  }
  const completingMaterialization = previous.state === 'materializing'
    && (next.state === 'bootstrapping' || next.state === 'active');
  if (completingMaterialization
    ? previous.worktreeIdentity !== null
      || previous.materializedSourceDigest !== null
      || next.worktreeIdentity === null
      || next.materializedSourceDigest === null
      || event.worktreeIdentity !== next.worktreeIdentity
      || event.materializedSourceDigest !== next.materializedSourceDigest
    : next.worktreeIdentity !== previous.worktreeIdentity
      || next.materializedSourceDigest !== previous.materializedSourceDigest
      || event.worktreeIdentity !== null
      || event.materializedSourceDigest !== null) {
    return false;
  }
  return event.runId === previous.runId
    && event.ownerRunId === previous.ownerRunId
    && event.ownerProcessIdentityDigest
      === previous.ownerProcessIdentityDigest
    && event.previousOwnerProcessIdentityDigest === null
    && event.fencingTokenDigest === previous.fencingTokenDigest
    && next.runId === previous.runId
    && next.ownerRunId === previous.ownerRunId
    && next.ownerProcessIdentityDigest
      === previous.ownerProcessIdentityDigest
    && next.fencingTokenDigest === previous.fencingTokenDigest;
}

function immutableLeaseBinding(lease: WorktreeLeaseV1): string {
  return canonicalDigest('wukong/worktree-lease-immutable-binding/v1', {
    schemaVersion: lease.schemaVersion,
    leaseId: lease.leaseId,
    candidateId: lease.candidateId,
    goalId: lease.goalId,
    contractId: lease.contractId,
    sourceSnapshotDigest: lease.sourceSnapshotDigest,
    snapshotBlobLeaseId: lease.snapshotBlobLeaseId,
    snapshotBlobLeaseDigest: lease.snapshotBlobLeaseDigest,
    manifestDigest: lease.manifestDigest,
    materializationPolicyDigest: lease.materializationPolicyDigest,
    bootstrapPlanDigest: lease.bootstrapPlanDigest,
    gatePlanDigest: lease.gatePlanDigest,
    criteriaSelectionDigest: lease.criteriaSelectionDigest,
    repositoryIdentity: lease.repositoryIdentity,
    baseCommit: lease.baseCommit,
    repositoryRelativeCwd: lease.repositoryRelativeCwd,
    candidateBranch: lease.candidateBranch,
    createdByRunId: lease.createdByRunId,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
  });
}

const LEASE_KEYS = [
  'schemaVersion', 'leaseId', 'candidateId', 'goalId', 'contractId', 'runId',
  'ownerRunId', 'ownerProcessIdentityDigest', 'sourceSnapshotDigest',
  'snapshotBlobLeaseId',
  'snapshotBlobLeaseDigest', 'manifestDigest', 'materializationPolicyDigest',
  'bootstrapPlanDigest', 'gatePlanDigest', 'criteriaSelectionDigest',
  'repositoryIdentity', 'baseCommit', 'repositoryRelativeCwd',
  'worktreeIdentity', 'materializedSourceDigest', 'candidateBranch',
  'createdByRunId', 'createdAt', 'updatedAt', 'expiresAt', 'state',
  'casRevision', 'fencingTokenDigest', 'journalHeadDigest', 'leaseDigest',
] as const;

const EVENT_KEYS = [
  'schemaVersion', 'leaseId', 'candidateId', 'sequence', 'eventType',
  'fromState', 'toState', 'runId', 'ownerRunId',
  'ownerProcessIdentityDigest', 'previousOwnerProcessIdentityDigest',
  'fencingTokenDigest',
  'previousFencingTokenDigest', 'previousLeaseDigest', 'previousEventDigest',
  'worktreeIdentity', 'materializedSourceDigest', 'occurredAt', 'reasonCode',
  'eventDigest',
] as const;

function sealEvent(
  core: Omit<WorktreeLeaseEventV1, 'eventDigest'>,
): WorktreeLeaseEventV1 {
  return {
    ...core,
    eventDigest: canonicalDigest('wukong/worktree-lease-event/v1', core),
  };
}

function sealLease(
  core: Omit<WorktreeLeaseV1, 'leaseDigest'>,
): WorktreeLeaseV1 {
  return {
    ...core,
    leaseDigest: canonicalDigest('wukong/worktree-lease/v1', core),
  };
}

function withoutLeaseDigest(
  lease: WorktreeLeaseV1,
): Omit<WorktreeLeaseV1, 'leaseDigest'> {
  const { leaseDigest: _, ...core } = lease;
  return core;
}

function assertCreateInput(input: CreateWorktreeLeaseInputV1): void {
  if (!isRecord(input)
    || !UUID.test(input.leaseId)
    || !UUID.test(input.candidateId)
    || !isOpaqueId(input.goalId)
    || !isOpaqueId(input.contractId)
    || !isOpaqueId(input.runId)
    || !isOpaqueId(input.ownerRunId)
    || !isDigest(input.ownerProcessIdentityDigest)
    || !isDigest(input.sourceSnapshotDigest)
    || !UUID.test(input.snapshotBlobLeaseId)
    || !isDigest(input.snapshotBlobLeaseDigest)
    || !isDigest(input.manifestDigest)
    || !isDigest(input.materializationPolicyDigest)
    || !isDigest(input.bootstrapPlanDigest)
    || !isDigest(input.gatePlanDigest)
    || (input.criteriaSelectionDigest !== null
      && !isDigest(input.criteriaSelectionDigest))
    || !isDigest(input.repositoryIdentity)
    || !GIT_OBJECT_ID.test(input.baseCommit)
    || !isRepositoryRelativeCwd(input.repositoryRelativeCwd)
    || !CANDIDATE_BRANCH.test(input.candidateBranch)
    || !isOpaqueId(input.createdByRunId)
    || !isCanonicalTimestamp(input.createdAt)
    || !isCanonicalTimestamp(input.expiresAt)
    || Date.parse(input.createdAt) >= Date.parse(input.expiresAt)
    || !isDigest(input.fencingTokenDigest)) {
    throw new TypeError('The worktree lease create input is invalid.');
  }
}

function assertTransitionTime(current: WorktreeLeaseV1, occurredAt: string): void {
  if (!isCanonicalTimestamp(occurredAt)
    || Date.parse(occurredAt) < Date.parse(current.updatedAt)) {
    throw new Error('The worktree lease transition time is invalid.');
  }
}

function transitionReasonPolicy(
  fromState: WorktreeLeaseStateV1 | null,
  toState: WorktreeLeaseStateV1,
): 'required' | 'optional' | 'forbidden' {
  if (toState === 'retained' || toState === 'released') return 'required';
  if (fromState === 'verifying'
    && (toState === 'active' || toState === 'awaiting_promotion')) {
    return 'optional';
  }
  return 'forbidden';
}

function isState(value: unknown): value is WorktreeLeaseStateV1 {
  return typeof value === 'string' && value in ALLOWED_TRANSITIONS;
}

function isNullableState(value: unknown): value is WorktreeLeaseStateV1 | null {
  return value === null || isState(value);
}

function isEventType(value: unknown): value is WorktreeLeaseEventTypeV1 {
  return typeof value === 'string'
    && (value === 'reserved'
      || value === 'ownership_adopted'
      || Object.values(EVENT_BY_TRANSITION).includes(value as WorktreeLeaseEventTypeV1));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isReasonCode(value: unknown): value is string {
  return typeof value === 'string'
    && REASON.test(value)
    && !containsSensitiveText(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRepositoryRelativeCwd(value: unknown): value is string {
  if (value === '.') return true;
  if (typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')) return false;
  return value.split('/').every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
