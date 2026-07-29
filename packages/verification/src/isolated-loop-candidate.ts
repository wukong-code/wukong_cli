import { canonicalDigest } from './finish-line';

export interface IsolatedLoopCandidateBindingV1 {
  readonly schemaVersion: 1;
  readonly goalId: string;
  readonly contractId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly candidateId: string;
  readonly worktreeLeaseId: string;
  readonly sourceSnapshotDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string | null;
  readonly reservedLeaseDigest: string;
  readonly createdAt: string;
  readonly bindingDigest: string;
}

export function createIsolatedLoopCandidateBinding(input: {
  readonly goalId: string;
  readonly contractId: string;
  readonly runId: string;
  readonly ownerRunId: string;
  readonly candidateId: string;
  readonly worktreeLeaseId: string;
  readonly sourceSnapshotDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly gatePlanDigest: string;
  readonly criteriaSelectionDigest: string | null;
  readonly reservedLeaseDigest: string;
  readonly createdAt: string;
}): IsolatedLoopCandidateBindingV1 {
  const core = {
    schemaVersion: 1 as const,
    ...input,
  };
  const binding: IsolatedLoopCandidateBindingV1 = {
    ...core,
    bindingDigest: canonicalDigest(
      'wukong/isolated-loop-candidate-binding/v1',
      core,
    ),
  };
  if (!validateIsolatedLoopCandidateBinding(binding)) {
    throw new TypeError('Isolated Loop candidate binding is invalid.');
  }
  return binding;
}

export function validateIsolatedLoopCandidateBinding(
  value: unknown,
): value is IsolatedLoopCandidateBindingV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',')
      !== BINDING_KEYS.toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['goalId'])
    || !isUuid(value['contractId'])
    || !isUuid(value['runId'])
    || !isUuid(value['ownerRunId'])
    || !isUuid(value['candidateId'])
    || !isUuid(value['worktreeLeaseId'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['bootstrapPlanDigest'])
    || !isDigest(value['gatePlanDigest'])
    || (value['criteriaSelectionDigest'] !== null
      && !isDigest(value['criteriaSelectionDigest']))
    || !isDigest(value['reservedLeaseDigest'])
    || !isCanonicalTimestamp(value['createdAt'])
    || !isDigest(value['bindingDigest'])) {
    return false;
  }
  const binding = value as unknown as IsolatedLoopCandidateBindingV1;
  const { bindingDigest, ...core } = binding;
  return canonicalDigest(
    'wukong/isolated-loop-candidate-binding/v1',
    core,
  ) === bindingDigest;
}

const BINDING_KEYS = [
  'bindingDigest',
  'bootstrapPlanDigest',
  'candidateId',
  'contractId',
  'createdAt',
  'criteriaSelectionDigest',
  'gatePlanDigest',
  'goalId',
  'ownerRunId',
  'reservedLeaseDigest',
  'runId',
  'schemaVersion',
  'sourceSnapshotDigest',
  'worktreeLeaseId',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function candidateGateAttemptIdForLease(
  binding: IsolatedLoopCandidateBindingV1,
  verifyingLeaseDigest: string,
): string {
  if (!validateIsolatedLoopCandidateBinding(binding)
    || !isDigest(verifyingLeaseDigest)) {
    throw new TypeError(
      'A valid candidate binding and verifying lease digest are required.',
    );
  }
  const hex = canonicalDigest(
    'wukong/candidate-gate-attempt-id/v1',
    {
      bindingDigest: binding.bindingDigest,
      verifyingLeaseDigest,
    },
  ).slice('sha256:'.length, 'sha256:'.length + 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
