import { randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildTargetStateFingerprint,
  candidateGateAttemptIdForLease,
  canonicalDigest,
  acknowledgePromotionConsent,
  createNoBootstrapCandidatePlan,
  createPromotionApplyJournal,
  createPromotionConsentProposal,
  reconstructTargetStateFingerprintForRecovery,
  targetPromotionRegistryKey,
  validateSourceSnapshot,
  type IsolatedLoopCandidateBindingV1,
  type PromotionConsentBindingV1,
  type SourceSnapshotV1,
  type TargetStateFingerprintV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';

import type { Agent } from './agent';
import type {
  IsolatedLoopCandidateIterationPublicResultV1,
  IsolatedLoopPromotionProposalPublicResultV1,
  IsolatedLoopPromotionPublicResultV1,
  PrepareIsolatedLoopPromotionPayloadV1,
  PromoteIsolatedLoopCandidatePayloadV1,
  RunIsolatedLoopCandidateIterationPayloadV1,
} from './isolated-loop-runtime-types';
import { CandidateDeltaStore } from './candidate-delta-store';
import {
  buildCandidateBootstrapPlan,
  type PreparedCandidateBootstrapPlanV1,
} from './candidate-bootstrap-plan-builder';
import {
  executePreparedCandidateBootstrap,
  recoverPreparedCandidateBootstrapOwnership,
} from './candidate-bootstrap-orchestrator';
import {
  inspectCandidateWorkspaceBackendCapability,
} from './candidate-workspace-backend-capability';
import {
  inspectCandidateBootstrapPreflight,
} from './candidate-bootstrap-preflight';
import { CandidateGateAttemptStore } from './candidate-gate-attempt-store';
import {
  runIsolatedLoopCandidateIteration,
  type IsolatedLoopCandidateIterationResultV1,
} from './isolated-loop-candidate-iteration';
import { prepareIsolatedLoopCandidate } from './isolated-loop-candidate-preparer';
import { PromotionApplyJournalStore } from './promotion-apply-journal-store';
import {
  captureProcessLivenessProof,
  type ProcessLivenessProofV1,
} from './process-liveness-proof';
import { SnapshotBlobLeaseStore } from './snapshot-blob-lease-store';
import { SnapshotCandidateMaterializer } from './snapshot-candidate-materializer';
import { TargetCompletionSealStore } from './target-completion-seal-store';
import { TargetFinalGateAttemptStore } from './target-final-gate-attempt-store';
import {
  acceptanceContractDigest,
  criteriaSelectionDigest,
} from './target-final-gate-audit-bridge';
import { TargetFinalGateOrchestrator } from './target-final-gate-orchestrator';
import { TargetLoopTerminalFinalizer } from './target-loop-terminal-finalizer';
import { TargetPromotionApplyOrchestrator } from './target-promotion-apply-orchestrator';
import {
  inspectTargetPromotionWorkspaceBackendCapability,
} from './target-promotion-workspace-backend';
import {
  TargetPromotionLeaseStore,
  TargetPromotionLeaseStoreError,
  type TargetPromotionLeaseAuthorityV1,
} from './target-promotion-lease-store';
import {
  recordGateAudit,
  runGoalGate,
} from './tools/builtin/goal/update-goal';
import {
  WorktreeLeaseStore,
  WorktreeLeaseStoreError,
  type RestoredCandidateRootV1,
  type WorktreeLeaseAuthorityV1,
} from './worktree-lease-store';
import {
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const PRIVATE_DIRECTORY_MODE = 0o700;
const LEASE_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const WRITER_MAX_STEPS = 24;
const COMPLETION_REDACTION_POLICY_VERSION = 'wukong-redaction-v1';
const FALLBACK_PROCESS_IDENTITY_DIGEST = canonicalDigest(
  'wukong/process-identity/v1',
  {
    processId: process.pid,
    processInstanceId: randomUUID(),
  },
);
let currentProcessAuthorityPromise:
  Promise<CurrentProcessAuthorityV1> | undefined;
const WRITER_SYSTEM_PROMPT = [
  'You are the Writer for one isolated Wukong Loop candidate.',
  'Work only inside the guarded candidate workspace.',
  'Implement the objective, inspect relevant files, and use the available file tools.',
  'Do not claim verification passed; an independent Gate runs after this turn.',
].join(' ');

export async function runAgentIsolatedLoopCandidateIteration(
  agent: Agent,
  payload: RunIsolatedLoopCandidateIterationPayloadV1,
  signal: AbortSignal,
): Promise<IsolatedLoopCandidateIterationPublicResultV1> {
  assertPayload(payload);
  const backendCapability =
    inspectCandidateWorkspaceBackendCapability();
  if (!backendCapability.available) {
    throw new Error(
      `The isolated Candidate file backend is unavailable: ${
        backendCapability.reasonCode
      }.`,
    );
  }
  const homedir = agent.homedir;
  const context = agent.goal.createIsolatedLoopCandidateRuntimeContext();
  if (homedir === undefined) {
    throw new Error(
      'Isolated Loop execution requires a persistent session home.',
    );
  }
  if (context === null) {
    throw new Error(
      'Isolated Loop execution requires one active frozen Loop run.',
    );
  }
  const existingBinding = agent.goal.getIsolatedLoopCandidateBinding();
  if (existingBinding !== null
    && payload.sourceSnapshot.snapshotDigest
      !== existingBinding.sourceSnapshotDigest) {
    throw new Error(
      'The resumed isolated Loop source snapshot does not match its binding.',
    );
  }
  const [sourceRepositoryRoot, sourceSnapshotCwd, workspaceRoot] =
    await Promise.all([
      realpath(resolve(payload.sourceRepositoryRoot)),
      realpath(resolve(payload.sourceSnapshotCwd)),
      realpath(resolve(context.gateContract.workspaceIdentity.canonicalRealpath)),
    ]);
  if (sourceSnapshotCwd !== workspaceRoot) {
    throw new Error(
      'The isolated Loop source workspace does not match the frozen Finish Line.',
    );
  }
  const repositoryRelativeCwd = relative(
    sourceRepositoryRoot,
    sourceSnapshotCwd,
  ).replaceAll('\\', '/') || '.';
  if (repositoryRelativeCwd !== payload.sourceSnapshot.repositoryRelativeCwd
    || repositoryRelativeCwd === '..'
    || repositoryRelativeCwd.startsWith('../')) {
    throw new Error(
      'The isolated Loop repository root does not match the frozen source snapshot.',
    );
  }

  const runtimeRoot = join(homedir, 'runtime', 'isolated-loop');
  await mkdir(runtimeRoot, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  });
  if (process.platform === 'win32') {
    protectWindowsPrivateRootSecurity(runtimeRoot);
  } else {
    await chmod(runtimeRoot, PRIVATE_DIRECTORY_MODE);
  }
  const candidateDeltasRoot = join(
    runtimeRoot,
    'candidate-deltas',
  );
  const candidateGateAttemptsRoot = join(
    runtimeRoot,
    'candidate-gate-attempts',
  );
  await Promise.all([
    ensurePrivateDirectory(candidateDeltasRoot),
    ensurePrivateDirectory(candidateGateAttemptsRoot),
  ]);
  const snapshotBlobLeaseStore = new SnapshotBlobLeaseStore({
    rootDirectory: join(runtimeRoot, 'snapshot-blobs'),
  });
  const worktreeLeaseStore = new WorktreeLeaseStore({
    candidatesRootDirectory: join(runtimeRoot, 'candidates'),
  });
  const materializer = new SnapshotCandidateMaterializer();
  const preparedBootstrap = await resolveCandidateBootstrap({
    sourceRepositoryRoot,
    sourceSnapshotCwd,
    sourceSnapshot: payload.sourceSnapshot,
    gatePlan: context.gateContract.gatePlan,
    approvedBootstrapPlanDigest:
      payload.approvedBootstrapPlanDigest,
  });
  const bootstrapPlan = preparedBootstrap?.plan
    ?? createNoBootstrapCandidatePlan({
      sourceSnapshotDigest: payload.sourceSnapshot.snapshotDigest,
      gatePlanDigest: context.gatePlanDigest,
    });
  const candidateDeltaStore = new CandidateDeltaStore({
    privateRootDirectory: candidateDeltasRoot,
    sourceRepositoryRoot,
  });
  const candidateGateAttemptStore = new CandidateGateAttemptStore({
    privateRootDirectory: candidateGateAttemptsRoot,
    sourceRepositoryRoot,
  });

  let binding = existingBinding;
  let restored: RestoredCandidateRootV1;
  if (binding === null) {
    const prepared = await prepareIsolatedLoopCandidate({
      sourceRepositoryRoot,
      sourceSnapshotCwd,
      sourceSnapshot: payload.sourceSnapshot,
      snapshotBlobLeaseStore,
      worktreeLeaseStore,
      materializer,
      goalId: context.goalId,
      contractId: context.contractId,
      runId: context.runId,
      ownerRunId: context.ownerRunId,
      bootstrapPlan,
      preparedBootstrap: preparedBootstrap ?? undefined,
      approvedBootstrapPlanDigest:
        preparedBootstrap?.plan.bootstrapPlanDigest,
      gatePlanDigest: context.gatePlanDigest,
      criteriaSelectionDigest: context.criteriaSelectionDigest,
      expiresAt: new Date(Date.now() + LEASE_LIFETIME_MS).toISOString(),
      recordBinding: (candidateBinding) =>
        agent.goal.recordIsolatedLoopCandidateBinding(candidateBinding),
    });
    binding = prepared.binding;
    restored = prepared.worktree;
  } else {
    assertBindingMatchesContext(binding, context, bootstrapPlan.bootstrapPlanDigest);
    restored = await restoreCandidate({
      binding,
      sourceRepositoryRoot,
      sourceSnapshot: payload.sourceSnapshot,
      snapshotBlobLeaseStore,
      worktreeLeaseStore,
      materializer,
      preparedBootstrap,
      approvedBootstrapPlanDigest:
        payload.approvedBootstrapPlanDigest,
      signal,
    });
  }

  const result = await runIsolatedLoopCandidateIteration({
    agent,
    binding,
    worktreeLeaseStore,
    worktreeBinding: restored.binding,
    rootCapability: restored.rootCapability,
    candidateDeltaStore,
    candidateGateAttemptStore,
    bootstrapPlan,
    gateContract: context.gateContract,
    gateRuntime: context.gateRuntime,
    objective: context.objective,
    writerSystemPrompt: WRITER_SYSTEM_PROMPT,
    writerModel: context.writerModel,
    reviewerModel: context.reviewerModel,
    writerMaxSteps: WRITER_MAX_STEPS,
    parentToolCallId: `isolated-loop:${binding.candidateId}`,
    signal,
  });
  const gateResult = result.gate.attempt.candidateGateResult;
  if (gateResult === null) {
    throw new Error('The candidate Gate returned no terminal result.');
  }
  const goal = agent.goal.recordIsolatedLoopCandidateIteration({
    bindingDigest: binding.bindingDigest,
    candidateGateAttemptId: result.candidateGateAttemptId,
    candidateGateResultDigest:
      gateResult.candidateGateResultDigest,
  });
  return publicResult(binding, result, goal.iteration);
}

export async function prepareAgentIsolatedLoopPromotion(
  agent: Agent,
  payload: PrepareIsolatedLoopPromotionPayloadV1,
): Promise<IsolatedLoopPromotionProposalPublicResultV1> {
  assertTargetPromotionWorkspaceBackendAvailable();
  assertPayload(payload);
  const prepared = await restorePromotionCandidate(agent, payload);
  const { candidateDeltaSeal, candidateGateAttempt } = prepared;
  const candidateGateResult =
    candidateGateAttempt.candidateGateResult;
  if (candidateGateResult === null) {
    throw new Error(
      'Promotion requires a completed Candidate Gate result.',
    );
  }
  const { proposal } = await buildPromotionChallenge(
    prepared,
    payload.sourceSnapshot,
    candidateGateResult.candidateGateResultDigest,
  );
  return Object.freeze({
    schemaVersion: 1,
    promotionId: proposal.promotionId,
    candidateId: proposal.candidateId,
    candidateGateAttemptId:
      candidateGateAttempt.candidateGateAttemptId,
    candidateGateResultDigest:
      proposal.candidateGateResultDigest,
    candidateDeltaDigest: proposal.candidateDeltaDigest,
    targetFingerprintDigest: proposal.targetFingerprintDigest,
    permissionDigest: proposal.permissionDigest,
    proposalDigest: proposal.proposalDigest,
    changedFileCount:
      candidateDeltaSeal.manifest.changedPaths.length,
    changes: Object.freeze(
      candidateDeltaSeal.manifest.changes.map((change) =>
        Object.freeze({
          operation: change.operation,
          sourcePath: change.sourcePath,
          targetPath: change.targetPath,
          modeBefore: change.preimage?.mode ?? null,
          modeAfter: change.postimage?.mode ?? null,
        })),
    ),
  });
}

export async function promoteAgentIsolatedLoopCandidate(
  agent: Agent,
  payload: PromoteIsolatedLoopCandidatePayloadV1,
  signal: AbortSignal,
): Promise<IsolatedLoopPromotionPublicResultV1> {
  assertTargetPromotionWorkspaceBackendAvailable();
  assertPayload(payload);
  if (!isDigest(payload.proposalDigest)) {
    throw new TypeError(
      'The isolated Loop promotion proposal digest is invalid.',
    );
  }
  if (agent.wukongHomeDir === undefined) {
    throw new Error(
      'Promotion requires the user-global Wukong runtime home.',
    );
  }
  const prepared = await restorePromotionCandidate(agent, payload);
  const candidateGateResult =
    prepared.candidateGateAttempt.candidateGateResult;
  if (candidateGateResult === null) {
    throw new Error(
      'Promotion requires a completed Candidate Gate result.',
    );
  }
  let challenge;
  try {
    challenge = await buildPromotionChallenge(
      prepared,
      payload.sourceSnapshot,
      candidateGateResult.candidateGateResultDigest,
    );
  } catch (error) {
    const targetFingerprint =
      await reconstructTargetStateFingerprintForRecovery({
        cwd: prepared.sourceSnapshotCwd,
        expectedSourceSnapshot: payload.sourceSnapshot,
        promotableContentDigest:
          prepared.candidateDeltaSeal.delta
            .candidateWorkspaceDigest,
      }).catch(() => {
        throw error;
      });
    const recovered = promotionChallengeForFingerprint(
      prepared,
      targetFingerprint,
      candidateGateResult.candidateGateResultDigest,
    );
    if (recovered.proposal.proposalDigest
        !== payload.proposalDigest) {
      throw error;
    }
    challenge = recovered;
  }
  const { targetFingerprint, proposal } = challenge;
  if (proposal.proposalDigest !== payload.proposalDigest) {
    throw new Error(
      'The promotion challenge is stale; review the current candidate again.',
    );
  }
  const consent = acknowledgePromotionConsent(
    proposal,
    payload.proposalDigest,
    new Date().toISOString(),
  );
  const targetRuntimeRoot = join(
    agent.wukongHomeDir,
    'runtime',
    'target-promotions',
  );
  await mkdir(targetRuntimeRoot, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  });
  await chmod(targetRuntimeRoot, PRIVATE_DIRECTORY_MODE);
  const targetPromotionLeaseStore = new TargetPromotionLeaseStore({
    registryRootDirectory: targetRuntimeRoot,
  });
  const processAuthority = await currentProcessAuthority();
  const acquired = await acquireOrRecoverTargetPromotionLease({
    store: targetPromotionLeaseStore,
    consent,
    targetFingerprint,
    ownerRunId: prepared.context.ownerRunId,
    processAuthority,
  });
  const journalId = stablePromotionUuid(
    'apply-journal',
    proposal.proposalDigest,
  );
  const journalStore = new PromotionApplyJournalStore();
  const promotion = acquired.lease.state === 'final_verifying'
    ? await targetPromotionLeaseStore.withExclusiveLease(
        acquired.binding,
        'final_verifying',
        async (view) => {
          const journal = await journalStore.createOrLoad(
            view,
            createPromotionApplyJournal({
              journalId,
              promotionId: view.lease.promotionId,
              targetPromotionLeaseId:
                view.lease.targetPromotionLeaseId,
              targetRegistryKey: view.lease.targetRegistryKey,
              createdByTargetFencingTokenDigest:
                view.lease.fencingTokenDigest,
              candidateId: prepared.candidateDeltaSeal.candidateId,
              candidateDeltaDigest:
                prepared.candidateDeltaSeal.delta
                  .candidateDeltaDigest,
              orderedChangeManifestDigest:
                prepared.candidateDeltaSeal.manifest
                  .orderedChangeManifestDigest,
              changeCount:
                prepared.candidateDeltaSeal.manifest.changes.length,
              targetBeforeFingerprintDigest:
                targetFingerprint.fingerprintDigest,
              targetBeforeContentDigest:
                prepared.candidateDeltaSeal.delta
                  .materializedSourceDigest,
              materializedSourceDigest:
                prepared.candidateDeltaSeal.delta
                  .materializedSourceDigest,
              agentDeltaDigest:
                prepared.candidateDeltaSeal.delta.agentDeltaDigest,
            }),
          );
          if (journal.state !== 'applied'
            || journal.targetAfterFingerprintDigest === null) {
            throw new Error(
              'Final-verifying recovery requires an applied journal.',
            );
          }
          return {
            journal,
            targetAfterFingerprintDigest:
              journal.targetAfterFingerprintDigest,
            finalVerifyingAuthority: acquired,
          };
        },
      )
    : await (async () => {
        const applying = acquired.lease.state === 'acquired'
          ? await targetPromotionLeaseStore.transition(
              acquired.binding,
              'applying',
            )
          : acquired;
        const apply = await new TargetPromotionApplyOrchestrator().run({
          targetPromotionLeaseStore,
          targetPromotionBinding: applying.binding,
          journalStore,
          worktreeLeaseStore: prepared.worktreeLeaseStore,
          candidateRootCapability: prepared.candidateRootCapability,
          candidateDeltaSeal: prepared.candidateDeltaSeal,
          expectedSourceSnapshot: payload.sourceSnapshot,
          expectedTargetBeforeFingerprint: targetFingerprint,
          targetDirectory: prepared.sourceSnapshotCwd,
          journalId,
          signal,
        });
        return {
          journal: apply.journal,
          targetAfterFingerprintDigest:
            apply.targetAfterFingerprint.fingerprintDigest,
          finalVerifyingAuthority:
            apply.finalVerifyingAuthority,
        };
      })();
  const finalGateAttemptId = stablePromotionUuid(
    'final-gate-attempt',
    proposal.proposalDigest,
  );
  const finalGateState = await new TargetFinalGateOrchestrator().run({
    targetPromotionLeaseStore,
    targetPromotionBinding:
      promotion.finalVerifyingAuthority.binding,
    attemptStore: new TargetFinalGateAttemptStore(),
    initialize: {
      finalGateAttemptId,
      runId: prepared.context.runId,
      contractId: prepared.context.contractId,
      acceptanceContractDigest:
        acceptanceContractDigest(prepared.context.loopContract),
      gatePlanDigest:
        prepared.context.loopContract.gatePlan.planDigest,
      criteriaSelectionDigest:
        criteriaSelectionDigest(prepared.context.loopContract),
      sourceSnapshotDigest: prepared.binding.sourceSnapshotDigest,
      promotionJournalId: promotion.journal.journalId,
      promotionJournalHeadDigest:
        promotion.journal.journalHeadDigest,
      targetAfterFingerprintDigest:
        promotion.targetAfterFingerprintDigest,
    },
    evidenceProducer: {
      produce: async ({ preparedAttempt }) => {
        const gate = await runGoalGate(
          'proof-pass',
          agent,
          prepared.context.objective,
          prepared.context.reviewerModel,
          prepared.context.loopContract,
          undefined,
          `isolated-loop-final-gate:${proposal.promotionId}`,
          signal,
          finalGateAttemptId,
        );
        const completed = recordGateAudit(agent.goal, gate);
        if (completed === null
          || completed.attemptId !== finalGateAttemptId) {
          throw new Error(
            'Target Final Gate did not persist its exact Goal audit.',
          );
        }
        return agent.goal.buildTargetFinalGateEvidence({
          targetAttempt: preparedAttempt,
          evidenceSnapshotId: stablePromotionUuid(
            'target-evidence',
            proposal.proposalDigest,
          ),
        });
      },
    },
  });
  if (finalGateState.result === null) {
    throw new Error('Target Final Gate returned no terminal result.');
  }
  const completionSealStore = new TargetCompletionSealStore();
  const completionSealId = stablePromotionUuid(
    'completion-seal',
    proposal.proposalDigest,
  );
  const completionSeal =
    await targetPromotionLeaseStore.withExclusiveLease(
      promotion.finalVerifyingAuthority.binding,
      'final_verifying',
      (view) => completionSealStore.sealAndReopen(view, {
        completionSealId,
        journal: promotion.journal,
        finalGateState,
        redactionPolicyVersion:
          COMPLETION_REDACTION_POLICY_VERSION,
      }),
    );
  const terminal = await new TargetLoopTerminalFinalizer().commit({
    targetPromotionLeaseStore,
    targetPromotionBinding:
      promotion.finalVerifyingAuthority.binding,
    completionSealStore,
    completionSealId,
    expectedCompletionSealDigest:
      completionSeal.completionSealDigest,
    terminalRecorder: agent.goal,
  });
  if (terminal.terminal.status === 'PASS') {
    await agent.goal.markComplete(
      { reason: 'Target Final Gate passed after explicit promotion.' },
      'system',
    );
  } else {
    await agent.goal.markBlocked(
      { reason: finalGateState.result.reasonCode },
      'runtime',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    promotionId: proposal.promotionId,
    candidateId: proposal.candidateId,
    proposalDigest: proposal.proposalDigest,
    targetPromotionLeaseId:
      promotion.finalVerifyingAuthority.lease
        .targetPromotionLeaseId,
    targetAfterFingerprintDigest:
      promotion.targetAfterFingerprintDigest,
    finalGateAttemptId,
    outcome: finalGateState.result.outcome,
    reasonCode: finalGateState.result.reasonCode,
    blockerKeys: Object.freeze([
      ...finalGateState.result.blockerKeys,
    ]),
    completionSealDigest:
      completionSeal.completionSealDigest,
  });
}

function assertTargetPromotionWorkspaceBackendAvailable(): void {
  const capability =
    inspectTargetPromotionWorkspaceBackendCapability();
  if (capability.available) return;
  throw new Error(
    `The Target promotion file backend is unavailable: ${
      capability.reasonCode
    }.`,
  );
}

export interface CurrentProcessAuthorityV1 {
  readonly identityDigest: string;
  readonly livenessProof?: ProcessLivenessProofV1;
}

export async function acquireOrRecoverWorktreeLease(input: {
  readonly store: WorktreeLeaseStore;
  readonly binding: IsolatedLoopCandidateBindingV1;
  readonly processAuthority: CurrentProcessAuthorityV1;
}): Promise<WorktreeLeaseAuthorityV1> {
  const lease = await input.store.inspect(
    input.binding.candidateId,
  );
  assertLeaseMatchesBinding(lease, input.binding);
  if (lease.ownerProcessIdentityDigest
      === input.processAuthority.identityDigest) {
    return input.store.resumeOwned({
      candidateId: lease.candidateId,
      runId: lease.runId,
      ownerRunId: lease.ownerRunId,
      ownerProcessIdentityDigest:
        input.processAuthority.identityDigest,
      expectedLeaseDigest: lease.leaseDigest,
    });
  }
  if (input.processAuthority.livenessProof === undefined) {
    throw new WorktreeLeaseStoreError(
      'worktree_lease_liveness_unproven',
      'The current process cannot prove safe worktree adoption.',
    );
  }
  return input.store.adoptDeadOwner({
    candidateId: lease.candidateId,
    runId: lease.runId,
    ownerRunId: lease.ownerRunId,
    expectedLeaseDigest: lease.leaseDigest,
    nextProcessLivenessProof:
      input.processAuthority.livenessProof,
  });
}

export async function acquireOrRecoverTargetPromotionLease(input: {
  readonly store: TargetPromotionLeaseStore;
  readonly consent: PromotionConsentBindingV1;
  readonly targetFingerprint: TargetStateFingerprintV1;
  readonly ownerRunId: string;
  readonly processAuthority: CurrentProcessAuthorityV1;
}): Promise<TargetPromotionLeaseAuthorityV1> {
  const targetRegistryKey =
    targetPromotionRegistryKey(input.targetFingerprint);
  let existing;
  try {
    existing = await input.store.inspect(targetRegistryKey);
  } catch (error) {
    if (!(error instanceof TargetPromotionLeaseStoreError)
      || error.reasonCode !== 'promotion_lease_not_found') {
      throw error;
    }
  }
  if (existing === undefined || existing.state === 'released') {
    return input.store.acquire({
      consent: input.consent,
      targetFingerprint: input.targetFingerprint,
      ownerRunId: input.ownerRunId,
      ownerProcessIdentityDigest:
        input.processAuthority.identityDigest,
      ownerProcessLivenessProof:
        input.processAuthority.livenessProof,
    });
  }
  if (!leaseMatchesPromotion(
    existing,
    input.consent,
    input.targetFingerprint,
    input.ownerRunId,
  )) {
    throw new TargetPromotionLeaseStoreError(
      'promotion_target_busy',
      'Another promotion owner holds this exact target.',
    );
  }
  if (existing.state !== 'acquired'
    && existing.state !== 'applying'
    && existing.state !== 'final_verifying') {
    throw new TargetPromotionLeaseStoreError(
      'promotion_adoption_unsafe_state',
      'This promotion state is not eligible for automatic recovery.',
    );
  }
  if (existing.ownerProcessIdentityDigest
      === input.processAuthority.identityDigest) {
    return input.store.resumeOwned({
      targetRegistryKey,
      ownerRunId: input.ownerRunId,
      ownerProcessIdentityDigest:
        input.processAuthority.identityDigest,
      expectedLeaseDigest: existing.leaseDigest,
    });
  }
  if (input.processAuthority.livenessProof === undefined) {
    throw new TargetPromotionLeaseStoreError(
      'promotion_liveness_unproven',
      'The current process cannot provide a liveness proof for safe adoption.',
    );
  }
  const adoptionInput = {
    targetRegistryKey,
    ownerRunId: input.ownerRunId,
    expectedLeaseDigest: existing.leaseDigest,
    nextProcessLivenessProof:
      input.processAuthority.livenessProof,
  };
  if (existing.state === 'acquired') {
    return input.store.adoptAcquired(adoptionInput);
  }
  return existing.state === 'applying'
    ? input.store.adoptApplying(adoptionInput)
    : input.store.adoptFinalVerifying(adoptionInput);
}

async function currentProcessAuthority():
Promise<CurrentProcessAuthorityV1> {
  currentProcessAuthorityPromise ??= captureProcessLivenessProof()
    .then((proof) => Object.freeze({
      identityDigest: proof.proofDigest,
      livenessProof: proof,
    }))
    .catch(() => Object.freeze({
      identityDigest: FALLBACK_PROCESS_IDENTITY_DIGEST,
    }));
  return currentProcessAuthorityPromise;
}

function leaseMatchesPromotion(
  lease: Awaited<ReturnType<TargetPromotionLeaseStore['inspect']>>,
  consent: PromotionConsentBindingV1,
  targetFingerprint: TargetStateFingerprintV1,
  ownerRunId: string,
): boolean {
  return lease.acquiredFingerprintDigest
      === targetFingerprint.fingerprintDigest
    && lease.targetWorkspaceIdentity
      === targetFingerprint.targetWorkspaceIdentity
    && lease.targetGitCommonDirIdentity
      === targetFingerprint.targetGitCommonDirIdentity
    && lease.promotionId === consent.promotionId
    && lease.candidateId === consent.candidateId
    && lease.candidateDeltaDigest === consent.candidateDeltaDigest
    && lease.candidateGateResultDigest
      === consent.candidateGateResultDigest
    && lease.ownerRunId === ownerRunId;
}

async function buildPromotionChallenge(
  prepared: Awaited<ReturnType<typeof restorePromotionCandidate>>,
  sourceSnapshot: SourceSnapshotV1,
  candidateGateResultDigest: string,
) {
  const targetFingerprint = await buildTargetStateFingerprint({
    cwd: prepared.sourceSnapshotCwd,
    expectedSourceSnapshot: sourceSnapshot,
    promotableContentDigest:
      prepared.candidateDeltaSeal.delta.candidateWorkspaceDigest,
  });
  return promotionChallengeForFingerprint(
    prepared,
    targetFingerprint,
    candidateGateResultDigest,
  );
}

function promotionChallengeForFingerprint(
  prepared: Awaited<ReturnType<typeof restorePromotionCandidate>>,
  targetFingerprint: TargetStateFingerprintV1,
  candidateGateResultDigest: string,
) {
  const { context, binding, candidateDeltaSeal } = prepared;
  const promotionId = uuidFromDigest(canonicalDigest(
    'wukong/isolated-loop-promotion-id/v1',
    {
      runId: context.runId,
      candidateId: binding.candidateId,
      candidateGateResultDigest,
      candidateDeltaDigest:
        candidateDeltaSeal.delta.candidateDeltaDigest,
      targetFingerprintDigest: targetFingerprint.fingerprintDigest,
    },
  ));
  const permissionDigest = canonicalDigest(
    'wukong/isolated-loop-promotion-permission/v1',
    {
      action: 'promote_exact_candidate_to_exact_target',
      runId: context.runId,
      candidateId: binding.candidateId,
      targetFingerprintDigest: targetFingerprint.fingerprintDigest,
    },
  );
  return {
    targetFingerprint,
    proposal: createPromotionConsentProposal({
      promotionId,
      candidateId: binding.candidateId,
      candidateDeltaDigest:
        candidateDeltaSeal.delta.candidateDeltaDigest,
      candidateGateResultDigest,
      sourceSnapshotDigest: binding.sourceSnapshotDigest,
      targetFingerprint,
      permissionDigest,
    }),
  };
}

async function restorePromotionCandidate(
  agent: Agent,
  payload: PrepareIsolatedLoopPromotionPayloadV1,
): Promise<{
  readonly context: NonNullable<
    ReturnType<Agent['goal']['createIsolatedLoopCandidateRuntimeContext']>
  >;
  readonly binding: IsolatedLoopCandidateBindingV1;
  readonly sourceSnapshotCwd: string;
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly candidateRootCapability:
    RestoredCandidateRootV1['rootCapability'];
  readonly candidateDeltaSeal: NonNullable<
    Awaited<ReturnType<CandidateDeltaStore['inspect']>>['seal']
  >;
  readonly candidateGateAttempt: Awaited<
    ReturnType<CandidateGateAttemptStore['inspect']>
  >;
}> {
  const homedir = agent.homedir;
  const context = agent.goal.createIsolatedLoopCandidateRuntimeContext();
  const binding = agent.goal.getIsolatedLoopCandidateBinding();
  if (homedir === undefined || context === null || binding === null) {
    throw new Error(
      'Promotion requires an active persisted isolated Loop candidate.',
    );
  }
  assertBindingMatchesContext(
    binding,
    context,
    binding.bootstrapPlanDigest,
  );
  if (payload.sourceSnapshot.snapshotDigest
      !== binding.sourceSnapshotDigest) {
    throw new Error(
      'The promotion source snapshot does not match its candidate binding.',
    );
  }
  const [sourceRepositoryRoot, sourceSnapshotCwd, workspaceRoot] =
    await Promise.all([
      realpath(resolve(payload.sourceRepositoryRoot)),
      realpath(resolve(payload.sourceSnapshotCwd)),
      realpath(resolve(
        context.gateContract.workspaceIdentity.canonicalRealpath,
      )),
    ]);
  if (sourceSnapshotCwd !== workspaceRoot
    || (relative(sourceRepositoryRoot, sourceSnapshotCwd)
      .replaceAll('\\', '/') || '.')
      !== payload.sourceSnapshot.repositoryRelativeCwd) {
    throw new Error(
      'The promotion target does not match the frozen source workspace.',
    );
  }
  const runtimeRoot = join(homedir, 'runtime', 'isolated-loop');
  const worktreeLeaseStore = new WorktreeLeaseStore({
    candidatesRootDirectory: join(runtimeRoot, 'candidates'),
  });
  const lease = await worktreeLeaseStore.inspect(binding.candidateId);
  assertLeaseMatchesBinding(lease, binding);
  if (lease.state !== 'awaiting_promotion') {
    throw new Error(
      'Promotion requires a candidate awaiting explicit promotion.',
    );
  }
  const verifyingLeaseDigest =
    await worktreeLeaseStore.inspectVerifyingLeaseDigest(
      binding.candidateId,
    );
  const candidateGateAttemptId = candidateGateAttemptIdForLease(
    binding,
    verifyingLeaseDigest,
  );
  const candidateDeltaStore = new CandidateDeltaStore({
    privateRootDirectory: join(runtimeRoot, 'candidate-deltas'),
    sourceRepositoryRoot,
  });
  const candidateGateAttemptStore = new CandidateGateAttemptStore({
    privateRootDirectory:
      join(runtimeRoot, 'candidate-gate-attempts'),
    sourceRepositoryRoot,
  });
  const [{ seal }, candidateGateAttempt] = await Promise.all([
    candidateDeltaStore.inspect(binding.candidateId),
    candidateGateAttemptStore.inspect({
      candidateId: binding.candidateId,
      candidateGateAttemptId,
    }),
  ]);
  if (seal === null
    || candidateGateAttempt.state !== 'completed'
    || candidateGateAttempt.candidateGateResult === null
    || candidateGateAttempt.candidateGateResult.candidateGateOutcome
      !== 'PASS'
    || candidateGateAttempt.candidateDeltaDigest
      !== seal.delta.candidateDeltaDigest
    || candidateGateAttempt.candidateDeltaSealDigest
      !== seal.sealDigest) {
    throw new Error(
      'Promotion requires the exact completed PASS Candidate Gate.',
    );
  }
  const authority = await acquireOrRecoverWorktreeLease({
    store: worktreeLeaseStore,
    binding,
    processAuthority: await currentProcessAuthority(),
  });
  const restored = await worktreeLeaseStore.restoreCandidateRoot(
    authority.binding,
  );
  return {
    context,
    binding,
    sourceSnapshotCwd,
    worktreeLeaseStore,
    candidateRootCapability: restored.rootCapability,
    candidateDeltaSeal: seal,
    candidateGateAttempt,
  };
}

async function restoreCandidate(input: {
  readonly binding: IsolatedLoopCandidateBindingV1;
  readonly sourceRepositoryRoot: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly snapshotBlobLeaseStore: SnapshotBlobLeaseStore;
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly materializer: SnapshotCandidateMaterializer;
  readonly preparedBootstrap: PreparedCandidateBootstrapPlanV1 | null;
  readonly approvedBootstrapPlanDigest?: string;
  readonly signal?: AbortSignal;
}): Promise<RestoredCandidateRootV1> {
  let lease = await input.worktreeLeaseStore.inspect(
    input.binding.candidateId,
  );
  assertLeaseMatchesBinding(lease, input.binding);
  let authority = await acquireOrRecoverWorktreeLease({
    store: input.worktreeLeaseStore,
    binding: input.binding,
    processAuthority: await currentProcessAuthority(),
  });
  lease = authority.lease;
  if (lease.state === 'creating') {
    const blob = await input.snapshotBlobLeaseStore.resumeOwned({
      blobLeaseId: lease.snapshotBlobLeaseId,
      ownerRunId: input.binding.ownerRunId,
      expectedLeaseDigest: lease.snapshotBlobLeaseDigest,
    });
    const materialized = await input.materializer.materialize({
      sourceRepositoryRoot: input.sourceRepositoryRoot,
      sourceSnapshot: input.sourceSnapshot,
      leaseStore: input.snapshotBlobLeaseStore,
      confirmedBinding: blob.binding,
      worktreeLeaseStore: input.worktreeLeaseStore,
      worktreeLeaseBinding: authority.binding,
    });
    authority = materialized.worktreeLease;
    lease = authority.lease;
  } else if (lease.state === 'materializing') {
    authority = await input.materializer.recoverMaterialized({
      snapshotBlobLeaseStore: input.snapshotBlobLeaseStore,
      worktreeLeaseStore: input.worktreeLeaseStore,
      worktreeLeaseBinding: authority.binding,
      sourceSnapshot: input.sourceSnapshot,
      bootstrapRequired: true,
    });
    lease = authority.lease;
  }
  if (lease.state === 'bootstrapping') {
    if (input.preparedBootstrap !== null) {
      await recoverPreparedCandidateBootstrapOwnership({
        worktreeLeaseStore: input.worktreeLeaseStore,
        worktreeAuthority: authority,
        preparedBootstrap: input.preparedBootstrap,
        approvedBootstrapPlanDigest:
          input.approvedBootstrapPlanDigest ?? '',
      });
      return (await executePreparedCandidateBootstrap({
        worktreeLeaseStore: input.worktreeLeaseStore,
        worktreeAuthority: authority,
        preparedBootstrap: input.preparedBootstrap,
        approvedBootstrapPlanDigest:
          input.approvedBootstrapPlanDigest ?? '',
        signal: input.signal,
      })).activeWorktree;
    }
    return input.worktreeLeaseStore.activate(authority.binding);
  }
  return input.worktreeLeaseStore.restoreCandidateRoot(authority.binding);
}

function publicResult(
  binding: IsolatedLoopCandidateBindingV1,
  result: IsolatedLoopCandidateIterationResultV1,
  iteration: number,
): IsolatedLoopCandidateIterationPublicResultV1 {
  const gateResult = result.gate.attempt.candidateGateResult;
  if (gateResult === null || result.gate.attempt.reasonCode === null) {
    throw new Error('The candidate Gate returned no terminal result.');
  }
  return Object.freeze({
    schemaVersion: 1,
    candidateId: binding.candidateId,
    worktreeLeaseId: binding.worktreeLeaseId,
    bindingDigest: binding.bindingDigest,
    candidateGateAttemptId: result.candidateGateAttemptId,
    outcome: gateResult.candidateGateOutcome,
    reasonCode: result.gate.attempt.reasonCode,
    leaseState: result.gate.leaseState,
    writerRan: result.writerRan,
    iteration,
  });
}

function assertPayload(
  payload: RunIsolatedLoopCandidateIterationPayloadV1,
): void {
  if (payload.schemaVersion !== 1
    || !isAbsolute(payload.sourceRepositoryRoot)
    || !isAbsolute(payload.sourceSnapshotCwd)
    || !validateSourceSnapshot(payload.sourceSnapshot)
    || payload.sourceSnapshot.exclusions.length > 0
    || (payload.approvedBootstrapPlanDigest !== undefined
      && !isDigest(payload.approvedBootstrapPlanDigest))) {
    throw new TypeError(
      'The isolated Loop candidate iteration payload is invalid.',
    );
  }
}

async function resolveCandidateBootstrap(input: {
  readonly sourceRepositoryRoot: string;
  readonly sourceSnapshotCwd: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly gatePlan: NonNullable<
    ReturnType<Agent['goal']['createIsolatedLoopCandidateRuntimeContext']>
  >['gateContract']['gatePlan'];
  readonly approvedBootstrapPlanDigest?: string;
}): Promise<PreparedCandidateBootstrapPlanV1 | null> {
  const preflight = await inspectCandidateBootstrapPreflight({
    sourceSnapshotCwd: input.sourceSnapshotCwd,
    sourceSnapshot: input.sourceSnapshot,
    gatePlan: input.gatePlan,
  });
  if (preflight.status === 'unsupported') {
    throw new Error(
      `Candidate bootstrap is unsupported: ${preflight.reasonCode}`,
    );
  }
  if (preflight.status === 'not_required') return null;
  const prepared = await buildCandidateBootstrapPlan({
    preflight,
    expectedPreflightDigest: preflight.preflightDigest,
    sourceWorkspaceRoot: input.sourceRepositoryRoot,
  });
  if (input.approvedBootstrapPlanDigest
    !== prepared.plan.bootstrapPlanDigest) {
    throw new Error(
      'The exact candidate bootstrap plan was not confirmed or is stale.',
    );
  }
  return prepared;
}

function assertBindingMatchesContext(
  binding: IsolatedLoopCandidateBindingV1,
  context: NonNullable<
    ReturnType<Agent['goal']['createIsolatedLoopCandidateRuntimeContext']>
  >,
  bootstrapPlanDigest: string,
): void {
  if (binding.goalId !== context.goalId
    || binding.contractId !== context.contractId
    || binding.runId !== context.runId
    || binding.ownerRunId !== context.ownerRunId
    || binding.bootstrapPlanDigest !== bootstrapPlanDigest
    || binding.gatePlanDigest !== context.gatePlanDigest
    || binding.criteriaSelectionDigest
      !== context.criteriaSelectionDigest) {
    throw new Error(
      'The persisted isolated candidate does not match the current Loop run.',
    );
  }
}

function assertLeaseMatchesBinding(
  lease: WorktreeLeaseV1,
  binding: IsolatedLoopCandidateBindingV1,
): void {
  if (lease.leaseId !== binding.worktreeLeaseId
    || lease.candidateId !== binding.candidateId
    || lease.goalId !== binding.goalId
    || lease.contractId !== binding.contractId
    || lease.runId !== binding.runId
    || lease.ownerRunId !== binding.ownerRunId
    || lease.sourceSnapshotDigest !== binding.sourceSnapshotDigest
    || lease.bootstrapPlanDigest !== binding.bootstrapPlanDigest
    || lease.gatePlanDigest !== binding.gatePlanDigest
    || lease.criteriaSelectionDigest !== binding.criteriaSelectionDigest) {
    throw new Error(
      'The persisted Worktree Lease does not match the Loop candidate binding.',
    );
  }
}

function uuidFromDigest(digest: string): string {
  const hex = digest.slice('sha256:'.length, 'sha256:'.length + 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function stablePromotionUuid(
  kind: string,
  proposalDigest: string,
): string {
  return uuidFromDigest(canonicalDigest(
    `wukong/isolated-loop-promotion-${kind}/v1`,
    { proposalDigest },
  ));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  });
  if (process.platform === 'win32') {
    protectWindowsPrivateRootSecurity(path);
  } else {
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value);
}
