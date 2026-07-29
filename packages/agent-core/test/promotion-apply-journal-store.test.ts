import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgePromotionConsent,
  appendPromotionChangeEvent,
  canonicalDigest,
  canonicalJson,
  createPromotionApplyJournal,
  createPromotionConsentProposal,
  createPromotionPathState,
  createTargetStateFingerprint,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PromotionApplyJournalStore,
  PromotionApplyJournalStoreError,
} from '../src/promotion-apply-journal-store';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';

const PROMOTION_ID = '019f8ce0-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8ce0-0001-7abc-8def-0123456789ab';
const JOURNAL_ID = '019f8ce0-0002-7abc-8def-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('PromotionApplyJournalStore', () => {
  it('persists event-first, repairs one state lag, and rejects tampering', async () => {
    const value = await fixture();
    const acquired = await value.targetStore.acquire(value.acquire);
    const applying = await value.targetStore.transition(
      acquired.binding,
      'applying',
    );
    await value.targetStore.withExclusiveLease(
      applying.binding,
      'applying',
      async (view) => {
        const initial = journalFixture(view.lease);
        await value.journalStore.createOrLoad(view, initial);
        const prepared = appendPromotionChangeEvent(initial, {
          eventId: '019f8ce0-0003-7abc-8def-0123456789ab',
          changeIndex: 0,
          operation: 'update',
          eventType: 'prepared',
          expectedPreimages: [pathState('before')],
          expectedPostimages: [pathState('after')],
          observedStates: [pathState('before')],
          targetFencingTokenDigest: view.lease.fencingTokenDigest,
          idempotencyKey: digest('change-0'),
          occurredAt: '2026-07-29T15:10:01.000Z',
        });
        await value.journalStore.append(
          view,
          initial.journalHeadDigest,
          prepared,
        );
        await writeFile(
          value.journalState(view.lease.targetRegistryKey),
          canonicalJson(initial),
          { mode: 0o600 },
        );
        await expect(value.journalStore.inspect(view, JOURNAL_ID))
          .resolves.toMatchObject({
            journalHeadDigest: prepared.journalHeadDigest,
            events: [{ eventType: 'prepared' }],
          });
        const record = value.recordPath(
          view.lease.targetRegistryKey,
          1,
        );
        const tampered = JSON.parse(await readFile(record, 'utf8')) as {
          recordDigest: string;
        };
        tampered.recordDigest = digest('tampered');
        await writeFile(record, JSON.stringify(tampered), { mode: 0o600 });
        await expect(value.journalStore.inspect(view, JOURNAL_ID))
          .rejects.toBeInstanceOf(PromotionApplyJournalStoreError);
      },
    ).catch((error: unknown) => {
      expect(error).toBeInstanceOf(PromotionApplyJournalStoreError);
    });
  });

  it('rejects a journal bound to another candidate delta', async () => {
    const value = await fixture();
    const acquired = await value.targetStore.acquire(value.acquire);
    const applying = await value.targetStore.transition(
      acquired.binding,
      'applying',
    );
    await value.targetStore.withExclusiveLease(
      applying.binding,
      'applying',
      async (view) => {
        expect(() => createPromotionApplyJournal({
          ...journalInput(view.lease),
          candidateDeltaDigest: digest('other-delta'),
        })).not.toThrow();
        await expect(value.journalStore.createOrLoad(
          view,
          createPromotionApplyJournal({
            ...journalInput(view.lease),
            candidateDeltaDigest: digest('other-delta'),
          }),
        )).rejects.toMatchObject({
          reasonCode: 'promotion_journal_conflict',
        });
      },
    );
  });

  it('adopts an existing journal after the applying lease owner changes', async () => {
    const value = await fixture();
    const acquired = await value.targetStore.acquire(value.acquire);
    const applying = await value.targetStore.transition(
      acquired.binding,
      'applying',
    );
    let createdBy: string | undefined;
    await value.targetStore.withExclusiveLease(
      applying.binding,
      'applying',
      async (view) => {
        createdBy = view.lease.fencingTokenDigest;
        await value.journalStore.createOrLoad(
          view,
          journalFixture(view.lease),
        );
      },
    );
    const nextProof = await proof(84, 'next-process');
    const adopted = await value.targetStore.adoptApplying({
      targetRegistryKey: applying.lease.targetRegistryKey,
      ownerRunId: applying.lease.ownerRunId,
      expectedLeaseDigest: applying.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });

    await value.targetStore.withExclusiveLease(
      adopted.binding,
      'applying',
      async (view) => {
        const resumed = await value.journalStore.createOrLoad(
          view,
          journalFixture(view.lease),
        );
        expect(resumed).toMatchObject({
          createdByTargetFencingTokenDigest: createdBy,
          currentTargetFencingTokenDigest:
            adopted.lease.fencingTokenDigest,
          targetFencingTokenLineage: [
            createdBy,
            adopted.lease.fencingTokenDigest,
          ],
        });
      },
    );
  });
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-apply-journal-'));
  roots.push(parent);
  const registryRoot = join(parent, 'registry');
  const targetFingerprint = createTargetStateFingerprint({
    targetWorkspaceIdentity: digest('workspace'),
    targetGitCommonDirIdentity: digest('git-common-dir'),
    headOid: 'a'.repeat(40),
    branchRef: 'refs/heads/main',
    branchRefDigest: digest('branch'),
    indexDigest: digest('index'),
    trackedWorkingDeltaDigest: null,
    untrackedProjectionDigest: digest('untracked'),
    protectedRefsDigest: digest('refs'),
    sourceSnapshotDigest: digest('source'),
    promotableContentDigest: digest('candidate-content'),
  });
  const proposal = createPromotionConsentProposal({
    promotionId: PROMOTION_ID,
    candidateId: CANDIDATE_ID,
    candidateDeltaDigest: digest('candidate-delta'),
    candidateGateResultDigest: digest('candidate-gate'),
    sourceSnapshotDigest: digest('source'),
    targetFingerprint,
    permissionDigest: digest('permission'),
  });
  const ownerProcessLivenessProof =
    await proof(42, 'old-process');
  const acquire = {
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T15:09:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: 'run_promotion',
    ownerProcessIdentityDigest:
      ownerProcessLivenessProof.proofDigest,
    ownerProcessLivenessProof,
  };
  const directory = (registryKey: string) => join(
    registryRoot,
    registryKey.slice('sha256:'.length),
    'apply-journals',
    JOURNAL_ID,
  );
  return {
    acquire,
    targetStore: new TargetPromotionLeaseStore({
      registryRootDirectory: registryRoot,
      now: () => new Date('2026-07-29T15:10:00.000Z'),
      probeLiveness: () => Promise.resolve('dead'),
    }),
    journalStore: new PromotionApplyJournalStore({
      now: () => new Date('2026-07-29T15:10:02.000Z'),
    }),
    journalState: (key: string) => join(directory(key), 'journal.json'),
    recordPath: (key: string, sequence: number) => join(
      directory(key),
      'records',
      `${String(sequence).padStart(12, '0')}.json`,
    ),
  };
}

function proof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

function journalFixture(
  lease: Awaited<ReturnType<TargetPromotionLeaseStore['inspect']>>,
) {
  return createPromotionApplyJournal(journalInput(lease));
}

function journalInput(
  lease: Awaited<ReturnType<TargetPromotionLeaseStore['inspect']>>,
) {
  return {
    journalId: JOURNAL_ID,
    promotionId: lease.promotionId,
    targetPromotionLeaseId: lease.targetPromotionLeaseId,
    targetRegistryKey: lease.targetRegistryKey,
    createdByTargetFencingTokenDigest: lease.fencingTokenDigest,
    candidateId: lease.candidateId,
    candidateDeltaDigest: lease.candidateDeltaDigest,
    orderedChangeManifestDigest: digest('manifest'),
    changeCount: 1,
    targetBeforeFingerprintDigest: lease.acquiredFingerprintDigest,
    targetBeforeContentDigest: digest('source-content'),
    materializedSourceDigest: digest('source-content'),
    agentDeltaDigest: digest('agent-delta'),
  };
}

function pathState(content: string) {
  return createPromotionPathState({
    candidateRelativePath: 'file.txt',
    presence: 'present',
    fileType: 'regular',
    mode: 0o644,
    contentDigest: digest(content),
  });
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/apply-journal-store/v1', label);
}
