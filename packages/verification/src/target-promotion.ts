import { canonicalDigest } from './finish-line';

export const TARGET_FINGERPRINT_POLICY_VERSION =
  'wukong-target-fingerprint-v1';

export interface TargetStateFingerprintV1 {
  readonly schemaVersion: 1;
  readonly targetWorkspaceIdentity: string;
  readonly targetGitCommonDirIdentity: string;
  readonly headOid: string;
  readonly branchRef: string | null;
  readonly branchRefDigest: string | null;
  readonly indexDigest: string;
  readonly trackedWorkingDeltaDigest: string | null;
  readonly untrackedProjectionDigest: string;
  readonly protectedRefsDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly promotableContentDigest: string;
  readonly fingerprintPolicyVersion: string;
  readonly fingerprintDigest: string;
}

export interface PromotionConsentProposalV1 {
  readonly schemaVersion: 1;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly candidateDeltaDigest: string;
  readonly candidateGateResultDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly targetWorkspaceIdentity: string;
  readonly targetGitCommonDirIdentity: string;
  readonly targetFingerprintDigest: string;
  readonly permissionDigest: string;
  readonly proposalDigest: string;
}

export interface PromotionConsentBindingV1
  extends PromotionConsentProposalV1 {
  readonly acknowledgedAt: string;
  readonly consentDigest: string;
}

export type TargetPromotionLeaseStateV1 =
  | 'acquired'
  | 'applying'
  | 'final_verifying'
  | 'reconciliation_required'
  | 'released';

export interface TargetPromotionLeaseV1 {
  readonly schemaVersion: 1;
  readonly targetPromotionLeaseId: string;
  readonly targetRegistryKey: string;
  readonly registryRevision: number;
  readonly targetWorkspaceIdentity: string;
  readonly targetGitCommonDirIdentity: string;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly promotionConsentDigest: string;
  readonly candidateDeltaDigest: string;
  readonly candidateGateResultDigest: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest: string;
  readonly fencingTokenDigest: string;
  readonly acquiredFingerprintDigest: string;
  readonly acquiredAt: string;
  readonly lastHeartbeatAt: string;
  readonly state: TargetPromotionLeaseStateV1;
  readonly previousLeaseDigest: string | null;
  readonly leaseDigest: string;
}

const TRANSITIONS: Readonly<Record<
  TargetPromotionLeaseStateV1,
  readonly TargetPromotionLeaseStateV1[]
>> = {
  acquired: ['applying', 'reconciliation_required', 'released'],
  applying: [
    'final_verifying',
    'reconciliation_required',
    'released',
  ],
  final_verifying: ['reconciliation_required', 'released'],
  reconciliation_required: ['applying', 'final_verifying', 'released'],
  released: [],
};

export function createTargetStateFingerprint(
  input: Omit<
    TargetStateFingerprintV1,
    'schemaVersion' | 'fingerprintPolicyVersion' | 'fingerprintDigest'
  >,
): TargetStateFingerprintV1 {
  const core = {
    schemaVersion: 1 as const,
    ...input,
    fingerprintPolicyVersion: TARGET_FINGERPRINT_POLICY_VERSION,
  };
  const value = Object.freeze({
    ...core,
    fingerprintDigest: canonicalDigest(
      'wukong/target-state-fingerprint/v1',
      core,
    ),
  });
  if (!validateTargetStateFingerprint(value)) {
    throw new TypeError('Target state fingerprint input is invalid.');
  }
  return value;
}

export function validateTargetStateFingerprint(
  value: unknown,
): value is TargetStateFingerprintV1 {
  if (!isRecord(value)
    || !exactKeys(value, TARGET_FINGERPRINT_KEYS)
    || value['schemaVersion'] !== 1
    || !isDigest(value['targetWorkspaceIdentity'])
    || !isDigest(value['targetGitCommonDirIdentity'])
    || !isGitOid(value['headOid'])
    || !isNullableString(value['branchRef'])
    || !isNullableDigest(value['branchRefDigest'])
    || ((value['branchRef'] === null)
      !== (value['branchRefDigest'] === null))
    || !isDigest(value['indexDigest'])
    || !isNullableDigest(value['trackedWorkingDeltaDigest'])
    || !isDigest(value['untrackedProjectionDigest'])
    || !isDigest(value['protectedRefsDigest'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['promotableContentDigest'])
    || value['fingerprintPolicyVersion']
      !== TARGET_FINGERPRINT_POLICY_VERSION
    || !isDigest(value['fingerprintDigest'])) {
    return false;
  }
  const fingerprint = value as unknown as TargetStateFingerprintV1;
  const { fingerprintDigest, ...core } = fingerprint;
  return canonicalDigest('wukong/target-state-fingerprint/v1', core)
    === fingerprintDigest;
}

export function targetPromotionRegistryKey(input: {
  readonly targetWorkspaceIdentity: string;
  readonly targetGitCommonDirIdentity: string;
}): string {
  if (!isDigest(input.targetWorkspaceIdentity)
    || !isDigest(input.targetGitCommonDirIdentity)) {
    throw new TypeError('Target promotion registry identity is invalid.');
  }
  return canonicalDigest('wukong/target-promotion-registry-key/v1', {
    targetWorkspaceIdentity: input.targetWorkspaceIdentity,
    targetGitCommonDirIdentity: input.targetGitCommonDirIdentity,
  });
}

export function createPromotionConsentProposal(input: {
  readonly promotionId: string;
  readonly candidateId: string;
  readonly candidateDeltaDigest: string;
  readonly candidateGateResultDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly targetFingerprint: TargetStateFingerprintV1;
  readonly permissionDigest: string;
}): PromotionConsentProposalV1 {
  if (!validateTargetStateFingerprint(input.targetFingerprint)) {
    throw new TypeError('Promotion consent target fingerprint is invalid.');
  }
  const core = {
    schemaVersion: 1 as const,
    promotionId: input.promotionId,
    candidateId: input.candidateId,
    candidateDeltaDigest: input.candidateDeltaDigest,
    candidateGateResultDigest: input.candidateGateResultDigest,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    targetWorkspaceIdentity:
      input.targetFingerprint.targetWorkspaceIdentity,
    targetGitCommonDirIdentity:
      input.targetFingerprint.targetGitCommonDirIdentity,
    targetFingerprintDigest:
      input.targetFingerprint.fingerprintDigest,
    permissionDigest: input.permissionDigest,
  };
  const value = Object.freeze({
    ...core,
    proposalDigest: canonicalDigest(
      'wukong/promotion-consent-proposal/v1',
      core,
    ),
  });
  if (!validatePromotionConsentProposal(value)) {
    throw new TypeError('Promotion consent proposal input is invalid.');
  }
  return value;
}

export function acknowledgePromotionConsent(
  proposal: PromotionConsentProposalV1,
  expectedProposalDigest: string,
  acknowledgedAt: string,
): PromotionConsentBindingV1 {
  if (!validatePromotionConsentProposal(proposal)
    || proposal.proposalDigest !== expectedProposalDigest
    || !isTimestamp(acknowledgedAt)) {
    throw new TypeError('Promotion consent acknowledgement is invalid.');
  }
  return Object.freeze({
    ...proposal,
    acknowledgedAt,
    consentDigest: canonicalDigest(
      'wukong/promotion-consent/v1',
      {
        proposalDigest: proposal.proposalDigest,
        acknowledgedAt,
      },
    ),
  });
}

export function validatePromotionConsentProposal(
  value: unknown,
): value is PromotionConsentProposalV1 {
  if (!isRecord(value)
    || !exactKeys(value, PROMOTION_PROPOSAL_KEYS)
    || value['schemaVersion'] !== 1
    || !isUuid(value['promotionId'])
    || !isUuid(value['candidateId'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isDigest(value['candidateGateResultDigest'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['targetWorkspaceIdentity'])
    || !isDigest(value['targetGitCommonDirIdentity'])
    || !isDigest(value['targetFingerprintDigest'])
    || !isDigest(value['permissionDigest'])
    || !isDigest(value['proposalDigest'])) {
    return false;
  }
  const proposal = value as unknown as PromotionConsentProposalV1;
  const { proposalDigest, ...core } = proposal;
  return canonicalDigest('wukong/promotion-consent-proposal/v1', core)
    === proposalDigest;
}

export function validatePromotionConsentBinding(
  value: unknown,
): value is PromotionConsentBindingV1 {
  if (!isRecord(value)
    || !exactKeys(value, PROMOTION_BINDING_KEYS)
    || !isTimestamp(value['acknowledgedAt'])
    || !isDigest(value['consentDigest'])) {
    return false;
  }
  const binding = value as unknown as PromotionConsentBindingV1;
  const {
    acknowledgedAt,
    consentDigest,
    ...proposal
  } = binding;
  return validatePromotionConsentProposal(proposal)
    && canonicalDigest('wukong/promotion-consent/v1', {
      proposalDigest: proposal.proposalDigest,
      acknowledgedAt,
    }) === consentDigest;
}

export function createTargetPromotionLease(input: {
  readonly targetPromotionLeaseId: string;
  readonly registryRevision: number;
  readonly targetFingerprint: TargetStateFingerprintV1;
  readonly promotionId: string;
  readonly candidateId: string;
  readonly promotionConsentDigest: string;
  readonly candidateDeltaDigest: string;
  readonly candidateGateResultDigest: string;
  readonly ownerRunId: string;
  readonly ownerProcessIdentityDigest: string;
  readonly fencingTokenDigest: string;
  readonly acquiredAt: string;
  readonly previousLeaseDigest?: string | null;
}): TargetPromotionLeaseV1 {
  if (!validateTargetStateFingerprint(input.targetFingerprint)) {
    throw new TypeError('Target promotion lease fingerprint is invalid.');
  }
  return sealTargetPromotionLease({
    schemaVersion: 1,
    targetPromotionLeaseId: input.targetPromotionLeaseId,
    targetRegistryKey: targetPromotionRegistryKey(input.targetFingerprint),
    registryRevision: input.registryRevision,
    targetWorkspaceIdentity:
      input.targetFingerprint.targetWorkspaceIdentity,
    targetGitCommonDirIdentity:
      input.targetFingerprint.targetGitCommonDirIdentity,
    promotionId: input.promotionId,
    candidateId: input.candidateId,
    promotionConsentDigest: input.promotionConsentDigest,
    candidateDeltaDigest: input.candidateDeltaDigest,
    candidateGateResultDigest: input.candidateGateResultDigest,
    ownerRunId: input.ownerRunId,
    ownerProcessIdentityDigest: input.ownerProcessIdentityDigest,
    fencingTokenDigest: input.fencingTokenDigest,
    acquiredFingerprintDigest: input.targetFingerprint.fingerprintDigest,
    acquiredAt: input.acquiredAt,
    lastHeartbeatAt: input.acquiredAt,
    state: 'acquired',
    previousLeaseDigest: input.previousLeaseDigest ?? null,
  });
}

export function transitionTargetPromotionLease(
  current: TargetPromotionLeaseV1,
  input: {
    readonly toState: TargetPromotionLeaseStateV1;
    readonly expectedFencingTokenDigest: string;
    readonly occurredAt: string;
  },
): TargetPromotionLeaseV1 {
  if (!validateTargetPromotionLease(current)
    || input.expectedFencingTokenDigest !== current.fencingTokenDigest
    || !TRANSITIONS[current.state].includes(input.toState)
    || !isTimestamp(input.occurredAt)
    || Date.parse(input.occurredAt) < Date.parse(current.lastHeartbeatAt)) {
    throw new TypeError('Target promotion lease transition is invalid.');
  }
  return sealTargetPromotionLease({
    ...current,
    registryRevision: current.registryRevision + 1,
    lastHeartbeatAt: input.occurredAt,
    state: input.toState,
    previousLeaseDigest: current.leaseDigest,
    leaseDigest: undefined,
  });
}

export function adoptTargetPromotionLease(
  current: TargetPromotionLeaseV1,
  input: {
    readonly expectedOwnerProcessIdentityDigest: string;
    readonly expectedFencingTokenDigest: string;
    readonly nextOwnerProcessIdentityDigest: string;
    readonly nextFencingTokenDigest: string;
    readonly occurredAt: string;
  },
): TargetPromotionLeaseV1 {
  if (!validateTargetPromotionLease(current)
    || current.state === 'released'
    || input.expectedOwnerProcessIdentityDigest
      !== current.ownerProcessIdentityDigest
    || input.expectedFencingTokenDigest
      !== current.fencingTokenDigest
    || !isDigest(input.nextOwnerProcessIdentityDigest)
    || !isDigest(input.nextFencingTokenDigest)
    || input.nextOwnerProcessIdentityDigest
      === current.ownerProcessIdentityDigest
    || input.nextFencingTokenDigest === current.fencingTokenDigest
    || !isTimestamp(input.occurredAt)
    || Date.parse(input.occurredAt)
      < Date.parse(current.lastHeartbeatAt)) {
    throw new TypeError(
      'Target promotion lease adoption is invalid.',
    );
  }
  return sealTargetPromotionLease({
    ...current,
    registryRevision: current.registryRevision + 1,
    ownerProcessIdentityDigest:
      input.nextOwnerProcessIdentityDigest,
    fencingTokenDigest: input.nextFencingTokenDigest,
    lastHeartbeatAt: input.occurredAt,
    previousLeaseDigest: current.leaseDigest,
    leaseDigest: undefined,
  });
}

export function validateTargetPromotionLease(
  value: unknown,
): value is TargetPromotionLeaseV1 {
  if (!isRecord(value)
    || !exactKeys(value, TARGET_LEASE_KEYS)
    || value['schemaVersion'] !== 1
    || !isUuid(value['targetPromotionLeaseId'])
    || !isDigest(value['targetRegistryKey'])
    || !isNonNegativeInteger(value['registryRevision'])
    || !isDigest(value['targetWorkspaceIdentity'])
    || !isDigest(value['targetGitCommonDirIdentity'])
    || !isUuid(value['promotionId'])
    || !isUuid(value['candidateId'])
    || !isDigest(value['promotionConsentDigest'])
    || !isDigest(value['candidateDeltaDigest'])
    || !isDigest(value['candidateGateResultDigest'])
    || !isIdentifier(value['ownerRunId'])
    || !isDigest(value['ownerProcessIdentityDigest'])
    || !isDigest(value['fencingTokenDigest'])
    || !isDigest(value['acquiredFingerprintDigest'])
    || !isTimestamp(value['acquiredAt'])
    || !isTimestamp(value['lastHeartbeatAt'])
    || !isTargetLeaseState(value['state'])
    || !isNullableDigest(value['previousLeaseDigest'])
    || !isDigest(value['leaseDigest'])) {
    return false;
  }
  const lease = value as unknown as TargetPromotionLeaseV1;
  const { leaseDigest, ...core } = lease;
  return lease.targetRegistryKey === targetPromotionRegistryKey(lease)
    && Date.parse(lease.lastHeartbeatAt) >= Date.parse(lease.acquiredAt)
    && canonicalDigest('wukong/target-promotion-lease/v1', core)
      === leaseDigest;
}

function sealTargetPromotionLease(
  input: Omit<TargetPromotionLeaseV1, 'leaseDigest'> & {
    readonly leaseDigest?: undefined;
  },
): TargetPromotionLeaseV1 {
  const { leaseDigest: _ignored, ...core } = input;
  const value = Object.freeze({
    ...core,
    leaseDigest: canonicalDigest(
      'wukong/target-promotion-lease/v1',
      core,
    ),
  });
  if (!validateTargetPromotionLease(value)) {
    throw new TypeError('Target promotion lease input is invalid.');
  }
  return value;
}

const TARGET_FINGERPRINT_KEYS = [
  'branchRef', 'branchRefDigest', 'fingerprintDigest',
  'fingerprintPolicyVersion', 'headOid', 'indexDigest',
  'promotableContentDigest', 'protectedRefsDigest', 'schemaVersion',
  'sourceSnapshotDigest', 'targetGitCommonDirIdentity',
  'targetWorkspaceIdentity', 'trackedWorkingDeltaDigest',
  'untrackedProjectionDigest',
] as const;
const PROMOTION_PROPOSAL_KEYS = [
  'candidateDeltaDigest', 'candidateGateResultDigest', 'candidateId',
  'permissionDigest', 'promotionId', 'proposalDigest', 'schemaVersion',
  'sourceSnapshotDigest', 'targetFingerprintDigest',
  'targetGitCommonDirIdentity', 'targetWorkspaceIdentity',
] as const;
const PROMOTION_BINDING_KEYS = [
  ...PROMOTION_PROPOSAL_KEYS,
  'acknowledgedAt',
  'consentDigest',
] as const;
const TARGET_LEASE_KEYS = [
  'acquiredAt', 'acquiredFingerprintDigest', 'candidateDeltaDigest',
  'candidateGateResultDigest', 'candidateId', 'fencingTokenDigest',
  'lastHeartbeatAt', 'leaseDigest', 'ownerRunId',
  'ownerProcessIdentityDigest', 'previousLeaseDigest', 'promotionId',
  'promotionConsentDigest', 'registryRevision', 'schemaVersion', 'state',
  'targetGitCommonDirIdentity', 'targetPromotionLeaseId',
  'targetRegistryKey', 'targetWorkspaceIdentity',
] as const;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).toSorted().join(',')
    === [...expected].toSorted().join(',');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function isGitOid(value: unknown): value is string {
  return typeof value === 'string'
    && (/^[a-f0-9]{40}$/u.test(value) || /^[a-f0-9]{64}$/u.test(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string' && value.length > 0 && value.length <= 512);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
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

function isTargetLeaseState(
  value: unknown,
): value is TargetPromotionLeaseStateV1 {
  return typeof value === 'string' && value in TRANSITIONS;
}
