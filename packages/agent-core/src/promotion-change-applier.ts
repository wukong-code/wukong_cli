import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  appendPromotionChangeEvent,
  canonicalDigest,
  canonicalJson,
  createPromotionPathState,
  validateCandidateChangeManifest,
  validatePromotionApplyJournal,
  type CandidateChangeManifestV1,
  type CandidateChangeV1,
  type CandidateProjectionEntryV1,
  type PromotionApplyJournalV1,
  type PromotionPathStateV1,
} from '@wukong/verification';

import {
  PromotionApplyJournalStore,
} from './promotion-apply-journal-store';
import {
  injectDurableBoundaryTestFault,
  validateDurableBoundaryTestFaultCapability,
  type DurableBoundaryTestFaultCapabilityV1,
} from './durable-boundary-test-fault';
import type {
  TargetPromotionExclusiveLeaseViewV1,
} from './target-promotion-lease-store';
import {
  TargetPromotionWorkspaceBackend,
} from './target-promotion-workspace-backend';

export type PromotionChangeApplyErrorCode =
  | 'promotion_apply_invalid_input'
  | 'promotion_apply_conflict'
  | 'promotion_apply_path_unsafe'
  | 'promotion_apply_candidate_changed';

export class PromotionChangeApplyError extends Error {
  constructor(
    readonly reasonCode: PromotionChangeApplyErrorCode,
    readonly journalHeadDigest: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PromotionChangeApplyError';
  }
}

export async function applyNextPromotionChange(input: {
  readonly view: TargetPromotionExclusiveLeaseViewV1;
  readonly journalStore: PromotionApplyJournalStore;
  readonly journal: PromotionApplyJournalV1;
  readonly manifest: CandidateChangeManifestV1;
  readonly targetDirectory: string;
  readonly candidateDirectory: string;
  readonly now?: () => Date;
  /**
   * Process-crash test seam. Production callers must never supply this.
   */
  readonly _testFaultCapability?:
    DurableBoundaryTestFaultCapabilityV1;
}): Promise<PromotionApplyJournalV1> {
  assertInput(input);
  if (input.journal.state !== 'applying') {
    invalid(input.journal, 'Apply journal is not applying.');
  }
  let targetWorkspace: TargetPromotionWorkspaceBackend | undefined;
  let candidateWorkspace: TargetPromotionWorkspaceBackend | undefined;
  try {
    targetWorkspace = new TargetPromotionWorkspaceBackend(
      input.targetDirectory,
      {
        afterFinalLeafCheck: () =>
          injectDurableBoundaryTestFault(
            input._testFaultCapability,
            'promotion_apply_after_final_leaf_check',
          ),
        afterAtomicMutation: () =>
          injectDurableBoundaryTestFault(
            input._testFaultCapability,
            'promotion_apply_after_atomic_leaf_mutation',
          ),
      },
    );
    candidateWorkspace = new TargetPromotionWorkspaceBackend(
      input.candidateDirectory,
    );
  } catch (error) {
    targetWorkspace?.close();
    throw new PromotionChangeApplyError(
      'promotion_apply_path_unsafe',
      input.journal.journalHeadDigest,
      'Promotion change could not open its descriptor-rooted workspaces.',
      { cause: error },
    );
  }
  try {
    return await applyNextPromotionChangeInWorkspace(
      input,
      targetWorkspace,
      candidateWorkspace,
    );
  } finally {
    candidateWorkspace.close();
    targetWorkspace.close();
  }
}

async function applyNextPromotionChangeInWorkspace(
  input: Parameters<typeof applyNextPromotionChange>[0],
  targetWorkspace: TargetPromotionWorkspaceBackend,
  candidateWorkspace: TargetPromotionWorkspaceBackend,
): Promise<PromotionApplyJournalV1> {
  const previous = input.journal.events.at(-1);
  if (previous?.eventType === 'applied'
    || previous?.eventType === 'reconciled') {
    const completedChange =
      input.manifest.changes[previous.changeIndex];
    if (completedChange === undefined) {
      invalid(input.journal, 'Completed Apply event has no change.');
    }
    try {
      await finalizeChange(
        targetWorkspace,
        completedChange,
        previous.idempotencyKey,
      );
    } catch (error) {
      throw new PromotionChangeApplyError(
        'promotion_apply_path_unsafe',
        input.journal.journalHeadDigest,
        'A committed Target transaction receipt could not be finalized.',
        { cause: error },
      );
    }
  }
  const nextIndex = nextChangeIndex(input.journal);
  if (nextIndex >= input.manifest.changes.length) return input.journal;
  const change = input.manifest.changes[nextIndex]!;
  const expected = expectedStates(change);
  let journal = input.journal;
  const last = journal.events.at(-1);
  const idempotencyKey = last?.eventType === 'prepared'
    ? last.idempotencyKey
    : canonicalDigest(
        'wukong/promotion-change-idempotency/v1',
        {
          journalId: input.journal.journalId,
          changeDigest: change.changeDigest,
          targetFencingTokenDigest:
            input.view.lease.fencingTokenDigest,
        },
      );
  if (last?.eventType !== 'prepared') {
    const observed = await observeStates(
      targetWorkspace,
      pathsFor(change),
    );
    journal = appendPromotionChangeEvent(journal, {
      eventId: randomUUID(),
      changeIndex: change.changeIndex,
      operation: change.operation,
      eventType: 'prepared',
      expectedPreimages: expected.preimages,
      expectedPostimages: expected.postimages,
      observedStates: observed,
      targetFencingTokenDigest:
        input.view.lease.fencingTokenDigest,
      idempotencyKey,
      occurredAt: timestamp(input.now?.() ?? new Date()),
    });
    journal = await input.journalStore.append(
      input.view,
      input.journal.journalHeadDigest,
      journal,
    );
  } else if (last.changeIndex !== change.changeIndex) {
    invalid(journal, 'Prepared Apply event does not match the next change.');
  }

  await input.view.assertAuthority();
  try {
    await recoverChange(
      targetWorkspace,
      change,
      idempotencyKey,
    );
  } catch (error) {
    throw new PromotionChangeApplyError(
      'promotion_apply_path_unsafe',
      journal.journalHeadDigest,
      'Promotion change transaction recovery requires reconciliation.',
      { cause: error },
    );
  }
  const observed = await observeStates(
    targetWorkspace,
    pathsFor(change),
  );
  if (sameStates(observed, expected.postimages)) {
    const reconciled = await appendOutcome(
      input,
      journal,
      change,
      expected,
      observed,
      'reconciled',
    );
    await finalizeCommittedChange(
      targetWorkspace,
      change,
      idempotencyKey,
      reconciled,
      input._testFaultCapability,
    );
    return reconciled;
  }
  if (!sameStates(observed, expected.preimages)) {
    const conflicted = await appendOutcome(
      input,
      journal,
      change,
      expected,
      observed,
      'conflict',
    );
    throw new PromotionChangeApplyError(
      'promotion_apply_conflict',
      conflicted.journalHeadDigest,
      'Target path state matches neither the expected preimage nor postimage.',
    );
  }

  try {
    await injectDurableBoundaryTestFault(
      input._testFaultCapability,
      'promotion_apply_before_target_mutation',
    );
    await applyChange(
      targetWorkspace,
      candidateWorkspace,
      change,
      idempotencyKey,
    );
    await injectDurableBoundaryTestFault(
      input._testFaultCapability,
      'promotion_apply_after_target_mutation',
    );
  } catch (error) {
    if (error instanceof PromotionChangeApplyError) throw error;
    throw new PromotionChangeApplyError(
      'promotion_apply_path_unsafe',
      journal.journalHeadDigest,
      'Promotion change could not be applied safely.',
      { cause: error },
    );
  }
  await input.view.assertAuthority();
  const after = await observeStates(
    targetWorkspace,
    pathsFor(change),
  );
  if (!sameStates(after, expected.postimages)) {
    const conflicted = await appendOutcome(
      input,
      journal,
      change,
      expected,
      after,
      'conflict',
    );
    throw new PromotionChangeApplyError(
      'promotion_apply_conflict',
      conflicted.journalHeadDigest,
      'Applied target path state does not match the expected postimage.',
    );
  }
  const applied = await appendOutcome(
    input,
    journal,
    change,
    expected,
    after,
    'applied',
  );
  await finalizeCommittedChange(
    targetWorkspace,
    change,
    idempotencyKey,
    applied,
    input._testFaultCapability,
  );
  return applied;
}

async function finalizeCommittedChange(
  targetWorkspace: TargetPromotionWorkspaceBackend,
  change: CandidateChangeV1,
  transactionId: string,
  journal: PromotionApplyJournalV1,
  testFaultCapability:
    DurableBoundaryTestFaultCapabilityV1 | undefined,
): Promise<void> {
  try {
    await injectDurableBoundaryTestFault(
      testFaultCapability,
      'promotion_apply_after_outcome_recorded',
    );
    await finalizeChange(targetWorkspace, change, transactionId);
  } catch (error) {
    throw new PromotionChangeApplyError(
      'promotion_apply_path_unsafe',
      journal.journalHeadDigest,
      'The durable Apply outcome could not finalize its private transaction receipt.',
      { cause: error },
    );
  }
}

async function appendOutcome(
  input: Parameters<typeof applyNextPromotionChange>[0],
  journal: PromotionApplyJournalV1,
  change: CandidateChangeV1,
  expected: {
    readonly preimages: readonly PromotionPathStateV1[];
    readonly postimages: readonly PromotionPathStateV1[];
  },
  observedStates: readonly PromotionPathStateV1[],
  eventType: 'applied' | 'reconciled' | 'conflict',
): Promise<PromotionApplyJournalV1> {
  const prepared = journal.events.at(-1);
  if (prepared?.eventType !== 'prepared') {
    invalid(journal, 'Apply outcome requires a prepared event.');
  }
  const next = appendPromotionChangeEvent(journal, {
    eventId: randomUUID(),
    changeIndex: change.changeIndex,
    operation: change.operation,
    eventType,
    expectedPreimages: expected.preimages,
    expectedPostimages: expected.postimages,
    observedStates,
    targetFencingTokenDigest:
      input.view.lease.fencingTokenDigest,
    idempotencyKey: prepared.idempotencyKey,
    occurredAt: timestamp(input.now?.() ?? new Date()),
  });
  return input.journalStore.append(
    input.view,
    journal.journalHeadDigest,
    next,
  );
}

function expectedStates(change: CandidateChangeV1): {
  readonly preimages: readonly PromotionPathStateV1[];
  readonly postimages: readonly PromotionPathStateV1[];
} {
  if (change.operation === 'create') {
    return {
      preimages: [absent(change.targetPath!)],
      postimages: [present(change.postimage!)],
    };
  }
  if (change.operation === 'delete') {
    return {
      preimages: [present(change.preimage!)],
      postimages: [absent(change.sourcePath!)],
    };
  }
  if (change.operation === 'rename') {
    return {
      preimages: [
        present(change.preimage!),
        absent(change.targetPath!),
      ],
      postimages: [
        absent(change.sourcePath!),
        present(change.postimage!),
      ],
    };
  }
  return {
    preimages: [present(change.preimage!)],
    postimages: [present(change.postimage!)],
  };
}

function present(
  entry: CandidateProjectionEntryV1,
): PromotionPathStateV1 {
  return createPromotionPathState({
    candidateRelativePath: entry.canonicalRelativePath,
    presence: 'present',
    fileType: 'regular',
    mode: entry.mode & 0o777,
    contentDigest: entry.contentDigest,
  });
}

function absent(path: string): PromotionPathStateV1 {
  return createPromotionPathState({
    candidateRelativePath: path,
    presence: 'absent',
    fileType: null,
    mode: null,
    contentDigest: null,
  });
}

function pathsFor(change: CandidateChangeV1): readonly string[] {
  return [...new Set([
    ...(change.sourcePath === null ? [] : [change.sourcePath]),
    ...(change.targetPath === null ? [] : [change.targetPath]),
  ])].toSorted();
}

async function observeStates(
  workspace: TargetPromotionWorkspaceBackend,
  paths: readonly string[],
): Promise<readonly PromotionPathStateV1[]> {
  const states: PromotionPathStateV1[] = [];
  for (const path of paths) {
    states.push(observePath(workspace, path));
  }
  return states;
}

function observePath(
  workspace: TargetPromotionWorkspaceBackend,
  relativePath: string,
): PromotionPathStateV1 {
  const observed = workspace.observe(relativePath);
  if (observed.presence === 'absent') return absent(relativePath);
  if (observed.fileType === 'regular') {
    return createPromotionPathState({
      candidateRelativePath: relativePath,
      presence: 'present',
      fileType: 'regular',
      mode: observed.mode,
      contentDigest: observed.contentDigest,
    });
  }
  return createPromotionPathState({
    candidateRelativePath: relativePath,
    presence: 'present',
    fileType: observed.fileType,
    mode: observed.mode,
    contentDigest: null,
  });
}

async function applyChange(
  targetWorkspace: TargetPromotionWorkspaceBackend,
  candidateWorkspace: TargetPromotionWorkspaceBackend,
  change: CandidateChangeV1,
  transactionId: string,
): Promise<void> {
  if (change.operation === 'delete') {
    await targetWorkspace.unlinkExact(
      change.preimage!,
      transactionId,
    );
    return;
  }
  if (change.operation === 'rename') {
    readCandidateEntry(candidateWorkspace, change.postimage!);
    await targetWorkspace.renameExact(
      change.preimage!,
      change.targetPath!,
      transactionId,
    );
    return;
  }
  if (change.operation === 'mode') {
    const postimage = change.postimage!;
    const bytes = readCandidateEntry(
      candidateWorkspace,
      postimage,
    );
    await targetWorkspace.replaceExact(
      postimage,
      bytes,
      change.preimage,
      transactionId,
    );
    return;
  }
  const postimage = change.postimage!;
  const bytes = readCandidateEntry(candidateWorkspace, postimage);
  await targetWorkspace.replaceExact(
    postimage,
    bytes,
    change.operation === 'create' ? null : change.preimage!,
    transactionId,
  );
}

async function recoverChange(
  targetWorkspace: TargetPromotionWorkspaceBackend,
  change: CandidateChangeV1,
  transactionId: string,
): Promise<void> {
  if (change.operation === 'delete') {
    await targetWorkspace.recoverDelete(
      change.preimage!,
      transactionId,
    );
    return;
  }
  if (change.operation === 'rename') {
    await targetWorkspace.recoverRename(
      change.preimage!,
      change.targetPath!,
      transactionId,
    );
    return;
  }
  await targetWorkspace.recoverReplace(
    change.postimage!,
    change.operation === 'create' ? null : change.preimage!,
    transactionId,
  );
}

async function finalizeChange(
  targetWorkspace: TargetPromotionWorkspaceBackend,
  change: CandidateChangeV1,
  transactionId: string,
): Promise<void> {
  if (change.operation === 'delete') {
    await targetWorkspace.finalizeDelete(
      change.preimage!,
      transactionId,
    );
    return;
  }
  if (change.operation === 'rename') {
    await targetWorkspace.finalizeRename(
      change.preimage!,
      change.targetPath!,
      transactionId,
    );
    return;
  }
  await targetWorkspace.finalizeReplace(
    change.postimage!,
    change.operation === 'create' ? null : change.preimage!,
    transactionId,
  );
}

function readCandidateEntry(
  workspace: TargetPromotionWorkspaceBackend,
  entry: CandidateProjectionEntryV1,
): Buffer {
  try {
    return workspace.readExact(entry);
  } catch (error) {
    throw new PromotionChangeApplyError(
      'promotion_apply_candidate_changed',
      null,
      'Candidate postimage changed before Target Apply.',
      { cause: error },
    );
  }
}

function nextChangeIndex(journal: PromotionApplyJournalV1): number {
  const last = journal.events.at(-1);
  if (last === undefined) return 0;
  return last.eventType === 'prepared'
    ? last.changeIndex
    : last.changeIndex + 1;
}

function sameStates(
  left: readonly PromotionPathStateV1[],
  right: readonly PromotionPathStateV1[],
): boolean {
  const sort = (states: readonly PromotionPathStateV1[]) =>
    [...states].toSorted((first, second) =>
      first.candidateRelativePath < second.candidateRelativePath
        ? -1
        : first.candidateRelativePath > second.candidateRelativePath
          ? 1
          : 0);
  return canonicalJson(sort(left)) === canonicalJson(sort(right));
}

function assertInput(
  input: Parameters<typeof applyNextPromotionChange>[0],
): void {
  if (!(input.journalStore instanceof PromotionApplyJournalStore)
    || !validatePromotionApplyJournal(input.journal)
    || !validateCandidateChangeManifest(input.manifest)
    || input.manifest.candidateId !== input.journal.candidateId
    || input.manifest.orderedChangeManifestDigest
      !== input.journal.orderedChangeManifestDigest
    || input.manifest.changes.length !== input.journal.changeCount
    || typeof input.view?.assertAuthority !== 'function'
    || input.view.lease.targetPromotionLeaseId
      !== input.journal.targetPromotionLeaseId
    || !isAbsolute(input.targetDirectory)
    || !isAbsolute(input.candidateDirectory)
    || (input.now !== undefined && typeof input.now !== 'function')
    || (input._testFaultCapability !== undefined
      && !validateDurableBoundaryTestFaultCapability(
        input._testFaultCapability,
      ))) {
    invalid(input.journal, 'Promotion change Apply input is invalid.');
  }
}

function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Promotion Apply time is invalid.');
  }
  return value.toISOString();
}

function invalid(
  journal: PromotionApplyJournalV1,
  message: string,
): never {
  throw new PromotionChangeApplyError(
    'promotion_apply_invalid_input',
    validatePromotionApplyJournal(journal)
      ? journal.journalHeadDigest
      : null,
    message,
  );
}
