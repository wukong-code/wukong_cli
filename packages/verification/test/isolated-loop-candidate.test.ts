import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  candidateGateAttemptIdForLease,
  createIsolatedLoopCandidateBinding,
  validateIsolatedLoopCandidateBinding,
} from '../src';

const IDS = {
  goal: '10000000-0000-4000-8000-000000000001',
  contract: '20000000-0000-4000-8000-000000000002',
  run: '30000000-0000-4000-8000-000000000003',
  ownerRun: '40000000-0000-4000-8000-000000000004',
  candidate: '50000000-0000-4000-8000-000000000005',
  lease: '60000000-0000-4000-8000-000000000006',
} as const;

function digest(label: string): string {
  return canonicalDigest('wukong/test/isolated-loop-candidate/v1', label);
}

function binding() {
  return createIsolatedLoopCandidateBinding({
    goalId: IDS.goal,
    contractId: IDS.contract,
    runId: IDS.run,
    ownerRunId: IDS.ownerRun,
    candidateId: IDS.candidate,
    worktreeLeaseId: IDS.lease,
    sourceSnapshotDigest: digest('source'),
    bootstrapPlanDigest: digest('bootstrap'),
    gatePlanDigest: digest('gate'),
    criteriaSelectionDigest: digest('criteria'),
    reservedLeaseDigest: digest('reserved-lease'),
    createdAt: '2026-07-29T08:00:00.000Z',
  });
}

function bindingInput() {
  const { bindingDigest: _bindingDigest, schemaVersion: _schemaVersion, ...input }
    = binding();
  return input;
}

describe('IsolatedLoopCandidateBindingV1', () => {
  it('seals the durable run-to-candidate join', () => {
    const value = binding();

    expect(value.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(validateIsolatedLoopCandidateBinding(value)).toBe(true);
  });

  it('supports a contract without a criteria selection', () => {
    const value = createIsolatedLoopCandidateBinding({
      ...bindingInput(),
      criteriaSelectionDigest: null,
    });

    expect(validateIsolatedLoopCandidateBinding(value)).toBe(true);
  });

  it('rejects tampering and unknown fields', () => {
    expect(validateIsolatedLoopCandidateBinding({
      ...binding(),
      candidateId: IDS.goal,
    })).toBe(false);
    expect(validateIsolatedLoopCandidateBinding({
      ...binding(),
      privatePath: '/tmp/candidate',
    })).toBe(false);
  });

  it('derives one stable UUID per verifying lease revision', () => {
    const value = binding();
    const first = candidateGateAttemptIdForLease(
      value,
      digest('verifying-lease-1'),
    );

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(candidateGateAttemptIdForLease(
      value,
      digest('verifying-lease-1'),
    )).toBe(first);
    expect(candidateGateAttemptIdForLease(
      value,
      digest('verifying-lease-2'),
    )).not.toBe(first);
  });
});
