import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
  acknowledgePromotionConsent,
  appendPromotionChangeEvent,
  canonicalDigest,
  completePromotionApplyJournal,
  createCandidateDelta,
  createCandidateProjection,
  createPromotionApplyJournal,
  createPromotionConsentProposal,
  createPromotionPathState,
  createTargetFinalGateAttemptResult,
  createTargetFinalGateEvidenceSnapshot,
  createTargetStateFingerprint,
  type CandidateChangeManifestV1,
  type CandidateProjectionEntryV1,
  type PromotionApplyJournalV1,
} from '@wukong/verification';

import {
  captureProcessLivenessProof,
} from '../../src/process-liveness-proof';
import {
  PromotionApplyJournalStore,
} from '../../src/promotion-apply-journal-store';
import {
  TargetCompletionSealStore,
} from '../../src/target-completion-seal-store';
import {
  TargetFinalGateAttemptStore,
  type TargetFinalGateAttemptStateV1,
} from '../../src/target-final-gate-attempt-store';
import {
  type TargetPromotionExclusiveLeaseViewV1,
  type TargetPromotionLeaseAuthorityV1,
  TargetPromotionLeaseStore,
} from '../../src/target-promotion-lease-store';

export const TARGET_SIGNAL_IDS = {
  promotion: '019f9100-0000-7abc-8def-0123456789ab',
  candidate: '019f9100-0001-7abc-8def-0123456789ab',
  candidateLease: '019f9100-0002-7abc-8def-0123456789ab',
  applyJournal: '019f9100-0003-7abc-8def-0123456789ab',
  applyEvent: '019f9100-0004-7abc-8def-0123456789ab',
  finalGateAttempt: '019f9100-0005-7abc-8def-0123456789ab',
  evidence: '019f9100-0006-7abc-8def-0123456789ab',
  completionSeal: '019f9100-0007-7abc-8def-0123456789ab',
} as const;

export const TARGET_SIGNAL_OWNER_RUN_ID = 'run_target_signal';
export const TARGET_SIGNAL_REDACTION_POLICY =
  'loop-output-redaction-1';

export type TargetDurableSignalBoundary =
  | 'apply_prepared'
  | 'final_gate_evidence'
  | 'completion_partial'
  | 'completion_sealed'
  | 'terminal_recorded';

interface SignalFixture {
  readonly root: string;
  readonly registryRoot: string;
  readonly targetDirectory: string;
  readonly candidateDirectory: string;
  readonly terminalRecordPath: string;
  readonly targetStore: TargetPromotionLeaseStore;
  readonly applying: TargetPromotionLeaseAuthorityV1;
  readonly finalVerifying:
    | TargetPromotionLeaseAuthorityV1
    | null;
  readonly manifest: CandidateChangeManifestV1;
  readonly journalStore: PromotionApplyJournalStore;
  readonly attemptStore: TargetFinalGateAttemptStore;
  readonly completionStore: TargetCompletionSealStore;
}

export async function createTargetDurableSignalFixture(input: {
  readonly root: string;
  readonly finalVerifying: boolean;
  readonly targetStore?: TargetPromotionLeaseStore;
}): Promise<SignalFixture> {
  const targetDirectory = join(input.root, 'target');
  const candidateDirectory = join(input.root, 'candidate');
  const registryRoot = join(input.root, 'registry');
  await Promise.all([
    mkdir(targetDirectory, { mode: 0o700 }),
    mkdir(candidateDirectory, { mode: 0o700 }),
  ]);
  await writePrivateFixtureFile(
    join(targetDirectory, 'update.txt'),
    'before\n',
  );
  await writePrivateFixtureFile(
    join(candidateDirectory, 'update.txt'),
    'after\n',
  );

  const bundle = createSignalCandidateDeltaBundle();
  const targetFingerprint = createTargetStateFingerprint({
    targetWorkspaceIdentity: signalDigest('workspace'),
    targetGitCommonDirIdentity: signalDigest('git-common'),
    headOid: 'a'.repeat(40),
    branchRef: 'refs/heads/main',
    branchRefDigest: signalDigest('branch'),
    indexDigest: signalDigest('index'),
    trackedWorkingDeltaDigest: null,
    untrackedProjectionDigest: signalDigest('untracked'),
    protectedRefsDigest: signalDigest('protected-refs'),
    sourceSnapshotDigest: signalDigest('source'),
    promotableContentDigest:
      bundle.delta.candidateWorkspaceDigest,
  });
  const proposal = createPromotionConsentProposal({
    promotionId: TARGET_SIGNAL_IDS.promotion,
    candidateId: TARGET_SIGNAL_IDS.candidate,
    candidateDeltaDigest: bundle.delta.candidateDeltaDigest,
    candidateGateResultDigest: signalDigest('candidate-gate'),
    sourceSnapshotDigest: signalDigest('source'),
    targetFingerprint,
    permissionDigest: signalDigest('permission'),
  });
  let tick = 0;
  const targetStore = input.targetStore
    ?? new TargetPromotionLeaseStore({
      registryRootDirectory: registryRoot,
      now: () => new Date(
        Date.parse('2026-07-29T18:00:00.000Z')
          + tick++ * 1_000,
      ),
    });
  const ownerProof = await captureProcessLivenessProof();
  const acquired = await targetStore.acquire({
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T17:59:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: TARGET_SIGNAL_OWNER_RUN_ID,
    ownerProcessIdentityDigest: ownerProof.proofDigest,
    ownerProcessLivenessProof: ownerProof,
  });
  const applying = await targetStore.transition(
    acquired.binding,
    'applying',
  );
  const finalVerifying = input.finalVerifying
    ? await targetStore.transition(
        applying.binding,
        'final_verifying',
      )
    : null;
  return {
    root: input.root,
    registryRoot,
    targetDirectory,
    candidateDirectory,
    terminalRecordPath: join(input.root, 'terminal.json'),
    targetStore,
    applying,
    finalVerifying,
    manifest: bundle.manifest,
    journalStore: new PromotionApplyJournalStore({
      now: () => new Date('2026-07-29T18:00:03.000Z'),
    }),
    attemptStore: new TargetFinalGateAttemptStore({
      now: () => new Date('2026-07-29T18:00:04.000Z'),
    }),
    completionStore: new TargetCompletionSealStore({
      now: () => new Date('2026-07-29T18:00:06.000Z'),
    }),
  };
}

export function createSignalApplyJournal(
  view: TargetPromotionExclusiveLeaseViewV1,
  manifest: CandidateChangeManifestV1,
  fencingTokenDigest = view.lease.fencingTokenDigest,
): PromotionApplyJournalV1 {
  return createPromotionApplyJournal({
    journalId: TARGET_SIGNAL_IDS.applyJournal,
    promotionId: view.lease.promotionId,
    targetPromotionLeaseId:
      view.lease.targetPromotionLeaseId,
    targetRegistryKey: view.lease.targetRegistryKey,
    createdByTargetFencingTokenDigest: fencingTokenDigest,
    candidateId: view.lease.candidateId,
    candidateDeltaDigest: view.lease.candidateDeltaDigest,
    orderedChangeManifestDigest:
      manifest.orderedChangeManifestDigest,
    changeCount: manifest.changes.length,
    targetBeforeFingerprintDigest:
      view.lease.acquiredFingerprintDigest,
    targetBeforeContentDigest: signalDigest('materialized'),
    materializedSourceDigest: signalDigest('materialized'),
    agentDeltaDigest: signalDigest('agent-delta'),
  });
}

export function createSignalCandidateDeltaBundle() {
  const baseline = createCandidateProjection({
    ...projectionBinding(),
    entries: [projectionEntry('update.txt', 'before\n')],
  });
  const candidate = createCandidateProjection({
    ...projectionBinding(),
    entries: [projectionEntry('update.txt', 'after\n')],
  });
  return createCandidateDelta(baseline, candidate);
}

export async function prepareSignalApplyJournal(input: {
  readonly view: TargetPromotionExclusiveLeaseViewV1;
  readonly journalStore: PromotionApplyJournalStore;
  readonly manifest: CandidateChangeManifestV1;
}): Promise<PromotionApplyJournalV1> {
  const initial = await input.journalStore.createOrLoad(
    input.view,
    createSignalApplyJournal(input.view, input.manifest),
  );
  const change = input.manifest.changes[0]!;
  const prepared = appendPromotionChangeEvent(initial, {
    eventId: TARGET_SIGNAL_IDS.applyEvent,
    changeIndex: change.changeIndex,
    operation: change.operation,
    eventType: 'prepared',
    expectedPreimages: [presentState(change.preimage!)],
    expectedPostimages: [presentState(change.postimage!)],
    observedStates: [presentState(change.preimage!)],
    targetFencingTokenDigest:
      input.view.lease.fencingTokenDigest,
    idempotencyKey: signalDigest('apply-idempotency'),
    occurredAt: '2026-07-29T18:00:03.000Z',
  });
  return input.journalStore.append(
    input.view,
    initial.journalHeadDigest,
    prepared,
  );
}

export function signalFinalGateInitializeInput(
  promotionJournalHeadDigest = signalDigest('journal-head'),
) {
  return {
    finalGateAttemptId: TARGET_SIGNAL_IDS.finalGateAttempt,
    runId: TARGET_SIGNAL_OWNER_RUN_ID,
    contractId: 'contract_target_signal',
    acceptanceContractDigest: signalDigest('contract'),
    gatePlanDigest: signalDigest('gate-plan'),
    criteriaSelectionDigest: signalDigest('criteria-selection'),
    sourceSnapshotDigest: signalDigest('source'),
    promotionJournalId: TARGET_SIGNAL_IDS.applyJournal,
    promotionJournalHeadDigest,
    targetAfterFingerprintDigest: signalDigest('target-after'),
  };
}

export function createSignalFinalGateEvidence(
  state: TargetFinalGateAttemptStateV1,
) {
  return createTargetFinalGateEvidenceSnapshot({
    evidenceSnapshotId: TARGET_SIGNAL_IDS.evidence,
    finalGateAttemptId: state.finalGateAttemptId,
    runId: state.runId,
    contractId: state.contractId,
    acceptanceContractDigest: state.acceptanceContractDigest,
    gatePlanDigest: state.gatePlanDigest,
    criteriaSelectionDigest: state.criteriaSelectionDigest,
    promotionId: state.promotionId,
    candidateId: state.candidateId,
    sourceSnapshotDigest: state.sourceSnapshotDigest,
    candidateDeltaDigest: state.candidateDeltaDigest,
    promotionJournalId: state.promotionJournalId,
    promotionJournalHeadDigest:
      state.promotionJournalHeadDigest,
    targetPromotionLeaseId: state.targetPromotionLeaseId,
    targetFencingTokenDigest:
      state.targetFencingTokenDigest,
    targetAfterFingerprintDigest:
      state.targetAfterFingerprintDigest,
    orderedCheckResults: [],
    builtinRiskScanResultDigest: signalDigest('risk'),
    builtinRiskScanStatus: 'clean',
    criteriaEvidenceDigest: signalDigest('criteria-evidence'),
    criteriaStatus: 'satisfied',
    freshReviewerResultDigest: signalDigest('reviewer'),
    freshReviewerStatus: 'PASS',
    finalGateCompletedAt: '2026-07-29T18:00:04.000Z',
  });
}

export async function prepareSignalCompletedGate(input: {
  readonly view: TargetPromotionExclusiveLeaseViewV1;
  readonly attemptStore: TargetFinalGateAttemptStore;
  readonly manifest: CandidateChangeManifestV1;
  readonly journalFencingTokenDigest?: string;
}): Promise<{
  readonly journal: PromotionApplyJournalV1;
  readonly completed: TargetFinalGateAttemptStateV1;
}> {
  const journal = completePromotionApplyJournal(
    createSignalApplyJournal(
      input.view,
      {
        ...input.manifest,
        changes: [],
        orderedChangeManifestDigest:
          signalDigest('empty-change-manifest'),
      },
      input.journalFencingTokenDigest,
    ),
    signalDigest('target-after'),
  );
  const prepared = await input.attemptStore.initialize(
    input.view,
    signalFinalGateInitializeInput(journal.journalHeadDigest),
  );
  if (prepared.state === 'completed') {
    return { journal, completed: prepared };
  }
  const evidence = prepared.state === 'evidence_recorded'
    ? prepared.evidence!
    : createSignalFinalGateEvidence(prepared);
  const recorded = prepared.state === 'evidence_recorded'
    ? prepared
    : await input.attemptStore.recordEvidence(
        input.view,
        prepared,
        evidence,
      );
  const completed = await input.attemptStore.complete(
    input.view,
    recorded,
    createTargetFinalGateAttemptResult({
      evidence,
      requestedOutcome: 'PASS',
      reasonCode: 'target_final_gate_passed',
      blockerKeys: [],
      completedAt: '2026-07-29T18:00:05.000Z',
    }),
  );
  return { journal, completed };
}

export function targetCompletionDirectory(
  root: string,
  targetRegistryKey: string,
): string {
  return join(
    root,
    'registry',
    targetRegistryKey.slice('sha256:'.length),
    'target-completions',
    TARGET_SIGNAL_IDS.completionSeal,
  );
}

export function signalDigest(label: string): string {
  return canonicalDigest(
    'wukong/test/target-durable-hard-signal/v1',
    label,
  );
}

function projectionBinding() {
  return {
    candidateId: TARGET_SIGNAL_IDS.candidate,
    leaseId: TARGET_SIGNAL_IDS.candidateLease,
    sourceSnapshotDigest: signalDigest('source'),
    materializedSourceDigest: signalDigest('materialized'),
    bootstrapPlanDigest: signalDigest('bootstrap'),
    generatedScopesDigest: signalDigest('generated'),
  };
}

function projectionEntry(
  canonicalRelativePath: string,
  content: string,
) {
  return {
    canonicalRelativePath,
    mode: 0o100644 as const,
    sizeBytes: Buffer.byteLength(content),
    contentDigest: contentDigest(content),
  };
}

function presentState(
  entry: CandidateProjectionEntryV1,
) {
  return createPromotionPathState({
    candidateRelativePath: entry.canonicalRelativePath,
    presence: 'present',
    fileType: 'regular',
    mode: entry.mode & 0o777,
    contentDigest: entry.contentDigest,
  });
}

function contentDigest(content: string): string {
  return `sha256:${createHash('sha256')
    .update('wukong/candidate-projection-file/v1')
    .update('\0')
    .update(content)
    .digest('hex')}`;
}

async function writePrivateFixtureFile(
  path: string,
  content: string,
): Promise<void> {
  await writeFile(path, content, { mode: 0o644 });
  if (process.platform !== 'win32') await chmod(path, 0o644);
}
