import { describe, expect, it } from 'vitest';

import { canonicalDigest } from '../src/finish-line';
import {
  adoptWorktreeLease,
  createWorktreeLease,
  transitionWorktreeLease,
  validateInitialWorktreeLease,
  validateWorktreeLease,
  validateWorktreeLeaseEvent,
  validateWorktreeLeaseTransition,
  type WorktreeLeaseTransitionV1,
} from '../src/worktree-lease';

const CANDIDATE_ID = '571ef334-5325-4d3e-b623-b22a11218118';

function digest(label: string): string {
  return canonicalDigest('wukong/test/worktree-lease/v1', label);
}

function create(): WorktreeLeaseTransitionV1 {
  return createWorktreeLease({
    leaseId: '5f1ab12d-9934-4d3a-8a28-bac003413b2e',
    candidateId: CANDIDATE_ID,
    goalId: 'goal_1',
    contractId: 'contract_1',
    runId: 'run_1',
    ownerRunId: 'run_1',
    ownerProcessIdentityDigest: digest('process-1'),
    sourceSnapshotDigest: digest('source'),
    snapshotBlobLeaseId: '74f72d79-f8e4-43cb-ae7d-b4f356a8c86c',
    snapshotBlobLeaseDigest: digest('blob-lease'),
    manifestDigest: digest('manifest'),
    materializationPolicyDigest: digest('materialization-policy'),
    bootstrapPlanDigest: digest('bootstrap'),
    gatePlanDigest: digest('gate'),
    criteriaSelectionDigest: digest('criteria'),
    repositoryIdentity: digest('repository'),
    baseCommit: 'a'.repeat(40),
    repositoryRelativeCwd: 'packages/app',
    candidateBranch: `wukong/candidate/${CANDIDATE_ID}`,
    createdByRunId: 'run_1',
    createdAt: '2026-07-29T03:00:00.000Z',
    expiresAt: '2026-07-29T03:10:00.000Z',
    fencingTokenDigest: digest('fencing-1'),
  });
}

function transition(
  current: WorktreeLeaseTransitionV1,
  toState: Parameters<typeof transitionWorktreeLease>[1]['toState'],
  occurredAt: string,
  extra: Partial<Parameters<typeof transitionWorktreeLease>[1]> = {},
): WorktreeLeaseTransitionV1 {
  return transitionWorktreeLease(current.lease, {
    toState,
    occurredAt,
    ...extra,
  });
}

describe('WorktreeLeaseV1', () => {
  it('creates a sealed creating lease and initial reserved event', () => {
    const created = create();

    expect(created.lease).toMatchObject({
      state: 'creating',
      casRevision: 0,
      worktreeIdentity: null,
      materializedSourceDigest: null,
    });
    expect(created.event).toMatchObject({
      sequence: 0,
      eventType: 'reserved',
      fromState: null,
      toState: 'creating',
    });
    expect(validateWorktreeLease(created.lease)).toBe(true);
    expect(validateWorktreeLeaseEvent(created.event)).toBe(true);
    expect(validateInitialWorktreeLease(created.lease, created.event)).toBe(true);
  });

  it('follows the materialize, verify, promote, and release lifecycle', () => {
    const created = create();
    const materializing = transition(
      created,
      'materializing',
      '2026-07-29T03:00:01.000Z',
    );
    const bootstrapping = transition(
      materializing,
      'bootstrapping',
      '2026-07-29T03:00:02.000Z',
      {
        worktreeIdentity: digest('worktree'),
        materializedSourceDigest: digest('materialized'),
      },
    );
    const active = transition(
      bootstrapping,
      'active',
      '2026-07-29T03:00:03.000Z',
    );
    const verifying = transition(
      active,
      'verifying',
      '2026-07-29T03:00:04.000Z',
    );
    const awaiting = transition(
      verifying,
      'awaiting_promotion',
      '2026-07-29T03:00:05.000Z',
    );
    const promoting = transition(
      awaiting,
      'promoting',
      '2026-07-29T03:00:06.000Z',
    );
    const promoted = transition(
      promoting,
      'promoted',
      '2026-07-29T03:00:07.000Z',
    );
    const released = transition(
      promoted,
      'released',
      '2026-07-29T03:00:08.000Z',
      { reasonCode: 'promotion_complete' },
    );

    expect(released.lease).toMatchObject({
      state: 'released',
      casRevision: 8,
      worktreeIdentity: digest('worktree'),
      materializedSourceDigest: digest('materialized'),
    });
    expect(released.event.eventType).toBe('released');
    expect(validateWorktreeLeaseTransition(
      promoted.lease,
      released.event,
      released.lease,
    )).toBe(true);
  });

  it('supports bootstrap-not-required activation directly from materializing', () => {
    const materializing = transition(
      create(),
      'materializing',
      '2026-07-29T03:00:01.000Z',
    );
    const active = transition(
      materializing,
      'active',
      '2026-07-29T03:00:02.000Z',
      {
        worktreeIdentity: digest('worktree'),
        materializedSourceDigest: digest('materialized'),
      },
    );

    expect(active.lease.state).toBe('active');
    expect(active.event.eventType).toBe('activated');
  });

  it('requires exact worktree and materialized-source bindings only at completion', () => {
    const materializing = transition(
      create(),
      'materializing',
      '2026-07-29T03:00:01.000Z',
    );

    expect(() => transition(
      materializing,
      'bootstrapping',
      '2026-07-29T03:00:02.000Z',
    )).toThrow(/completion binding/u);
    expect(() => transition(
      materializing,
      'bootstrapping',
      '2026-07-29T03:00:02.000Z',
      {
        worktreeIdentity: digest('worktree'),
      },
    )).toThrow();
  });

  it('rejects transitions that cross materialization expiry', () => {
    const materializing = transition(
      create(),
      'materializing',
      '2026-07-29T03:00:01.000Z',
    );

    expect(() => transition(
      materializing,
      'active',
      '2026-07-29T03:10:00.000Z',
      {
        worktreeIdentity: digest('worktree'),
        materializedSourceDigest: digest('materialized'),
      },
    )).toThrow(/expired/u);
  });

  it('requires reasons for retain and release but forbids them elsewhere', () => {
    expect(() => transition(
      create(),
      'retained',
      '2026-07-29T03:00:01.000Z',
    )).toThrow(/reason/u);
    expect(() => transition(
      create(),
      'materializing',
      '2026-07-29T03:00:01.000Z',
      { reasonCode: 'unexpected' },
    )).toThrow(/reason/u);
  });

  it('rotates run ownership and fencing through an explicit adoption event', () => {
    const materializing = transition(
      create(),
      'materializing',
      '2026-07-29T03:00:01.000Z',
    );
    const active = transition(
      materializing,
      'active',
      '2026-07-29T03:00:02.000Z',
      {
        worktreeIdentity: digest('worktree'),
        materializedSourceDigest: digest('materialized'),
      },
    );
    const adopted = adoptWorktreeLease(active.lease, {
      newRunId: 'run_2',
      newOwnerRunId: 'run_2',
      newOwnerProcessIdentityDigest: digest('process-2'),
      newFencingTokenDigest: digest('fencing-2'),
      occurredAt: '2026-07-29T03:00:03.000Z',
      reasonCode: 'explicit_resume',
    });

    expect(adopted.lease).toMatchObject({
      state: 'active',
      runId: 'run_2',
      ownerRunId: 'run_2',
      fencingTokenDigest: digest('fencing-2'),
    });
    expect(adopted.event).toMatchObject({
      eventType: 'ownership_adopted',
      fromState: 'active',
      toState: 'active',
      previousFencingTokenDigest: active.lease.fencingTokenDigest,
    });
    expect(validateWorktreeLeaseTransition(
      active.lease,
      adopted.event,
      adopted.lease,
    )).toBe(true);
  });

  it('allows pre-active adoption but rejects promoting and terminal leases', () => {
    const input = {
      newRunId: 'run_2',
      newOwnerRunId: 'run_2',
      newOwnerProcessIdentityDigest: digest('process-2'),
      newFencingTokenDigest: digest('fencing-2'),
      occurredAt: '2026-07-29T03:00:03.000Z',
      reasonCode: 'explicit_resume',
    };
    expect(adoptWorktreeLease(create().lease, input).lease)
      .toMatchObject({
        state: 'creating',
        ownerProcessIdentityDigest: digest('process-2'),
      });
    const materializing = transition(
      create(),
      'materializing',
      '2026-07-29T03:00:01.000Z',
    );
    expect(adoptWorktreeLease(materializing.lease, input).lease)
      .toMatchObject({
        state: 'materializing',
        ownerProcessIdentityDigest: digest('process-2'),
      });
  });

  it('rejects lease and event tampering', () => {
    const created = create();

    expect(validateWorktreeLease({
      ...created.lease,
      gatePlanDigest: digest('other-gate'),
    })).toBe(false);
    expect(validateWorktreeLeaseEvent({
      ...created.event,
      ownerRunId: 'run_other',
    })).toBe(false);
  });

  it('rejects unknown fields instead of accepting schema drift', () => {
    const created = create();

    expect(validateWorktreeLease({
      ...created.lease,
      unknown: true,
    })).toBe(false);
    expect(validateWorktreeLeaseEvent({
      ...created.event,
      unknown: true,
    })).toBe(false);
  });
});
