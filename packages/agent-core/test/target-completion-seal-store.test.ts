import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgePromotionConsent,
  buildFinishLine,
  canonicalDigest,
  canonicalJson,
  completePromotionApplyJournal,
  createPromotionApplyJournal,
  createPromotionConsentProposal,
  createTargetFinalGateAttemptResult,
  createTargetFinalGateEvidenceSnapshot,
  createTargetStateFingerprint,
  isTerminalPassCompletionSeal,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import type { Agent } from '../src/agent';
import {
  GoalMode,
  type GoalChange,
  type GoalSnapshot,
} from '../src/agent/goal';
import type {
  AgentRecord,
} from '../src/agent/records';
import {
  requireValidatedTargetCompletionSeal,
  TargetCompletionSealStore,
  TargetCompletionSealStoreError,
  type TargetCompletionSealAuthorizationV1,
} from '../src/target-completion-seal-store';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  TargetFinalGateAttemptStore,
} from '../src/target-final-gate-attempt-store';
import {
  TargetLoopTerminalFinalizer,
} from '../src/target-loop-terminal-finalizer';
import {
  type TargetPromotionLeaseBindingV1,
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';

const PROMOTION_ID = '019f8d40-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8d40-0001-7abc-8def-0123456789ab';
const JOURNAL_ID = '019f8d40-0002-7abc-8def-0123456789ab';
const ATTEMPT_ID = '019f8d40-0003-7abc-8def-0123456789ab';
const EVIDENCE_ID = '019f8d40-0004-7abc-8def-0123456789ab';
const SEAL_ID = '019f8d40-0005-7abc-8def-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('TargetCompletionSealStore', () => {
  it('resumes partial artifacts, seals, reopens, and rejects byte tampering', async () => {
    const value = await fixture();
    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const { journal, completed } =
          await prepareCompletedGate(value, view);
        const paths = value.paths(view.lease.targetRegistryKey);
        await mkdir(paths.directory, {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(paths.journal, canonicalJson(journal), {
          mode: 0o600,
        });
        const seal = await value.completionStore.sealAndReopen(
          view,
          {
            completionSealId: SEAL_ID,
            journal,
            finalGateState: completed,
            redactionPolicyVersion: 'loop-output-redaction-1',
          },
        );
        expect(isTerminalPassCompletionSeal(seal)).toBe(true);
        await expect(value.completionStore.inspectAndValidate(
          view,
          SEAL_ID,
          seal.completionSealDigest,
        )).resolves.toEqual(seal);
        let escaped:
          | TargetCompletionSealAuthorizationV1
          | undefined;
        await value.completionStore.withValidatedTerminalSeal(
          view,
          {
            completionSealId: SEAL_ID,
            expectedSealDigest: seal.completionSealDigest,
          },
          (authorization) => {
            escaped = authorization;
            expect(requireValidatedTargetCompletionSeal(
              authorization,
            )).toEqual(seal);
          },
        );
        const escapedAuthorization = escaped;
        if (escapedAuthorization === undefined) {
          throw new Error('Completion authorization did not run.');
        }
        expect(() => requireValidatedTargetCompletionSeal(
          escapedAuthorization,
        ))
          .toThrow(/expired/u);

        const attempt = JSON.parse(
          await readFile(paths.attempt, 'utf8'),
        ) as { reasonCode: string };
        attempt.reasonCode = 'tampered';
        await writeFile(
          paths.attempt,
          JSON.stringify(attempt),
          { mode: 0o600 },
        );
        await expect(value.completionStore.inspectAndValidate(
          view,
          SEAL_ID,
        )).rejects.toBeInstanceOf(TargetCompletionSealStoreError);
      },
    );
  });

  it('rejects credential-shaped seal metadata before writing any completion artifact', async () => {
    const value = await fixture();
    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const { journal, completed } =
          await prepareCompletedGate(value, view);
        await expect(value.completionStore.sealAndReopen(
          view,
          {
            completionSealId: SEAL_ID,
            journal,
            finalGateState: completed,
            redactionPolicyVersion:
              'sk_live_wukongPrivacySentinel123456789',
          },
        )).rejects.toMatchObject({
          reasonCode: 'target_completion_invalid_input',
        });
        await expect(access(
          value.paths(view.lease.targetRegistryKey).directory,
        )).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });

  it('retries the exact terminal join after a release failure without creating another terminal', async () => {
    const value = await fixture();
    const seal = await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const { journal, completed } =
          await prepareCompletedGate(value, view);
        return value.completionStore.sealAndReopen(view, {
          completionSealId: SEAL_ID,
          journal,
          finalGateState: completed,
          redactionPolicyVersion: 'loop-output-redaction-1',
        });
      },
    );
    let durableTerminal:
      | {
          readonly runId: string;
          readonly contractId: string;
          readonly status: 'PASS';
          readonly targetCompletionSealDigest: string;
        }
      | undefined;
    let terminalWrites = 0;
    const recorder = {
      recordIsolatedLoopTerminal: (
        input: {
          readonly completionAuthorization:
            TargetCompletionSealAuthorizationV1;
        },
      ) => {
        const authorized = requireValidatedTargetCompletionSeal(
          input.completionAuthorization,
        );
        if (durableTerminal === undefined) {
          terminalWrites += 1;
          durableTerminal = {
            runId: authorized.runId,
            contractId: authorized.contractId,
            status: 'PASS',
            targetCompletionSealDigest:
              authorized.completionSealDigest,
          };
        }
        return durableTerminal;
      },
    };
    value.targetStore.failNextRelease();
    const finalizer = new TargetLoopTerminalFinalizer();
    const commit = () => finalizer.commit({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: value.finalVerifying.binding,
      completionSealStore: value.completionStore,
      completionSealId: seal.completionSealId,
      expectedCompletionSealDigest: seal.completionSealDigest,
      terminalRecorder: recorder,
    });

    await expect(commit()).rejects.toThrow('injected release failure');
    expect(terminalWrites).toBe(1);
    await expect(value.targetStore.inspect(
      value.finalVerifying.lease.targetRegistryKey,
    )).resolves.toMatchObject({ state: 'final_verifying' });

    const retried = await commit();
    expect(terminalWrites).toBe(1);
    expect(retried).toMatchObject({
      terminal: {
        runId: 'run_completion',
        contractId: 'contract_completion',
        status: 'PASS',
        targetCompletionSealDigest: seal.completionSealDigest,
      },
      releasedAuthority: {
        lease: { state: 'released' },
      },
    });
  });

  it('commits one authentic Goal terminal and replays the exact completion-seal join', async () => {
    const goal = makeGoalRecorder();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Commit one isolated Loop terminal',
      completionCriterion: 'The target completion seal is durable',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    const created = await goal.goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion:
        finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
        objective: finishLine.proposal.objective,
        completionCriterion:
          finishLine.proposal.completionCriterion,
        constraints: finishLine.proposal.constraints,
        finishLineReview: {
          ...finishLine.proposal.finishLineReview,
          acknowledgedWarningIds:
            finishLine.proposal.finishLineReview.warnings.map(
              (warning) => warning.id,
            ),
        },
        workspaceIdentity: finishLine.proposal.workspaceIdentity,
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        source: 'user',
      },
    });
    const contractRecord = goal.records.find(
      (record) => record.type === 'goal.contract.create',
    );
    if (created.loopRunId === undefined
      || contractRecord?.type !== 'goal.contract.create'
      || contractRecord.contract.schemaVersion === 1) {
      throw new Error('Authentic Goal terminal fixture is incomplete.');
    }
    const contract = contractRecord.contract;
    const runId = created.loopRunId;
    const value = await fixture();
    const seal = await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const { journal, completed } =
          await prepareCompletedGate(value, view, {
            runId,
            contractId: contract.contractId,
          });
        return value.completionStore.sealAndReopen(view, {
          completionSealId: SEAL_ID,
          journal,
          finalGateState: completed,
          redactionPolicyVersion: 'loop-output-redaction-1',
        });
      },
    );
    const committed = await new TargetLoopTerminalFinalizer()
      .commit({
        targetPromotionLeaseStore: value.targetStore,
        targetPromotionBinding: value.finalVerifying.binding,
        completionSealStore: value.completionStore,
        completionSealId: seal.completionSealId,
        expectedCompletionSealDigest: seal.completionSealDigest,
        terminalRecorder: goal.goals,
      });
    expect(committed.terminal).toMatchObject({
      runId,
      contractId: contract.contractId,
      status: 'PASS',
      targetCompletionSealDigest: seal.completionSealDigest,
    });
    const sealRecordIndex = goal.records.findIndex(
      (record) =>
        record.type === 'loop.target-completion-seal.create',
    );
    const terminalRecordIndex = goal.records.findIndex(
      (record) => record.type === 'loop.run.terminal',
    );
    expect(sealRecordIndex).toBeGreaterThanOrEqual(0);
    expect(terminalRecordIndex).toBeGreaterThan(sealRecordIndex);

    const replayed = makeGoalRecorder().goals;
    for (const record of goal.records) {
      replayGoalTerminalRecord(replayed, record);
    }
    expect(replayed.getGoal().goal).toMatchObject({
      loopRunId: runId,
      loopTerminal: {
        status: 'PASS',
        targetCompletionSealDigest: seal.completionSealDigest,
      },
    });
  });

  it('seals durable completed evidence after final owner adoption', async () => {
    const value = await fixture();
    const old = await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      (view) => prepareCompletedGate(value, view),
    );
    const adopted = await value.targetStore.adoptFinalVerifying({
      targetRegistryKey:
        value.finalVerifying.lease.targetRegistryKey,
      ownerRunId: value.finalVerifying.lease.ownerRunId,
      expectedLeaseDigest:
        value.finalVerifying.lease.leaseDigest,
      nextProcessLivenessProof:
        await proof(84, 'next-process'),
    });

    const seal = await value.targetStore.withExclusiveLease(
      adopted.binding,
      'final_verifying',
      async (view) => {
        const completed = await value.attemptStore.initialize(
          view,
          {
            finalGateAttemptId: ATTEMPT_ID,
            runId: 'run_completion',
            contractId: 'contract_completion',
            acceptanceContractDigest: digest('contract'),
            gatePlanDigest: digest('gate-plan'),
            criteriaSelectionDigest: digest('criteria'),
            sourceSnapshotDigest: digest('source'),
            promotionJournalId: JOURNAL_ID,
            promotionJournalHeadDigest:
              old.journal.journalHeadDigest,
            targetAfterFingerprintDigest: digest('target-after'),
          },
        );
        return value.completionStore.sealAndReopen(view, {
          completionSealId: SEAL_ID,
          journal: old.journal,
          finalGateState: completed,
          redactionPolicyVersion: 'loop-output-redaction-1',
        });
      },
    );

    expect(seal).toMatchObject({
      finalGateOutcome: 'PASS',
      targetFencingTokenDigest:
        adopted.lease.fencingTokenDigest,
    });
  });

  it('revalidates a historical seal and joins terminal after owner death', async () => {
    const value = await fixture();
    let journal:
      Awaited<ReturnType<typeof prepareCompletedGate>>['journal']
      | undefined;
    const originalSeal = await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const completed = await prepareCompletedGate(value, view);
        journal = completed.journal;
        return value.completionStore.sealAndReopen(view, {
          completionSealId: SEAL_ID,
          journal: completed.journal,
          finalGateState: completed.completed,
          redactionPolicyVersion: 'loop-output-redaction-1',
        });
      },
    );
    if (journal === undefined) {
      throw new Error('Historical journal was not captured.');
    }
    const historicalJournal = journal;
    const adopted = await value.targetStore.adoptFinalVerifying({
      targetRegistryKey:
        value.finalVerifying.lease.targetRegistryKey,
      ownerRunId: value.finalVerifying.lease.ownerRunId,
      expectedLeaseDigest:
        value.finalVerifying.lease.leaseDigest,
      nextProcessLivenessProof:
        await proof(84, 'next-process'),
    });
    await value.targetStore.withExclusiveLease(
      adopted.binding,
      'final_verifying',
      async (view) => {
        const completed = await value.attemptStore.initialize(
          view,
          {
            finalGateAttemptId: ATTEMPT_ID,
            runId: 'run_completion',
            contractId: 'contract_completion',
            acceptanceContractDigest: digest('contract'),
            gatePlanDigest: digest('gate-plan'),
            criteriaSelectionDigest: digest('criteria'),
            sourceSnapshotDigest: digest('source'),
            promotionJournalId: JOURNAL_ID,
            promotionJournalHeadDigest:
              historicalJournal.journalHeadDigest,
            targetAfterFingerprintDigest: digest('target-after'),
          },
        );
        await expect(value.completionStore.sealAndReopen(view, {
          completionSealId: SEAL_ID,
          journal: historicalJournal,
          finalGateState: completed,
          redactionPolicyVersion: 'loop-output-redaction-1',
        })).resolves.toEqual(originalSeal);
      },
    );
    const committed = await new TargetLoopTerminalFinalizer().commit({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: adopted.binding,
      completionSealStore: value.completionStore,
      completionSealId: SEAL_ID,
      expectedCompletionSealDigest:
        originalSeal.completionSealDigest,
      terminalRecorder: {
        recordIsolatedLoopTerminal: ({ completionAuthorization }) => {
          const seal = requireValidatedTargetCompletionSeal(
            completionAuthorization,
          );
          return {
            runId: seal.runId,
            contractId: seal.contractId,
            status: seal.finalGateOutcome,
            targetCompletionSealDigest:
              seal.completionSealDigest,
          };
        },
      },
    });
    expect(committed.releasedAuthority.lease.state).toBe('released');
  });
});

type CompletionFixture = Awaited<ReturnType<typeof fixture>>;
type ExclusiveLeaseView = Parameters<
  Parameters<TargetPromotionLeaseStore['withExclusiveLease']>[2]
>[0];

async function prepareCompletedGate(
  value: CompletionFixture,
  view: ExclusiveLeaseView,
  binding?: {
    readonly runId?: string;
    readonly contractId?: string;
  },
) {
  const journal = completePromotionApplyJournal(
    createPromotionApplyJournal({
      journalId: JOURNAL_ID,
      promotionId: view.lease.promotionId,
      targetPromotionLeaseId:
        view.lease.targetPromotionLeaseId,
      targetRegistryKey: view.lease.targetRegistryKey,
      createdByTargetFencingTokenDigest:
        view.lease.fencingTokenDigest,
      candidateId: view.lease.candidateId,
      candidateDeltaDigest: view.lease.candidateDeltaDigest,
      orderedChangeManifestDigest: digest('manifest'),
      changeCount: 0,
      targetBeforeFingerprintDigest:
        view.lease.acquiredFingerprintDigest,
      targetBeforeContentDigest: digest('source-content'),
      materializedSourceDigest: digest('source-content'),
      agentDeltaDigest: digest('agent-delta'),
    }),
    digest('target-after'),
  );
  const prepared = await value.attemptStore.initialize(view, {
    finalGateAttemptId: ATTEMPT_ID,
    runId: binding?.runId ?? 'run_completion',
    contractId: binding?.contractId ?? 'contract_completion',
    acceptanceContractDigest: digest('contract'),
    gatePlanDigest: digest('gate-plan'),
    criteriaSelectionDigest: digest('criteria'),
    sourceSnapshotDigest: digest('source'),
    promotionJournalId: JOURNAL_ID,
    promotionJournalHeadDigest: journal.journalHeadDigest,
    targetAfterFingerprintDigest: digest('target-after'),
  });
  const evidence = createTargetFinalGateEvidenceSnapshot({
    evidenceSnapshotId: EVIDENCE_ID,
    finalGateAttemptId: prepared.finalGateAttemptId,
    runId: prepared.runId,
    contractId: prepared.contractId,
    acceptanceContractDigest:
      prepared.acceptanceContractDigest,
    gatePlanDigest: prepared.gatePlanDigest,
    criteriaSelectionDigest:
      prepared.criteriaSelectionDigest,
    promotionId: prepared.promotionId,
    candidateId: prepared.candidateId,
    sourceSnapshotDigest: prepared.sourceSnapshotDigest,
    candidateDeltaDigest: prepared.candidateDeltaDigest,
    promotionJournalId: prepared.promotionJournalId,
    promotionJournalHeadDigest:
      prepared.promotionJournalHeadDigest,
    targetPromotionLeaseId:
      prepared.targetPromotionLeaseId,
    targetFencingTokenDigest:
      prepared.targetFencingTokenDigest,
    targetAfterFingerprintDigest:
      prepared.targetAfterFingerprintDigest,
    orderedCheckResults: [],
    builtinRiskScanResultDigest: digest('risk'),
    builtinRiskScanStatus: 'clean',
    criteriaEvidenceDigest: digest('criteria-evidence'),
    criteriaStatus: 'satisfied',
    freshReviewerResultDigest: digest('reviewer'),
    freshReviewerStatus: 'PASS',
    finalGateCompletedAt: '2026-07-29T16:20:01.000Z',
  });
  const recorded = await value.attemptStore.recordEvidence(
    view,
    prepared,
    evidence,
  );
  const completed = await value.attemptStore.complete(
    view,
    recorded,
    createTargetFinalGateAttemptResult({
      evidence,
      requestedOutcome: 'PASS',
      reasonCode: 'target_gate_passed',
      blockerKeys: [],
      completedAt: '2026-07-29T16:20:02.000Z',
    }),
  );
  return { journal, completed };
}

function makeGoalRecorder() {
  const records: AgentRecord[] = [];
  const agent = {
    records: {
      logRecord: (record: AgentRecord) => {
        records.push(record);
      },
    },
    emitEvent: (_event: {
      readonly type: string;
      readonly snapshot?: GoalSnapshot | null;
      readonly change?: GoalChange;
    }) => {},
    telemetry: {
      track: (_event: string, _properties: unknown) => {},
    },
    context: {
      appendSystemReminder: (
        _content: string,
        _origin: unknown,
      ) => {},
    },
    replayBuilder: {
      push: (_record: unknown) => {},
    },
    config: {
      cwd: process.cwd(),
      modelAlias: 'writer-model',
    },
    permission: {
      mode: 'manual',
    },
  } as unknown as Agent;
  return { goals: new GoalMode(agent), records };
}

function replayGoalTerminalRecord(
  goals: GoalMode,
  record: AgentRecord,
): void {
  if (record.type === 'goal.create') {
    goals.restoreCreate(record);
  } else if (record.type === 'goal.contract.create') {
    goals.restoreContractCreate(record);
  } else if (record.type === 'loop.run.create') {
    goals.restoreLoopRunCreate(record);
  } else if (
    record.type === 'loop.target-completion-seal.create'
  ) {
    goals.restoreTargetCompletionSeal(record);
  } else if (record.type === 'loop.run.terminal') {
    goals.restoreLoopRunTerminal(record);
  }
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-completion-'));
  roots.push(parent);
  const registryRoot = join(parent, 'registry');
  const targetFingerprint = createTargetStateFingerprint({
    targetWorkspaceIdentity: digest('workspace'),
    targetGitCommonDirIdentity: digest('git'),
    headOid: 'a'.repeat(40),
    branchRef: 'refs/heads/main',
    branchRefDigest: digest('branch'),
    indexDigest: digest('index'),
    trackedWorkingDeltaDigest: null,
    untrackedProjectionDigest: digest('untracked'),
    protectedRefsDigest: digest('refs'),
    sourceSnapshotDigest: digest('source'),
    promotableContentDigest: digest('content'),
  });
  const proposal = createPromotionConsentProposal({
    promotionId: PROMOTION_ID,
    candidateId: CANDIDATE_ID,
    candidateDeltaDigest: digest('delta'),
    candidateGateResultDigest: digest('candidate-gate'),
    sourceSnapshotDigest: digest('source'),
    targetFingerprint,
    permissionDigest: digest('permission'),
  });
  const targetStore = new FailOnceReleaseTargetPromotionLeaseStore({
    registryRootDirectory: registryRoot,
    now: () => new Date('2026-07-29T16:20:00.000Z'),
    probeLiveness: () => Promise.resolve('dead'),
  });
  const ownerProcessLivenessProof =
    await proof(42, 'old-process');
  const acquired = await targetStore.acquire({
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T16:19:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: 'run_completion',
    ownerProcessIdentityDigest:
      ownerProcessLivenessProof.proofDigest,
    ownerProcessLivenessProof,
  });
  const applying = await targetStore.transition(
    acquired.binding,
    'applying',
  );
  const finalVerifying = await targetStore.transition(
    applying.binding,
    'final_verifying',
  );
  const completionDirectory = (key: string) => join(
    registryRoot,
    key.slice('sha256:'.length),
    'target-completions',
    SEAL_ID,
  );
  return {
    targetStore,
    finalVerifying,
    attemptStore: new TargetFinalGateAttemptStore({
      now: () => new Date('2026-07-29T16:20:03.000Z'),
    }),
    completionStore: new TargetCompletionSealStore({
      now: () => new Date('2026-07-29T16:20:04.000Z'),
    }),
    paths: (key: string) => ({
      directory: completionDirectory(key),
      journal: join(completionDirectory(key), 'journal.json'),
      attempt: join(completionDirectory(key), 'attempt.json'),
    }),
  };
}

function proof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

class FailOnceReleaseTargetPromotionLeaseStore
  extends TargetPromotionLeaseStore {
  private releaseFailurePending = false;

  failNextRelease(): void {
    this.releaseFailurePending = true;
  }

  override async transition(
    binding: TargetPromotionLeaseBindingV1,
    toState: Parameters<TargetPromotionLeaseStore['transition']>[1],
  ): ReturnType<TargetPromotionLeaseStore['transition']> {
    if (toState === 'released' && this.releaseFailurePending) {
      this.releaseFailurePending = false;
      throw new Error('injected release failure');
    }
    return super.transition(binding, toState);
  }
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/completion-store/v1', label);
}
