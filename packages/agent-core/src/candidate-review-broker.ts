import {
  isBrokerReviewTrustBindingActive,
  ReviewSubjectBroker,
  type BrokerReviewTrustBindingV1,
  type CandidateBootstrapPlanV1,
  type ReviewSubjectConsentBindingV1,
} from '@wukong/verification';

import { CandidateDeltaStore } from './candidate-delta-store';
import {
  type CandidateBrokeredReviewPlanV1,
  validateCandidateBrokeredReviewPlan,
} from './candidate-review-plan';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
} from './worktree-lease-store';

export interface WithCandidateReviewBrokerInputV1 {
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly candidateDeltaStore: CandidateDeltaStore;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly reviewPlan: CandidateBrokeredReviewPlanV1;
  readonly candidateGateAttemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly sourceWorkspaceIdentityDigest: string;
  readonly brokerReviewTrust: BrokerReviewTrustBindingV1;
  readonly reviewSubjectConsent: ReviewSubjectConsentBindingV1;
}

/**
 * Opens the existing bounded Review Subject broker against one exact candidate
 * delta. The broker and root view cannot outlive the callback.
 */
export async function withCandidateReviewBroker<Result>(
  input: WithCandidateReviewBrokerInputV1,
  callback: (broker: ReviewSubjectBroker) => Promise<Result> | Result,
): Promise<Result> {
  assertInput(input, callback);
  const initialSeal = await input.candidateDeltaStore.sealDelta({
    worktreeLeaseStore: input.worktreeLeaseStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
  });
  assertSealBinding(input.reviewPlan, initialSeal);
  let outcome:
    | { readonly ok: true; readonly value: Result }
    | { readonly ok: false; readonly error: unknown };
  try {
    outcome = {
      ok: true,
      value: await input.worktreeLeaseStore.withCandidateRoot(
      input.rootCapability,
      async (view) => {
        const lease = await input.worktreeLeaseStore.inspect(
          input.rootCapability.candidateId,
        );
        if (lease.state !== 'verifying'
          || lease.candidateId !== input.reviewPlan.candidateId
          || lease.leaseId !== input.reviewPlan.leaseId
          || lease.casRevision !== initialSeal.leaseCasRevision
          || lease.leaseDigest !== initialSeal.verifyingLeaseDigest) {
          throw new Error(
            'The candidate review broker has a stale verifying lease.',
          );
        }
        const broker = await ReviewSubjectBroker.build({
          workspaceRoot: view.candidateRelativeCwd,
          attemptId: input.candidateGateAttemptId,
          runId: input.runId,
          contractId: input.contractId,
          planDigest: input.planDigest,
          workspaceFingerprint: input.reviewPlan.workspaceFingerprint,
          consent: input.reviewSubjectConsent,
          candidates: input.reviewPlan.subjectCandidates,
          gateEvidence: input.reviewPlan.gateEvidence,
        });
        try {
          const result = await callback(broker);
          if (!isBrokerReviewTrustBindingActive(input.brokerReviewTrust)) {
            throw new Error(
              'The candidate review broker trust was revoked during review.',
            );
          }
          await broker.assertFresh(input.reviewPlan.workspaceFingerprint);
          return result;
        } finally {
          broker.destroy();
        }
      },
    ),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const finalSeal = await input.candidateDeltaStore.sealDelta({
    worktreeLeaseStore: input.worktreeLeaseStore,
    rootCapability: input.rootCapability,
    bootstrapPlan: input.bootstrapPlan,
  });
  if (finalSeal.sealDigest !== initialSeal.sealDigest) {
    throw new Error('The candidate delta changed during brokered review.');
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function assertInput<Result>(
  input: WithCandidateReviewBrokerInputV1,
  callback: (broker: ReviewSubjectBroker) => Promise<Result> | Result,
): void {
  if (!(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.candidateDeltaStore instanceof CandidateDeltaStore)
    || !(input.rootCapability instanceof CandidateRootCapabilityV1)
    || !validateCandidateBrokeredReviewPlan(input.reviewPlan)
    || !isUuid(input.candidateGateAttemptId)
    || input.runId.length === 0
    || input.contractId.length === 0
    || !isDigest(input.planDigest)
    || !isDigest(input.sourceWorkspaceIdentityDigest)
    || input.brokerReviewTrust.workspaceIdentityDigest
      !== input.sourceWorkspaceIdentityDigest
    || input.reviewSubjectConsent.workspaceIdentityDigest
      !== input.sourceWorkspaceIdentityDigest
    || !isBrokerReviewTrustBindingActive(input.brokerReviewTrust)
    || typeof callback !== 'function') {
    throw new TypeError('Candidate review broker input is invalid.');
  }
}

function assertSealBinding(
  plan: CandidateBrokeredReviewPlanV1,
  seal: {
    readonly candidateId: string;
    readonly leaseId: string;
    readonly sealDigest: string;
    readonly delta: { readonly candidateDeltaDigest: string };
  },
): void {
  if (plan.candidateId !== seal.candidateId
    || plan.leaseId !== seal.leaseId
    || plan.candidateDeltaDigest !== seal.delta.candidateDeltaDigest
    || plan.candidateDeltaSealDigest !== seal.sealDigest) {
    throw new Error('The candidate review plan has a stale delta binding.');
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}
