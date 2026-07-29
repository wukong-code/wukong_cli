import {
  canonicalDigest,
  createSnapshotBlobLease,
  transitionSnapshotBlobLease,
  validateInitialSnapshotBlobLease,
  validateSnapshotBlobLease,
  validateSnapshotBlobLeaseEvent,
  validateSnapshotBlobLeaseTransition,
  type CreateSnapshotBlobLeaseInputV1,
  type SnapshotBlobLeaseStateV1,
} from '../src';
import { describe, expect, it } from 'vitest';

const CREATED_AT = '2026-07-28T08:00:00.000Z';
const EXPIRES_AT = '2026-07-28T08:10:00.000Z';

function digest(label: string): string {
  return canonicalDigest('wukong/test/snapshot-blob-lease/v1', label);
}

function createInput(): CreateSnapshotBlobLeaseInputV1 {
  return {
    blobLeaseId: '5bc3ebea-d62d-4b7f-bd86-1af90d4ea2dd',
    createdByRunId: 'run_creator',
    ownerRunId: 'run_owner',
    sourceSnapshotDigest: digest('snapshot'),
    snapshotPolicyDigest: digest('snapshot-policy'),
    materializationPolicyDigest: digest('materialization-policy'),
    manifestDigest: digest('manifest'),
    privateBlobPathIdentity: digest('private-path'),
    contentDigest: digest('content'),
    payloadSizeBytes: 8192,
    entryCount: 3,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    fencingTokenDigest: digest('fencing-token'),
  };
}

function advance(
  initial: ReturnType<typeof createSnapshotBlobLease>,
  states: readonly SnapshotBlobLeaseStateV1[],
) {
  let current = initial;
  for (const [index, state] of states.entries()) {
    current = transitionSnapshotBlobLease(current.lease, {
      toState: state,
      occurredAt: new Date(Date.parse(CREATED_AT) + (index + 1) * 1000).toISOString(),
      reasonCode: state === 'corrupt'
        ? 'payload_digest_mismatch'
        : state === 'expired'
          ? 'lease_expired'
          : state === 'destroying' ? 'cleanup_requested' : null,
    });
  }
  return current;
}

describe('snapshot blob lease contract', () => {
  it('creates a digest-bound staging lease and initial journal event', () => {
    const created = createSnapshotBlobLease(createInput());

    expect(created.lease.state).toBe('staging');
    expect(created.lease.casRevision).toBe(0);
    expect(created.lease.journalHeadDigest).toBe(created.event.eventDigest);
    expect(validateSnapshotBlobLease(created.lease)).toBe(true);
    expect(validateSnapshotBlobLeaseEvent(created.event)).toBe(true);
    expect(validateInitialSnapshotBlobLease(created.lease, created.event)).toBe(true);
  });

  it('supports the monotonic seal, confirm, materialize, consume, destroy path', () => {
    const created = createSnapshotBlobLease(createInput());
    const states = [
      'sealed',
      'confirmed',
      'materializing',
      'consumed',
      'destroying',
      'destroyed',
    ] as const;
    let current = created;

    for (const [index, state] of states.entries()) {
      const previous = current.lease;
      current = transitionSnapshotBlobLease(previous, {
        toState: state,
        occurredAt: new Date(Date.parse(CREATED_AT) + (index + 1) * 1000).toISOString(),
        reasonCode: state === 'destroying' ? 'payload_consumed' : null,
      });
      expect(validateSnapshotBlobLeaseTransition(previous, current.event, current.lease))
        .toBe(true);
    }

    expect(current.lease.casRevision).toBe(6);
    expect(current.lease.updatedAt).toBe('2026-07-28T08:00:06.000Z');
    expect(current.lease.sealedAt).toBe('2026-07-28T08:00:01.000Z');
    expect(current.lease.destroyedAt).toBe('2026-07-28T08:00:06.000Z');
    expect(current.lease.state).toBe('destroyed');
    expect(() => transitionSnapshotBlobLease(current.lease, {
      toState: 'sealed',
      occurredAt: '2026-07-28T08:00:07.000Z',
    })).toThrow(/Invalid snapshot blob lease transition/u);
  });

  it('supports explicit cancellation without misclassifying the payload as corrupt', () => {
    const created = createSnapshotBlobLease(createInput());
    const sealed = transitionSnapshotBlobLease(created.lease, {
      toState: 'sealed',
      occurredAt: '2026-07-28T08:00:01.000Z',
    });
    const destroying = transitionSnapshotBlobLease(sealed.lease, {
      toState: 'destroying',
      occurredAt: '2026-07-28T08:00:02.000Z',
      reasonCode: 'user_cancelled',
    });
    const destroyed = transitionSnapshotBlobLease(destroying.lease, {
      toState: 'destroyed',
      occurredAt: '2026-07-28T08:00:03.000Z',
    });

    expect(destroyed.lease.state).toBe('destroyed');
    expect(destroying.event.reasonCode).toBe('user_cancelled');
  });

  it('requires explicit reasons for exceptional and destruction transitions', () => {
    const created = createSnapshotBlobLease(createInput());

    expect(() => transitionSnapshotBlobLease(created.lease, {
      toState: 'expired',
      occurredAt: '2026-07-28T08:00:01.000Z',
    })).toThrow(/invalid reason/u);
    expect(() => transitionSnapshotBlobLease(created.lease, {
      toState: 'sealed',
      occurredAt: '2026-07-28T08:00:01.000Z',
      reasonCode: 'not_allowed',
    })).toThrow(/invalid reason/u);
  });

  it('rejects record, journal and transition tampering', () => {
    const created = createSnapshotBlobLease(createInput());
    const sealed = transitionSnapshotBlobLease(created.lease, {
      toState: 'sealed',
      occurredAt: '2026-07-28T08:00:01.000Z',
    });

    expect(validateSnapshotBlobLease({
      ...sealed.lease,
      contentDigest: digest('tampered-content'),
    })).toBe(false);
    expect(validateSnapshotBlobLeaseEvent({
      ...sealed.event,
      previousLeaseDigest: digest('wrong-lease'),
    })).toBe(false);
    expect(validateSnapshotBlobLeaseTransition(
      created.lease,
      sealed.event,
      { ...sealed.lease, ownerRunId: 'other_owner' },
    )).toBe(false);
  });

  it('rejects unknown fields instead of silently excluding them from digests', () => {
    const created = createSnapshotBlobLease(createInput());

    expect(validateSnapshotBlobLease({
      ...created.lease,
      rawFencingToken: 'must-never-be-public',
    })).toBe(false);
    expect(validateSnapshotBlobLeaseEvent({
      ...created.event,
      payloadPath: '/private/source.bin',
    })).toBe(false);
  });

  it('rejects non-canonical timestamps, invalid bounds and opaque identifiers', () => {
    expect(() => createSnapshotBlobLease({
      ...createInput(),
      createdAt: '2026-07-28T08:00:00Z',
    })).toThrow(/creation input is invalid/u);
    expect(() => createSnapshotBlobLease({
      ...createInput(),
      expiresAt: CREATED_AT,
    })).toThrow(/creation input is invalid/u);
    expect(() => createSnapshotBlobLease({
      ...createInput(),
      ownerRunId: '../owner',
    })).toThrow(/creation input is invalid/u);

    const sealed = transitionSnapshotBlobLease(
      createSnapshotBlobLease(createInput()).lease,
      {
        toState: 'sealed',
        occurredAt: '2026-07-28T08:00:02.000Z',
      },
    );
    expect(() => transitionSnapshotBlobLease(sealed.lease, {
      toState: 'confirmed',
      occurredAt: '2026-07-28T08:00:01.000Z',
    })).toThrow(/transition time is invalid/u);
    expect(() => transitionSnapshotBlobLease(
      createSnapshotBlobLease(createInput()).lease,
      {
        toState: 'sealed',
        occurredAt: '2026-07-28T08:11:00.000Z',
      },
    )).toThrow(/expired before/u);

    const beforeExpiry = transitionSnapshotBlobLease(
      createSnapshotBlobLease(createInput()).lease,
      {
        toState: 'sealed',
        occurredAt: '2026-07-28T08:09:59.000Z',
      },
    );
    expect(() => transitionSnapshotBlobLease(beforeExpiry.lease, {
      toState: 'confirmed',
      occurredAt: '2026-07-28T08:10:00.001Z',
    })).toThrow(/expired before/u);
  });

  it('rejects a digest-valid journal transition that moves time backwards', () => {
    const staged = createSnapshotBlobLease(createInput());
    const sealed = transitionSnapshotBlobLease(staged.lease, {
      toState: 'sealed',
      occurredAt: '2026-07-28T08:00:01.000Z',
    });
    const confirmed = transitionSnapshotBlobLease(sealed.lease, {
      toState: 'confirmed',
      occurredAt: '2026-07-28T08:00:03.000Z',
    });
    const eventCore = {
      schemaVersion: 1 as const,
      blobLeaseId: confirmed.lease.blobLeaseId,
      sequence: confirmed.lease.casRevision + 1,
      eventType: 'materialization_started' as const,
      fromState: 'confirmed' as const,
      toState: 'materializing' as const,
      ownerRunId: confirmed.lease.ownerRunId,
      fencingTokenDigest: confirmed.lease.fencingTokenDigest,
      previousLeaseDigest: confirmed.lease.leaseDigest,
      previousEventDigest: confirmed.lease.journalHeadDigest,
      occurredAt: '2026-07-28T08:00:02.000Z',
      reasonCode: null,
    };
    const event = {
      ...eventCore,
      eventDigest: canonicalDigest('wukong/snapshot-blob-lease-event/v1', eventCore),
    };
    const { leaseDigest: _leaseDigest, ...previousCore } = confirmed.lease;
    const nextCore = {
      ...previousCore,
      state: 'materializing' as const,
      casRevision: event.sequence,
      updatedAt: event.occurredAt,
      journalHeadDigest: event.eventDigest,
    };
    const next = {
      ...nextCore,
      leaseDigest: canonicalDigest('wukong/snapshot-blob-lease/v1', nextCore),
    };

    expect(validateSnapshotBlobLeaseEvent(event)).toBe(true);
    expect(validateSnapshotBlobLease(next)).toBe(true);
    expect(validateSnapshotBlobLeaseTransition(confirmed.lease, event, next)).toBe(false);
  });

  it('keeps the complete lineage digest-sensitive across repeated risks', () => {
    const first = advance(createSnapshotBlobLease(createInput()), [
      'sealed',
      'confirmed',
      'corrupt',
      'destroying',
      'destroyed',
    ]);
    const secondCreated = createSnapshotBlobLease({
      ...createInput(),
      blobLeaseId: '79ef53cf-4b46-4b6b-baf1-f65578c83133',
    });
    const second = advance(secondCreated, [
      'sealed',
      'confirmed',
      'corrupt',
      'destroying',
      'destroyed',
    ]);

    expect(first.lease.leaseDigest).not.toBe(second.lease.leaseDigest);
    expect(first.lease.journalHeadDigest).not.toBe(second.lease.journalHeadDigest);
  });
});
