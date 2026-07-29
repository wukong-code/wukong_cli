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
  canonicalDigest,
  canonicalJson,
  createPromotionConsentProposal,
  createTargetFinalGateAttemptResult,
  createTargetFinalGateCheckResultRef,
  createTargetFinalGateEvidenceSnapshot,
  createTargetStateFingerprint,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TargetFinalGateAttemptStore,
  TargetFinalGateAttemptStoreError,
} from '../src/target-final-gate-attempt-store';
import {
  TargetFinalGateOrchestrator,
} from '../src/target-final-gate-orchestrator';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';

const PROMOTION_ID = '019f8d30-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8d30-0001-7abc-8def-0123456789ab';
const ATTEMPT_ID = '019f8d30-0002-7abc-8def-0123456789ab';
const JOURNAL_ID = '019f8d30-0003-7abc-8def-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('TargetFinalGateAttemptStore', () => {
  it('persists exact evidence/result with idempotent CAS retries', async () => {
    const value = await fixture();
    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const prepared = await value.attemptStore.initialize(
          view,
          initializeInput(),
        );
        const evidence = evidenceFor(prepared);
        const recorded = await value.attemptStore.recordEvidence(
          view,
          prepared,
          evidence,
        );
        const result = createTargetFinalGateAttemptResult({
          evidence,
          requestedOutcome: 'PASS',
          reasonCode: 'target_gate_passed',
          blockerKeys: [],
          completedAt: '2026-07-29T16:10:02.000Z',
        });
        const completed = await value.attemptStore.complete(
          view,
          recorded,
          result,
        );

        expect(completed).toMatchObject({
          state: 'completed',
          casRevision: 2,
          result: { outcome: 'PASS' },
        });
        await expect(value.attemptStore.complete(
          view,
          recorded,
          result,
        )).resolves.toMatchObject({
          stateDigest: completed.stateDigest,
        });
      },
    );
  });

  it('repairs one event-ahead state and fails closed on event tampering', async () => {
    const value = await fixture();
    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const prepared = await value.attemptStore.initialize(
          view,
          initializeInput(),
        );
        const evidence = evidenceFor(prepared);
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
            requestedOutcome: 'ERROR',
            reasonCode: 'reviewer_runtime_error',
            blockerKeys: [],
            completedAt: '2026-07-29T16:10:02.000Z',
          }),
        );
        const paths = value.paths(
          view.lease.targetRegistryKey,
        );
        await writeFile(paths.state, canonicalJson(recorded), {
          mode: 0o600,
        });
        await expect(value.attemptStore.inspect(view, ATTEMPT_ID))
          .resolves.toMatchObject({
            stateDigest: completed.stateDigest,
          });
        const event = JSON.parse(
          await readFile(paths.completedEvent, 'utf8'),
        ) as { eventDigest: string };
        event.eventDigest = digest('tampered-event');
        await writeFile(
          paths.completedEvent,
          JSON.stringify(event),
          { mode: 0o600 },
        );
        await expect(value.attemptStore.inspect(view, ATTEMPT_ID))
          .rejects.toBeInstanceOf(TargetFinalGateAttemptStoreError);
      },
    );
  });

  it('runs the evidence producer once and resumes an exact completed attempt', async () => {
    const value = await fixture();
    let producerCalls = 0;
    const orchestrator = new TargetFinalGateOrchestrator({
      now: () => new Date('2026-07-29T16:10:02.000Z'),
    });
    const run = () => orchestrator.run({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: value.finalVerifying.binding,
      attemptStore: value.attemptStore,
      initialize: initializeInput(),
      evidenceProducer: {
        produce: ({ preparedAttempt }) => {
          producerCalls += 1;
          return Promise.resolve(evidenceFor(preparedAttempt));
        },
      },
    });

    const completed = await run();
    expect(completed).toMatchObject({
      state: 'completed',
      result: {
        outcome: 'PASS',
        reasonCode: 'target_final_gate_passed',
      },
    });
    await expect(run()).resolves.toMatchObject({
      stateDigest: completed.stateDigest,
    });
    expect(producerCalls).toBe(1);
  });

  it('keeps cancellation before evidence non-terminal and resumes the exact attempt', async () => {
    const value = await fixture();
    const orchestrator = new TargetFinalGateOrchestrator({
      now: () => new Date('2026-07-29T16:10:02.000Z'),
    });
    const cancelled = new DOMException(
      'Target Final Gate cancelled',
      'AbortError',
    );

    await expect(orchestrator.run({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: value.finalVerifying.binding,
      attemptStore: value.attemptStore,
      initialize: initializeInput(),
      evidenceProducer: {
        produce: () => Promise.reject(cancelled),
      },
    })).rejects.toBe(cancelled);

    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        await expect(value.attemptStore.inspect(view, ATTEMPT_ID))
          .resolves.toMatchObject({
            state: 'prepared',
            evidence: null,
            result: null,
          });
      },
    );

    await expect(orchestrator.run({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: value.finalVerifying.binding,
      attemptStore: value.attemptStore,
      initialize: initializeInput(),
      evidenceProducer: {
        produce: ({ preparedAttempt }) =>
          Promise.resolve(evidenceFor(preparedAttempt)),
      },
    })).resolves.toMatchObject({
      state: 'completed',
      result: { outcome: 'PASS' },
    });
  });

  it('resumes after durable evidence without invoking the producer again', async () => {
    const value = await fixture();
    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const prepared = await value.attemptStore.initialize(
          view,
          initializeInput(),
        );
        await value.attemptStore.recordEvidence(
          view,
          prepared,
          evidenceFor(prepared),
        );
      },
    );
    const producer = {
      produce: () => Promise.reject(
        new Error('producer must not rerun after durable evidence'),
      ),
    };

    await expect(new TargetFinalGateOrchestrator({
      now: () => new Date('2026-07-29T16:10:02.000Z'),
    }).run({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: value.finalVerifying.binding,
      attemptStore: value.attemptStore,
      initialize: initializeInput(),
      evidenceProducer: producer,
    })).resolves.toMatchObject({
      state: 'completed',
      result: {
        outcome: 'PASS',
        reasonCode: 'target_final_gate_passed',
      },
    });
  });

  it('adopts durable evidence after the final-verifying owner dies', async () => {
    const value = await fixture();
    let oldFencing = '';
    await value.targetStore.withExclusiveLease(
      value.finalVerifying.binding,
      'final_verifying',
      async (view) => {
        oldFencing = view.lease.fencingTokenDigest;
        const prepared = await value.attemptStore.initialize(
          view,
          initializeInput(),
        );
        await value.attemptStore.recordEvidence(
          view,
          prepared,
          evidenceFor(prepared),
        );
      },
    );
    const nextProof = await proof(84, 'next-process');
    const adopted = await value.targetStore.adoptFinalVerifying({
      targetRegistryKey:
        value.finalVerifying.lease.targetRegistryKey,
      ownerRunId: value.finalVerifying.lease.ownerRunId,
      expectedLeaseDigest:
        value.finalVerifying.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });

    const completed = await new TargetFinalGateOrchestrator({
      now: () => new Date('2026-07-29T16:10:04.000Z'),
    }).run({
      targetPromotionLeaseStore: value.targetStore,
      targetPromotionBinding: adopted.binding,
      attemptStore: value.attemptStore,
      initialize: initializeInput(),
      evidenceProducer: {
        produce: () => Promise.reject(
          new Error('durable evidence must not rerun'),
        ),
      },
    });

    expect(completed).toMatchObject({
      state: 'completed',
      createdByTargetFencingTokenDigest: oldFencing,
      targetFencingTokenDigest:
        adopted.lease.fencingTokenDigest,
      targetFencingTokenLineage: [
        oldFencing,
        adopted.lease.fencingTokenDigest,
      ],
      evidence: { targetFencingTokenDigest: oldFencing },
      result: { targetFencingTokenDigest: oldFencing },
    });
  });
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-final-gate-'));
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
  const targetStore = new TargetPromotionLeaseStore({
    registryRootDirectory: registryRoot,
    now: () => new Date('2026-07-29T16:10:00.000Z'),
    probeLiveness: () => Promise.resolve('dead'),
  });
  const ownerProcessLivenessProof =
    await proof(42, 'old-process');
  const acquired = await targetStore.acquire({
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T16:09:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: 'run_final_gate',
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
  const directory = (key: string) => join(
    registryRoot,
    key.slice('sha256:'.length),
    'target-final-gate-attempts',
    ATTEMPT_ID,
  );
  return {
    targetStore,
    finalVerifying,
    attemptStore: new TargetFinalGateAttemptStore({
      now: () => new Date('2026-07-29T16:10:03.000Z'),
    }),
    paths: (key: string) => ({
      state: join(directory(key), 'attempt.json'),
      completedEvent: join(
        directory(key),
        'events',
        '000000000002.json',
      ),
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

function initializeInput() {
  return {
    finalGateAttemptId: ATTEMPT_ID,
    runId: 'run_final_gate',
    contractId: 'contract_final_gate',
    acceptanceContractDigest: digest('contract'),
    gatePlanDigest: digest('gate-plan'),
    criteriaSelectionDigest: digest('criteria-selection'),
    sourceSnapshotDigest: digest('source'),
    promotionJournalId: JOURNAL_ID,
    promotionJournalHeadDigest: digest('journal'),
    targetAfterFingerprintDigest: digest('target-after'),
  };
}

function evidenceFor(
  state: Awaited<
    ReturnType<TargetFinalGateAttemptStore['initialize']>
  >,
) {
  return createTargetFinalGateEvidenceSnapshot({
    evidenceSnapshotId: '019f8d30-0004-7abc-8def-0123456789ab',
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
    promotionJournalHeadDigest: state.promotionJournalHeadDigest,
    targetPromotionLeaseId: state.targetPromotionLeaseId,
    targetFencingTokenDigest: state.targetFencingTokenDigest,
    targetAfterFingerprintDigest:
      state.targetAfterFingerprintDigest,
    orderedCheckResults: [
      createTargetFinalGateCheckResultRef({
        checkId: 'check-tests',
        commandDigest: digest('command'),
        definitionDigest: digest('definition'),
        resultDigest: digest('check-result'),
        status: 'passed',
      }),
    ],
    builtinRiskScanResultDigest: digest('risk'),
    builtinRiskScanStatus: 'clean',
    criteriaEvidenceDigest: digest('criteria'),
    criteriaStatus: 'satisfied',
    freshReviewerResultDigest: digest('reviewer'),
    freshReviewerStatus: 'PASS',
    finalGateCompletedAt: '2026-07-29T16:10:01.000Z',
  });
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/final-gate-store/v1', label);
}
