import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  acknowledgePromotionConsent,
  appendPromotionChangeEvent,
  canonicalDigest,
  createCandidateDelta,
  createCandidateProjection,
  createPromotionApplyJournal,
  createPromotionConsentProposal,
  createPromotionPathState,
  createTargetStateFingerprint,
  type CandidateChangeManifestV1,
  type CandidateProjectionEntryV1,
  type PromotionApplyJournalV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyNextPromotionChange,
  PromotionChangeApplyError,
} from '../src/promotion-change-applier';
import {
  __testing as durableFaultTesting,
} from '../src/durable-boundary-test-fault';
import {
  PromotionApplyJournalStore,
} from '../src/promotion-apply-journal-store';
import {
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';

const PROMOTION_ID = '019f8cf0-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8cf0-0001-7abc-8def-0123456789ab';
const CANDIDATE_LEASE_ID = '019f8cf0-0002-7abc-8def-0123456789ab';
const JOURNAL_ID = '019f8cf0-0003-7abc-8def-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('applyNextPromotionChange', () => {
  it('applies create/update/delete/rename/mode under one fenced journal', async () => {
    const value = await fixture({
      baseline: {
        'delete.txt': ['delete\n', 0o100644],
        'mode.sh': ['echo ok\n', 0o100644],
        'rename-old.txt': ['same\n', 0o100644],
        'update.txt': ['before\n', 0o100644],
      },
      candidate: {
        'create.txt': ['created\n', 0o100644],
        'mode.sh': ['echo ok\n', 0o100755],
        'rename-new.txt': ['same\n', 0o100644],
        'update.txt': ['after\n', 0o100644],
      },
    });
    await value.run(async (context) => {
      let journal = context.journal;
      for (let index = 0; index < context.manifest.changes.length; index++) {
        journal = await applyNextPromotionChange({
          ...context,
          journal,
        });
      }
      expect(journal.events).toHaveLength(
        context.manifest.changes.length * 2,
      );
      expect(await readFile(join(value.target, 'create.txt'), 'utf8'))
        .toBe('created\n');
      expect(await readFile(join(value.target, 'update.txt'), 'utf8'))
        .toBe('after\n');
      await expect(stat(join(value.target, 'delete.txt'))).rejects
        .toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(value.target, 'rename-old.txt'))).rejects
        .toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(value.target, 'rename-new.txt'), 'utf8'))
        .toBe('same\n');
      if (process.platform !== 'win32') {
        expect((await stat(join(value.target, 'mode.sh'))).mode & 0o777)
          .toBe(0o755);
      }
    });
  });

  it('reconciles a crash after the write and before the applied event', async () => {
    const value = await fixture({
      baseline: { 'update.txt': ['before\n', 0o100644] },
      candidate: { 'update.txt': ['after\n', 0o100644] },
    });
    await value.run(async (context) => {
      const fault = durableFaultTesting
        .createDurableBoundaryTestFaultCapability(async (point) => {
          if (point === 'promotion_apply_after_atomic_leaf_mutation') {
            throw new Error('simulated process loss');
          }
        });
      await expect(applyNextPromotionChange({
        ...context,
        _testFaultCapability: fault,
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_path_unsafe',
      });
      const durablePrepared = await context.journalStore.inspect(
        context.view,
        JOURNAL_ID,
      );
      expect(durablePrepared.events.at(-1)?.eventType).toBe('prepared');
      const reconciled = await applyNextPromotionChange({
        ...context,
        journal: durablePrepared,
      });
      expect(reconciled.events.at(-1)?.eventType).toBe('reconciled');
    });
  });

  it('rejects an exact postimage that has no durable transaction receipt', async () => {
    const value = await fixture({
      baseline: { 'update.txt': ['before\n', 0o100644] },
      candidate: { 'update.txt': ['after\n', 0o100644] },
    });
    await value.run(async (context) => {
      const fault = durableFaultTesting
        .createDurableBoundaryTestFaultCapability(async (point) => {
          if (point === 'promotion_apply_before_target_mutation') {
            throw new Error('pause before backend mutation');
          }
        });
      await expect(applyNextPromotionChange({
        ...context,
        _testFaultCapability: fault,
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_path_unsafe',
      });
      const prepared = await context.journalStore.inspect(
        context.view,
        JOURNAL_ID,
      );
      await writeFile(join(value.target, 'update.txt'), 'after\n');

      await expect(applyNextPromotionChange({
        ...context,
        journal: prepared,
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_path_unsafe',
      });
      expect((await context.journalStore.inspect(
        context.view,
        JOURNAL_ID,
      )).events.at(-1)?.eventType).toBe('prepared');
    });
  });

  it.each([
    {
      marker: 'identity' as const,
      faultPoint: 'promotion_apply_after_atomic_leaf_mutation' as const,
    },
    {
      marker: 'committed' as const,
      faultPoint: 'promotion_apply_after_target_mutation' as const,
    },
  ])('rejects a tampered $marker transaction marker', async ({
    marker,
    faultPoint,
  }) => {
    const value = await fixture({
      baseline: { 'update.txt': ['before\n', 0o100644] },
      candidate: { 'update.txt': ['after\n', 0o100644] },
    });
    await value.run(async (context) => {
      const fault = durableFaultTesting
        .createDurableBoundaryTestFaultCapability(async (point) => {
          if (point === faultPoint) {
            throw new Error('simulated process loss');
          }
        });
      await expect(applyNextPromotionChange({
        ...context,
        _testFaultCapability: fault,
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_path_unsafe',
      });
      const prepared = await context.journalStore.inspect(
        context.view,
        JOURNAL_ID,
      );
      const transaction = (await readdir(value.target)).find((name) =>
        name.startsWith('.wukong-apply-'));
      expect(transaction).toBeDefined();
      await writeFile(
        join(value.target, transaction!, marker),
        'tampered\n',
      );

      await expect(applyNextPromotionChange({
        ...context,
        journal: prepared,
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_path_unsafe',
      });
      expect((await context.journalStore.inspect(
        context.view,
        JOURNAL_ID,
      )).events.at(-1)?.eventType).toBe('prepared');
    });
  });

  it.each([
    {
      operation: 'create' as const,
      baseline: {} as Files,
      candidate: {
        'create.txt': ['created\n', 0o100644],
      } as Files,
    },
    {
      operation: 'delete' as const,
      baseline: {
        'delete.txt': ['deleted\n', 0o100644],
      } as Files,
      candidate: {} as Files,
    },
    {
      operation: 'rename' as const,
      baseline: {
        'rename-old.txt': ['same\n', 0o100644],
      } as Files,
      candidate: {
        'rename-new.txt': ['same\n', 0o100644],
      } as Files,
    },
    {
      operation: 'mode' as const,
      baseline: {
        'mode.sh': ['echo ok\n', 0o100644],
      } as Files,
      candidate: {
        'mode.sh': ['echo ok\n', 0o100755],
      } as Files,
    },
  ])('reconciles $operation after postimage write but before outcome', async ({
    operation,
    baseline,
    candidate,
  }) => {
    if (operation === 'mode' && process.platform === 'win32') {
      return;
    }
    const value = await fixture({ baseline, candidate });
    await value.run(async (context) => {
      const change = context.manifest.changes[0]!;
      expect(change.operation).toBe(operation);
      const fault = durableFaultTesting
        .createDurableBoundaryTestFaultCapability(async (point) => {
          if (point === 'promotion_apply_after_atomic_leaf_mutation') {
            throw new Error('simulated process loss');
          }
        });
      await expect(applyNextPromotionChange({
        ...context,
        _testFaultCapability: fault,
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_path_unsafe',
      });
      const durablePrepared = await context.journalStore.inspect(
        context.view,
        JOURNAL_ID,
      );
      expect(durablePrepared.events.at(-1)?.eventType).toBe('prepared');
      const reconciled = await applyNextPromotionChange({
        ...context,
        journal: durablePrepared,
      });
      expect(reconciled.events.at(-1)).toMatchObject({
        operation,
        eventType: 'reconciled',
      });
    });
  });

  it('persists conflict instead of overwriting an unexpected target edit', async () => {
    const value = await fixture({
      baseline: { 'update.txt': ['before\n', 0o100644] },
      candidate: { 'update.txt': ['after\n', 0o100644] },
    });
    await value.run(async (context) => {
      const change = context.manifest.changes[0]!;
      const prepared = appendPromotionChangeEvent(context.journal, {
        eventId: '019f8cf0-0004-7abc-8def-0123456789ab',
        changeIndex: 0,
        operation: 'update',
        eventType: 'prepared',
        expectedPreimages: [pathState(change.preimage!)],
        expectedPostimages: [pathState(change.postimage!)],
        observedStates: [pathState(change.preimage!)],
        targetFencingTokenDigest:
          context.view.lease.fencingTokenDigest,
        idempotencyKey: canonicalDigest(
          'wukong/promotion-change-idempotency/v1',
          {
            journalId: context.journal.journalId,
            changeDigest: change.changeDigest,
            targetFencingTokenDigest:
              context.view.lease.fencingTokenDigest,
          },
        ),
        occurredAt: '2026-07-29T15:20:01.000Z',
      });
      const durablePrepared = await context.journalStore.append(
        context.view,
        context.journal.journalHeadDigest,
        prepared,
      );
      await writeFile(join(value.target, 'update.txt'), 'external\n');
      await expect(applyNextPromotionChange({
        ...context,
        journal: durablePrepared,
      })).rejects.toBeInstanceOf(PromotionChangeApplyError);
      await expect(applyNextPromotionChange({
        ...context,
        journal: await context.journalStore.inspect(
          context.view,
          JOURNAL_ID,
        ),
      })).rejects.toMatchObject({
        reasonCode: 'promotion_apply_invalid_input',
      });
      expect(await readFile(join(value.target, 'update.txt'), 'utf8'))
        .toBe('external\n');
    });
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'fails closed when a checked Target parent becomes an external symlink before mutation',
    async () => {
      const value = await fixture({
        baseline: {
          'nested/update.txt': ['before\n', 0o100644],
        },
        candidate: {
          'nested/update.txt': ['after\n', 0o100644],
        },
      });
      const outside = `${value.target}-outside`;
      await mkdir(outside);
      await writeFile(join(outside, 'update.txt'), 'external\n');
      const fault = durableFaultTesting
        .createDurableBoundaryTestFaultCapability(async (point) => {
          if (point !== 'promotion_apply_before_target_mutation') {
            return;
          }
          await rename(
            join(value.target, 'nested'),
            join(value.target, 'nested-original'),
          );
          await symlink(
            outside,
            join(value.target, 'nested'),
            'dir',
          );
        });

      await value.run(async (context) => {
        await expect(applyNextPromotionChange({
          ...context,
          _testFaultCapability: fault,
        })).rejects.toMatchObject({
          reasonCode: 'promotion_apply_path_unsafe',
        });
        expect(await readFile(join(outside, 'update.txt'), 'utf8'))
          .toBe('external\n');
        expect(await readFile(
          join(value.target, 'nested-original', 'update.txt'),
          'utf8',
        )).toBe('before\n');
        const journal = await context.journalStore.inspect(
          context.view,
          JOURNAL_ID,
        );
        expect(journal.events.at(-1)?.eventType).toBe('prepared');
      });
    },
  );

  describe.runIf(
    process.platform === 'darwin' || process.platform === 'linux',
  )('atomic final-leaf races', () => {
    it('preserves an unowned deterministic transaction directory', async () => {
      const value = await fixture({
        baseline: {},
        candidate: {
          'create.txt': ['created\n', 0o100644],
        },
      });
      await value.run(async (context) => {
        const change = context.manifest.changes[0]!;
        const transactionId = canonicalDigest(
          'wukong/promotion-change-idempotency/v1',
          {
            journalId: context.journal.journalId,
            changeDigest: change.changeDigest,
            targetFencingTokenDigest:
              context.view.lease.fencingTokenDigest,
          },
        );
        const transactionName =
          `.wukong-apply-${transactionId.slice('sha256:'.length)}.txn`;
        const transactionPath = join(value.target, transactionName);
        const fault = durableFaultTesting
          .createDurableBoundaryTestFaultCapability(async (point) => {
            if (point !== 'promotion_apply_before_target_mutation') return;
            await mkdir(transactionPath, { mode: 0o700 });
            await writeFile(join(transactionPath, 'keep'), 'user\n');
          });

        await expect(applyNextPromotionChange({
          ...context,
          _testFaultCapability: fault,
        })).rejects.toMatchObject({
          reasonCode: 'promotion_apply_path_unsafe',
        });
        expect(await readFile(
          join(transactionPath, 'keep'),
          'utf8',
        )).toBe('user\n');
      });
    });

    it.each([
      {
        operation: 'create' as const,
        baseline: {} as Files,
        candidate: {
          'create.txt': ['created\n', 0o100644],
        } as Files,
        leaf: 'create.txt',
      },
      {
        operation: 'update' as const,
        baseline: {
          'update.txt': ['before\n', 0o100644],
        } as Files,
        candidate: {
          'update.txt': ['after\n', 0o100644],
        } as Files,
        leaf: 'update.txt',
      },
      {
        operation: 'delete' as const,
        baseline: {
          'delete.txt': ['deleted\n', 0o100644],
        } as Files,
        candidate: {} as Files,
        leaf: 'delete.txt',
      },
      {
        operation: 'rename' as const,
        baseline: {
          'rename-old.txt': ['same\n', 0o100644],
        } as Files,
        candidate: {
          'rename-new.txt': ['same\n', 0o100644],
        } as Files,
        leaf: 'rename-old.txt',
      },
      {
        operation: 'mode' as const,
        baseline: {
          'mode.sh': ['echo ok\n', 0o100644],
        } as Files,
        candidate: {
          'mode.sh': ['echo ok\n', 0o100755],
        } as Files,
        leaf: 'mode.sh',
      },
    ])(
      'preserves an atomic-save replacement during $operation',
      async ({ operation, baseline, candidate, leaf }) => {
        const value = await fixture({ baseline, candidate });
        let replacementInode: number | null = null;
        let injected = false;
        const fault = durableFaultTesting
          .createDurableBoundaryTestFaultCapability(async (point) => {
            if (point !== 'promotion_apply_after_final_leaf_check'
              || injected) {
              return;
            }
            injected = true;
            const targetPath = join(value.target, leaf);
            if (operation === 'create') {
              await writeFile(targetPath, 'external\n', { mode: 0o644 });
              replacementInode = (await stat(targetPath)).ino;
              return;
            }
            const replacementPath = join(
              value.target,
              `.external-${operation}`,
            );
            const info = await stat(targetPath);
            await writeFile(
              replacementPath,
              await readFile(targetPath),
              { mode: info.mode & 0o777 },
            );
            await chmod(replacementPath, info.mode & 0o777);
            replacementInode = (await stat(replacementPath)).ino;
            await rename(replacementPath, targetPath);
          });

        await value.run(async (context) => {
          expect(context.manifest.changes[0]?.operation).toBe(operation);
          await expect(applyNextPromotionChange({
            ...context,
            _testFaultCapability: fault,
          })).rejects.toMatchObject({
            reasonCode: 'promotion_apply_path_unsafe',
          });
          expect(injected).toBe(true);
          const preserved = await stat(join(value.target, leaf));
          expect(preserved.ino).toBe(replacementInode);
          if (operation === 'create') {
            expect(await readFile(join(value.target, leaf), 'utf8'))
              .toBe('external\n');
          }
          if (operation === 'rename') {
            await expect(stat(join(
              value.target,
              'rename-new.txt',
            ))).rejects.toMatchObject({ code: 'ENOENT' });
          }
          expect((await readdir(value.target)).filter((name) =>
            name.startsWith('.wukong-apply-'))).toEqual([]);
        });
      },
    );

    it.each([
      {
        operation: 'create' as const,
        baseline: {} as Files,
        candidate: {
          'create.txt': ['created\n', 0o100644],
        } as Files,
        leaf: 'create.txt',
      },
      {
        operation: 'update' as const,
        baseline: {
          'update.txt': ['before\n', 0o100644],
        } as Files,
        candidate: {
          'update.txt': ['after\n', 0o100644],
        } as Files,
        leaf: 'update.txt',
      },
      {
        operation: 'delete' as const,
        baseline: {
          'delete.txt': ['deleted\n', 0o100644],
        } as Files,
        candidate: {} as Files,
        leaf: 'delete.txt',
      },
      {
        operation: 'rename' as const,
        baseline: {
          'rename-old.txt': ['same\n', 0o100644],
        } as Files,
        candidate: {
          'rename-new.txt': ['same\n', 0o100644],
        } as Files,
        leaf: 'rename-new.txt',
      },
      {
        operation: 'mode' as const,
        baseline: {
          'mode.sh': ['echo ok\n', 0o100644],
        } as Files,
        candidate: {
          'mode.sh': ['echo ok\n', 0o100755],
        } as Files,
        leaf: 'mode.sh',
      },
    ])(
      'rejects a same-content new inode after atomic $operation before outcome',
      async ({ operation, baseline, candidate, leaf }) => {
        const value = await fixture({ baseline, candidate });
        await value.run(async (context) => {
          expect(context.manifest.changes[0]?.operation).toBe(operation);
          const fault = durableFaultTesting
            .createDurableBoundaryTestFaultCapability(async (point) => {
              if (point
                === 'promotion_apply_after_atomic_leaf_mutation') {
                throw new Error('simulated process loss');
              }
            });
          await expect(applyNextPromotionChange({
            ...context,
            _testFaultCapability: fault,
          })).rejects.toMatchObject({
            reasonCode: 'promotion_apply_path_unsafe',
          });
          const prepared = await context.journalStore.inspect(
            context.view,
            JOURNAL_ID,
          );
          expect(prepared.events.at(-1)?.eventType).toBe('prepared');

          const replacement = join(
            value.target,
            `.external-after-${operation}`,
          );
          const content = operation === 'delete'
            ? baseline[leaf]![0]
            : await readFile(join(value.target, leaf));
          const mode = operation === 'delete'
            ? baseline[leaf]![1] & 0o777
            : (await stat(join(value.target, leaf))).mode & 0o777;
          await writeFile(replacement, content, { mode });
          await chmod(replacement, mode);
          const replacementInode = (await stat(replacement)).ino;
          await rename(replacement, join(value.target, leaf));

          await expect(applyNextPromotionChange({
            ...context,
            journal: prepared,
          })).rejects.toMatchObject({
            reasonCode: 'promotion_apply_path_unsafe',
          });
          expect((await stat(join(value.target, leaf))).ino)
            .toBe(replacementInode);
          expect((await context.journalStore.inspect(
            context.view,
            JOURNAL_ID,
          )).events.at(-1)?.eventType).toBe('prepared');
          expect((await readdir(value.target)).filter((name) =>
            name.startsWith('.wukong-apply-'))).toHaveLength(1);
        });
      },
    );
  });
});

type Files = Readonly<Record<
  string,
  readonly [content: string, mode: 0o100644 | 0o100755]
>>;

async function fixture(input: {
  readonly baseline: Files;
  readonly candidate: Files;
}) {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-change-apply-'));
  roots.push(parent);
  const target = join(parent, 'target');
  const candidate = join(parent, 'candidate');
  await Promise.all([mkdir(target), mkdir(candidate)]);
  await writeFiles(target, input.baseline);
  await writeFiles(candidate, input.candidate);
  const baselineProjection = createCandidateProjection({
    ...projectionBinding(),
    entries: entries(input.baseline),
  });
  const candidateProjection = createCandidateProjection({
    ...projectionBinding(),
    entries: entries(input.candidate),
  });
  const bundle = createCandidateDelta(
    baselineProjection,
    candidateProjection,
  );
  const targetFingerprint = createTargetStateFingerprint({
    targetWorkspaceIdentity: digest('workspace'),
    targetGitCommonDirIdentity: digest('git-common'),
    headOid: 'a'.repeat(40),
    branchRef: 'refs/heads/main',
    branchRefDigest: digest('branch'),
    indexDigest: digest('index'),
    trackedWorkingDeltaDigest: null,
    untrackedProjectionDigest: digest('untracked'),
    protectedRefsDigest: digest('refs'),
    sourceSnapshotDigest: digest('source'),
    promotableContentDigest: bundle.delta.candidateWorkspaceDigest,
  });
  const proposal = createPromotionConsentProposal({
    promotionId: PROMOTION_ID,
    candidateId: CANDIDATE_ID,
    candidateDeltaDigest: bundle.delta.candidateDeltaDigest,
    candidateGateResultDigest: digest('gate'),
    sourceSnapshotDigest: digest('source'),
    targetFingerprint,
    permissionDigest: digest('permission'),
  });
  const targetStore = new TargetPromotionLeaseStore({
    registryRootDirectory: join(parent, 'registry'),
    now: () => new Date('2026-07-29T15:20:00.000Z'),
  });
  const acquired = await targetStore.acquire({
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T15:19:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: 'run_apply',
    ownerProcessIdentityDigest: digest('process'),
  });
  const applying = await targetStore.transition(
    acquired.binding,
    'applying',
  );
  const journalStore = new PromotionApplyJournalStore({
    now: () => new Date('2026-07-29T15:20:02.000Z'),
  });
  return {
    target,
    run: async (
      callback: (context: {
        readonly view: Parameters<
          typeof applyNextPromotionChange
        >[0]['view'];
        readonly journalStore: PromotionApplyJournalStore;
        readonly journal: PromotionApplyJournalV1;
        readonly manifest: CandidateChangeManifestV1;
        readonly targetDirectory: string;
        readonly candidateDirectory: string;
        readonly now: () => Date;
      }) => Promise<void>,
    ) => targetStore.withExclusiveLease(
      applying.binding,
      'applying',
      async (view) => {
        const proposed = createPromotionApplyJournal({
          journalId: JOURNAL_ID,
          promotionId: view.lease.promotionId,
          targetPromotionLeaseId: view.lease.targetPromotionLeaseId,
          targetRegistryKey: view.lease.targetRegistryKey,
          createdByTargetFencingTokenDigest:
            view.lease.fencingTokenDigest,
          candidateId: view.lease.candidateId,
          candidateDeltaDigest: bundle.delta.candidateDeltaDigest,
          orderedChangeManifestDigest:
            bundle.manifest.orderedChangeManifestDigest,
          changeCount: bundle.manifest.changes.length,
          targetBeforeFingerprintDigest:
            view.lease.acquiredFingerprintDigest,
          targetBeforeContentDigest:
            bundle.delta.materializedSourceDigest,
          materializedSourceDigest:
            bundle.delta.materializedSourceDigest,
          agentDeltaDigest: bundle.delta.agentDeltaDigest,
        });
        const journal = await journalStore.createOrLoad(
          view,
          proposed,
        );
        await callback({
          view,
          journalStore,
          journal,
          manifest: bundle.manifest,
          targetDirectory: target,
          candidateDirectory: candidate,
          now: () => new Date('2026-07-29T15:20:03.000Z'),
        });
      },
    ),
  };
}

function projectionBinding() {
  return {
    candidateId: CANDIDATE_ID,
    leaseId: CANDIDATE_LEASE_ID,
    sourceSnapshotDigest: digest('source'),
    materializedSourceDigest: digest('materialized'),
    bootstrapPlanDigest: digest('bootstrap'),
    generatedScopesDigest: digest('generated'),
  };
}

function entries(files: Files) {
  return Object.entries(files).map(([path, [content, mode]]) => ({
    canonicalRelativePath: path,
    mode,
    sizeBytes: Buffer.byteLength(content),
    contentDigest: contentDigest(content),
  }));
}

function pathState(entry: CandidateProjectionEntryV1) {
  return createPromotionPathState({
    candidateRelativePath: entry.canonicalRelativePath,
    presence: 'present',
    fileType: 'regular',
    mode: entry.mode & 0o777,
    contentDigest: entry.contentDigest,
  });
}

async function writeFiles(root: string, files: Files): Promise<void> {
  for (const [path, [content, mode]] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, { mode: mode & 0o777 });
    if (process.platform !== 'win32') {
      await chmod(join(root, path), mode & 0o777);
    }
  }
}

function contentDigest(content: string): string {
  return `sha256:${createHash('sha256')
    .update('wukong/candidate-projection-file/v1')
    .update('\0')
    .update(content)
    .digest('hex')}`;
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/change-apply/v1', label);
}
