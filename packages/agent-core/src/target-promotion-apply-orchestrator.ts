import {
  buildTargetStateFingerprint,
  completePromotionApplyJournal,
  createPromotionApplyJournal,
  inspectSourceSnapshot,
  validateSourceSnapshot,
  validateTargetStateFingerprint,
  type PromotionApplyJournalV1,
  type SourceSnapshotV1,
  type TargetStateFingerprintV1,
} from '@wukong/verification';

import {
  validateCandidateDeltaSeal,
  type CandidateDeltaSealV1,
} from './candidate-delta-store';
import {
  applyNextPromotionChange,
} from './promotion-change-applier';
import {
  PromotionApplyJournalStore,
} from './promotion-apply-journal-store';
import {
  type TargetPromotionLeaseAuthorityV1,
  TargetPromotionLeaseBindingV1,
  TargetPromotionLeaseStore,
} from './target-promotion-lease-store';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
} from './worktree-lease-store';

export type TargetPromotionApplyOrchestratorErrorCode =
  | 'promotion_apply_invalid_input'
  | 'promotion_apply_eligibility_changed'
  | 'promotion_apply_reconciliation_required';

export class TargetPromotionApplyOrchestratorError extends Error {
  constructor(
    readonly reasonCode: TargetPromotionApplyOrchestratorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TargetPromotionApplyOrchestratorError';
  }
}

export interface TargetPromotionApplyResultV1 {
  readonly journal: PromotionApplyJournalV1;
  readonly targetAfterFingerprint: TargetStateFingerprintV1;
  readonly finalVerifyingAuthority: TargetPromotionLeaseAuthorityV1;
}

export class TargetPromotionApplyOrchestrator {
  private readonly now: () => Date;

  constructor(options?: { readonly now?: () => Date }) {
    if (options?.now !== undefined && typeof options.now !== 'function') {
      invalid('Target promotion Apply orchestrator options are invalid.');
    }
    this.now = options?.now ?? (() => new Date());
  }

  async run(input: {
    readonly targetPromotionLeaseStore: TargetPromotionLeaseStore;
    readonly targetPromotionBinding: TargetPromotionLeaseBindingV1;
    readonly journalStore: PromotionApplyJournalStore;
    readonly worktreeLeaseStore: WorktreeLeaseStore;
    readonly candidateRootCapability: CandidateRootCapabilityV1;
    readonly candidateDeltaSeal: CandidateDeltaSealV1;
    readonly expectedSourceSnapshot: SourceSnapshotV1;
    readonly expectedTargetBeforeFingerprint: TargetStateFingerprintV1;
    readonly targetDirectory: string;
    readonly journalId: string;
    readonly requiredGatePaths?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<TargetPromotionApplyResultV1> {
    assertInput(input);
    throwIfAborted(input.signal);
    let applied: {
      readonly journal: PromotionApplyJournalV1;
      readonly targetAfterFingerprint: TargetStateFingerprintV1;
    };
    try {
      applied = await input.worktreeLeaseStore.withCandidateRoot(
        input.candidateRootCapability,
        async (candidateView) =>
          input.targetPromotionLeaseStore.withExclusiveLease(
            input.targetPromotionBinding,
            'applying',
            async (targetView) => {
              assertLeaseBindings(input, targetView.lease);
              const proposed = createPromotionApplyJournal({
                journalId: input.journalId,
                promotionId: targetView.lease.promotionId,
                targetPromotionLeaseId:
                  targetView.lease.targetPromotionLeaseId,
                targetRegistryKey: targetView.lease.targetRegistryKey,
                createdByTargetFencingTokenDigest:
                  targetView.lease.fencingTokenDigest,
                candidateId: input.candidateDeltaSeal.candidateId,
                candidateDeltaDigest:
                  input.candidateDeltaSeal.delta.candidateDeltaDigest,
                orderedChangeManifestDigest:
                  input.candidateDeltaSeal.manifest
                    .orderedChangeManifestDigest,
                changeCount:
                  input.candidateDeltaSeal.manifest.changes.length,
                targetBeforeFingerprintDigest:
                  input.expectedTargetBeforeFingerprint.fingerprintDigest,
                targetBeforeContentDigest:
                  input.candidateDeltaSeal.delta.materializedSourceDigest,
                materializedSourceDigest:
                  input.candidateDeltaSeal.delta.materializedSourceDigest,
                agentDeltaDigest:
                  input.candidateDeltaSeal.delta.agentDeltaDigest,
              });
              let journal = await input.journalStore.createOrLoad(
                targetView,
                proposed,
              );
              if (journal.events.length === 0
                && journal.state === 'applying') {
                const freshBefore = await buildTargetStateFingerprint({
                  cwd: input.targetDirectory,
                  expectedSourceSnapshot:
                    input.expectedSourceSnapshot,
                  promotableContentDigest:
                    input.candidateDeltaSeal.delta
                      .candidateWorkspaceDigest,
                  requiredGatePaths: input.requiredGatePaths,
                });
                if (freshBefore.fingerprintDigest
                    !== input.expectedTargetBeforeFingerprint
                      .fingerprintDigest
                  || freshBefore.fingerprintDigest
                    !== targetView.lease.acquiredFingerprintDigest) {
                  throw new TargetPromotionApplyOrchestratorError(
                    'promotion_apply_eligibility_changed',
                    'Target state changed after promotion consent.',
                  );
                }
              }
              while (journal.state === 'applying'
                && completedChangeCount(journal)
                  < input.candidateDeltaSeal.manifest.changes.length) {
                throwIfAborted(input.signal);
                journal = await applyNextPromotionChange({
                  view: targetView,
                  journalStore: input.journalStore,
                  journal,
                  manifest: input.candidateDeltaSeal.manifest,
                  targetDirectory: input.targetDirectory,
                  candidateDirectory:
                    candidateView.candidateDirectory,
                  now: this.now,
                });
                throwIfAborted(input.signal);
              }
              if (journal.state !== 'applying'
                && journal.state !== 'applied') {
                throw new TargetPromotionApplyOrchestratorError(
                  'promotion_apply_reconciliation_required',
                  'Apply journal is not eligible for Final Gate.',
                );
              }
              const targetAfterFingerprint =
                await buildAfterFingerprint(input);
              throwIfAborted(input.signal);
              if (journal.state === 'applied') {
                if (journal.targetAfterFingerprintDigest
                    !== targetAfterFingerprint.fingerprintDigest) {
                  throw new TargetPromotionApplyOrchestratorError(
                    'promotion_apply_reconciliation_required',
                    'Applied target fingerprint changed before resume.',
                  );
                }
              } else {
                const completed = completePromotionApplyJournal(
                  journal,
                  targetAfterFingerprint.fingerprintDigest,
                );
                journal = await input.journalStore.append(
                  targetView,
                  journal.journalHeadDigest,
                  completed,
                );
              }
              await targetView.assertAuthority();
              return { journal, targetAfterFingerprint };
            },
          ),
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      await transitionToReconciliation(input).catch(() => undefined);
      if (error instanceof TargetPromotionApplyOrchestratorError) {
        throw error;
      }
      throw new TargetPromotionApplyOrchestratorError(
        'promotion_apply_reconciliation_required',
        'Target promotion Apply stopped and requires reconciliation.',
        { cause: error },
      );
    }
    const finalVerifyingAuthority =
      await input.targetPromotionLeaseStore.transition(
        input.targetPromotionBinding,
        'final_verifying',
      );
    return {
      ...applied,
      finalVerifyingAuthority,
    };
  }
}

async function buildAfterFingerprint(input: {
  readonly targetDirectory: string;
  readonly expectedSourceSnapshot: SourceSnapshotV1;
  readonly candidateDeltaSeal: CandidateDeltaSealV1;
  readonly requiredGatePaths?: readonly string[];
}): Promise<TargetStateFingerprintV1> {
  const selectedUntrackedPaths = [...new Set([
    ...input.expectedSourceSnapshot.includedUntracked.map(
      (entry) => entry.canonicalRelativePath,
    ),
    ...input.candidateDeltaSeal.delta.changedPaths,
  ])].toSorted();
  const inspected = await inspectSourceSnapshot({
    cwd: input.targetDirectory,
    selectedUntrackedPaths,
    requiredGatePaths: input.requiredGatePaths,
  });
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null) {
    throw new TargetPromotionApplyOrchestratorError(
      'promotion_apply_reconciliation_required',
      'Target state could not be frozen after Apply.',
    );
  }
  return buildTargetStateFingerprint({
    cwd: input.targetDirectory,
    expectedSourceSnapshot: inspected.proposedSnapshot,
    lineageSourceSnapshotDigest:
      input.expectedSourceSnapshot.snapshotDigest,
    promotableContentDigest:
      input.candidateDeltaSeal.delta.candidateWorkspaceDigest,
    requiredGatePaths: input.requiredGatePaths,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(
    'Target promotion Apply was cancelled.',
    'AbortError',
  );
}

function assertLeaseBindings(
  input: Parameters<TargetPromotionApplyOrchestrator['run']>[0],
  lease: Awaited<ReturnType<TargetPromotionLeaseStore['inspect']>>,
): void {
  if (lease.candidateId !== input.candidateDeltaSeal.candidateId
    || lease.candidateDeltaDigest
      !== input.candidateDeltaSeal.delta.candidateDeltaDigest
    || lease.acquiredFingerprintDigest
      !== input.expectedTargetBeforeFingerprint.fingerprintDigest
    || input.expectedTargetBeforeFingerprint.sourceSnapshotDigest
      !== input.expectedSourceSnapshot.snapshotDigest
    || input.expectedTargetBeforeFingerprint.promotableContentDigest
      !== input.candidateDeltaSeal.delta.candidateWorkspaceDigest
    || input.candidateDeltaSeal.delta.sourceSnapshotDigest
      !== input.expectedSourceSnapshot.snapshotDigest) {
    throw new TargetPromotionApplyOrchestratorError(
      'promotion_apply_eligibility_changed',
      'Promotion lease, candidate delta, and source lineage do not match.',
    );
  }
}

async function transitionToReconciliation(
  input: Parameters<TargetPromotionApplyOrchestrator['run']>[0],
): Promise<void> {
  const lease = await input.targetPromotionLeaseStore.inspect(
    input.targetPromotionBinding.targetRegistryKey,
  );
  if (lease.leaseDigest === input.targetPromotionBinding.leaseDigest
    && lease.state === 'applying') {
    await input.targetPromotionLeaseStore.transition(
      input.targetPromotionBinding,
      'reconciliation_required',
    );
  }
}

function completedChangeCount(journal: PromotionApplyJournalV1): number {
  const last = journal.events.at(-1);
  if (last === undefined) return 0;
  return last.eventType === 'prepared'
    ? last.changeIndex
    : last.changeIndex + 1;
}

function assertInput(
  input: Parameters<TargetPromotionApplyOrchestrator['run']>[0],
): void {
  if (!(input.targetPromotionLeaseStore
      instanceof TargetPromotionLeaseStore)
    || !(input.targetPromotionBinding
      instanceof TargetPromotionLeaseBindingV1)
    || !(input.journalStore instanceof PromotionApplyJournalStore)
    || !(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.candidateRootCapability
      instanceof CandidateRootCapabilityV1)
    || !validateCandidateDeltaSeal(input.candidateDeltaSeal)
    || !validateSourceSnapshot(input.expectedSourceSnapshot)
    || !validateTargetStateFingerprint(
      input.expectedTargetBeforeFingerprint,
    )
    || typeof input.targetDirectory !== 'string'
    || input.targetDirectory.length === 0
    || (input.signal !== undefined
      && !(input.signal instanceof AbortSignal))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(input.journalId)) {
    invalid('Target promotion Apply input is invalid.');
  }
}

function invalid(message: string): never {
  throw new TargetPromotionApplyOrchestratorError(
    'promotion_apply_invalid_input',
    message,
  );
}
