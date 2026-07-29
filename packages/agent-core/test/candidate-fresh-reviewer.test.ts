import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgeReviewSubjectConsent,
  beginCandidateGateReview,
  canonicalDigest,
  clearBrokerReviewTrustBindingsForTests,
  completeCandidateGateAttempt,
  createBrokerReviewTrustProposal,
  createCandidateGateAttempt,
  createReviewSubjectConsentProposal,
  grantBrokerReviewTrust,
  recordCandidateDeterministicGate,
  type CandidateGateAttemptV1,
  type RawGateEvidenceV1,
  type ReviewSubjectCandidateV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../src/agent';
import type { LoopGateReviewRuntimeV2 } from '../src/agent/goal';
import { CandidateDeltaStore } from '../src/candidate-delta-store';
import {
  runCandidateFreshReviewer,
} from '../src/candidate-fresh-reviewer';
import { CandidateGateAttemptStore } from '../src/candidate-gate-attempt-store';
import type {
  CandidateDeterministicGateResultV1,
} from '../src/candidate-gate-executor';
import type {
  CandidateBrokeredReviewPlanV1,
} from '../src/candidate-review-plan';
import type { ExecutableTool } from '../src/loop/types';
import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const ATTEMPT_ID = '019f8c90-0000-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8c90-0001-7abc-8def-0123456789ab';
const LEASE_ID = '019f8c90-0002-7abc-8def-0123456789ab';
const roots: string[] = [];

afterEach(async () => {
  clearBrokerReviewTrustBindingsForTests();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('runCandidateFreshReviewer', () => {
  it('persists reviewing before one origin-locked broker-only PASS', async () => {
    const value = await fixture((prompt) => freshPass(prompt));

    const completed = await runCandidateFreshReviewer(value.input);

    expect(completed).toMatchObject({
      state: 'completed',
      reviewerVerdictStatus: 'PASS',
      candidateGateResult: { candidateGateOutcome: 'PASS' },
    });
    expect(value.beginReview).toHaveBeenCalledOnce();
    expect(value.complete).toHaveBeenCalledOnce();
    expect(value.order).toEqual(['reviewing', 'spawn', 'completed']);
    expect(value.spawn).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'fresh-reviewer',
      isolated: true,
      modelAlias: 'reviewer-model',
      maxSteps: 24,
      providerRequestPolicy: {
        expectedOrigin: 'https://review.example.test/v1',
        redirect: 'error',
      },
      internalTools: expect.arrayContaining([
        expect.objectContaining({ name: 'ReadReviewSubject' }),
        expect.objectContaining({ name: 'SearchReviewSubjects' }),
        expect.objectContaining({ name: 'ReadGateEvidence' }),
      ]),
    }));
    expect(value.complete.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'PASS',
      reasonCode: 'passed',
      reviewerVerdictStatus: 'PASS',
    });
    expect(value.complete.mock.calls[0]?.[0].reviewerPayloadDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('stores only an invalid payload digest and fails closed as ERROR', async () => {
    const value = await fixture(() => 'not a structured verdict');

    const completed = await runCandidateFreshReviewer(value.input);

    expect(completed).toMatchObject({
      state: 'completed',
      reviewerPayloadDigest: expect.stringMatching(
        /^sha256:[a-f0-9]{64}$/u,
      ),
      freshCriteriaVerdictDigest: null,
      reviewerVerdictStatus: null,
      reasonCode: 'reviewer_invalid_output',
      candidateGateResult: { candidateGateOutcome: 'ERROR' },
    });
    expect(JSON.stringify(completed)).not.toContain(
      'not a structured verdict',
    );
  });

  it('maps arbitrary exception reason and message to a fixed durable error', async () => {
    const value = await fixture((prompt) => freshPass(prompt));
    const secret = 'sk_live_private_exception_secret';
    value.spawn.mockRejectedValueOnce(Object.assign(
      new Error(`provider failed with ${secret}`),
      { reasonCode: secret },
    ));

    const completed = await runCandidateFreshReviewer(value.input);

    expect(completed).toMatchObject({
      state: 'completed',
      reasonCode: 'reviewer_unavailable',
      candidateGateResult: { candidateGateOutcome: 'ERROR' },
    });
    expect(JSON.stringify(completed)).not.toContain(secret);
    expect(value.complete.mock.calls[0]?.[0].reasonCode)
      .toBe('reviewer_unavailable');
  });

  it('exposes only redacted check stdout and stderr through reviewer tools', async () => {
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
    const databasePassword = 'database-password-sentinel';
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    const observed: string[] = [];
    const value = await fixture(
      (prompt) => freshPass(prompt),
      [{
        producerId: 'candidate-check-0000',
        evidenceId: 'stdout',
        content: [
          `AWS_ACCESS_KEY_ID=${accessKeyId}`,
          `DATABASE_URL=postgresql://alice:${databasePassword}@db.example.test/app`,
          `token=${jwt}`,
          `payload={"password":"${databasePassword}"}`,
          'access token: fetch failed',
        ].join('\n'),
        mediaType: 'text/plain',
      }, {
        producerId: 'candidate-check-0000',
        evidenceId: 'stderr',
        content: `redis://default:${databasePassword}@cache.example.test/0`,
        mediaType: 'text/plain',
      }],
      async (tools) => {
        const readEvidence = tools.find(
          (tool) => tool.name === 'ReadGateEvidence',
        );
        if (readEvidence === undefined) {
          throw new Error('ReadGateEvidence tool was not provided.');
        }
        for (const evidenceId of ['stdout', 'stderr']) {
          const execution = await readEvidence.resolveExecution({
            producerId: 'candidate-check-0000',
            evidenceId,
          });
          if (!('execute' in execution)) {
            throw new Error('ReadGateEvidence did not resolve to an execution.');
          }
          const result = await execution.execute({} as never);
          observed.push(
            typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output),
          );
        }
      },
    );

    await runCandidateFreshReviewer(value.input);

    const reviewerToolOutput = observed.join('\n');
    for (const credential of [
      accessKeyId,
      databasePassword,
      jwt,
      'alice',
    ]) {
      expect(reviewerToolOutput).not.toContain(credential);
    }
    expect(reviewerToolOutput).toContain('[REDACTED]');
    expect(reviewerToolOutput).toContain('access token: fetch failed');
  });

  it('does not start reviewer state or provider I/O without a safe file backend', async () => {
    const value = await fixture(
      (prompt) => freshPass(prompt),
      [{
        producerId: 'candidate-check-0000',
        evidenceId: 'stdout',
        content: 'gate evidence only',
        mediaType: 'text/plain',
      }],
      undefined,
      [],
    );
    const platform = vi.spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      await expect(runCandidateFreshReviewer(value.input)).rejects.toMatchObject({
        reasonCode: 'review_subject_backend_unavailable',
      });
      expect(value.beginReview).not.toHaveBeenCalled();
      expect(value.spawn).not.toHaveBeenCalled();
      expect(value.complete).not.toHaveBeenCalled();
      expect(value.order).toEqual([]);
    } finally {
      platform.mockRestore();
    }
  });
});

async function fixture(
  result: (prompt: string) => string,
  gateEvidence: readonly RawGateEvidenceV1[] = [],
  inspectTools?: (tools: readonly ExecutableTool[]) => Promise<void>,
  subjectCandidates: readonly ReviewSubjectCandidateV1[] = [{
    logicalPath: 'candidate.ts',
    origin: 'explicit-untracked',
  }],
): Promise<{
  readonly input: Parameters<typeof runCandidateFreshReviewer>[0];
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly beginReview: ReturnType<typeof vi.fn>;
  readonly complete: ReturnType<typeof vi.fn>;
  readonly order: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-candidate-reviewer-'));
  roots.push(root);
  const candidateDirectory = join(root, 'candidate');
  const sourceRepositoryRoot = join(root, 'source');
  const candidatesRoot = join(root, 'candidates');
  await Promise.all([
    mkdir(candidateDirectory),
    mkdir(sourceRepositoryRoot),
    mkdir(candidatesRoot),
  ]);
  await writeFile(
    join(candidateDirectory, 'candidate.ts'),
    'export const candidate = true;\n',
  );

  const gatePlanDigest = digest('gate-plan');
  const candidateDeltaDigest = digest('candidate-delta');
  const candidateDeltaSealDigest = digest('candidate-delta-seal');
  const verifyingLeaseDigest = digest('verifying-lease');
  const worktreeIdentity = digest('worktree');
  const lease = {
    schemaVersion: 1,
    leaseId: LEASE_ID,
    candidateId: CANDIDATE_ID,
    state: 'verifying',
    casRevision: 5,
    leaseDigest: verifyingLeaseDigest,
    worktreeIdentity,
    fencingTokenDigest: digest('fencing'),
  } as unknown as WorktreeLeaseV1;
  const rootCapability = CandidateRootCapabilityV1.create(
    lease,
    candidateDirectory,
    candidateDirectory,
    'raw-fencing-token',
  );
  const worktreeLeaseStore = new WorktreeLeaseStore({
    candidatesRootDirectory: candidatesRoot,
  });
  vi.spyOn(worktreeLeaseStore, 'inspect').mockResolvedValue(lease);
  vi.spyOn(worktreeLeaseStore, 'withCandidateRoot').mockImplementation(
    async (_capability, callback) => callback({
      candidateDirectory,
      candidateRelativeCwd: candidateDirectory,
      workspace: {
        workspaceDir: candidateDirectory,
        additionalDirs: [],
        accessMode: 'workspace-only',
      },
    }),
  );
  const candidateDeltaStore = new CandidateDeltaStore({
    privateRootDirectory: candidatesRoot,
    sourceRepositoryRoot,
  });
  const seal = {
    schemaVersion: 1,
    candidateId: CANDIDATE_ID,
    leaseId: LEASE_ID,
    leaseCasRevision: 5,
    verifyingLeaseDigest,
    sealDigest: candidateDeltaSealDigest,
    delta: { candidateDeltaDigest },
  };
  vi.spyOn(candidateDeltaStore, 'sealDelta').mockResolvedValue(
    seal as never,
  );
  const reviewPlanCore = {
    schemaVersion: 1 as const,
    candidateId: CANDIDATE_ID,
    leaseId: LEASE_ID,
    candidateDeltaDigest,
    candidateDeltaSealDigest,
    workspaceFingerprint: 'candidate-snapshot-1',
    subjectCandidates,
    gateEvidence,
  };
  const reviewPlan: CandidateBrokeredReviewPlanV1 = {
    ...reviewPlanCore,
    reviewPlanDigest: canonicalDigest(
      'wukong/candidate-brokered-review-plan/v1',
      reviewPlanCore,
    ),
  };
  const deterministicGate = {
    schemaVersion: 1,
    candidateId: CANDIDATE_ID,
    leaseId: LEASE_ID,
    candidateDeltaDigest,
    candidateDeltaSealDigest,
    status: 'passed',
    reasonCode: 'passed',
    reason: 'passed',
    gatePlanDigest,
    workspaceSnapshotId: 'candidate-snapshot-1',
    validation: { ok: true },
    proof: {
      status: 'passed',
      verification: { commandResults: [], changedFiles: [] },
      scan: { risks: [] },
    },
  } as unknown as CandidateDeterministicGateResultV1;
  const prepared = createCandidateGateAttempt({
    candidateGateAttemptId: ATTEMPT_ID,
    candidateId: CANDIDATE_ID,
    leaseId: LEASE_ID,
    leaseCasRevision: 5,
    verifyingLeaseDigest,
    candidateDeltaDigest,
    candidateDeltaSealDigest,
    gatePlanDigest,
    createdAt: '2026-07-29T10:00:00.000Z',
  });
  const expectedAttempt = recordCandidateDeterministicGate(prepared, {
    deterministicGateResultDigest: canonicalDigest(
      'wukong/candidate-deterministic-gate-result/v1',
      deterministicGate,
    ),
    deterministicGateStatus: 'passed',
    reviewPlanDigest: reviewPlan.reviewPlanDigest,
    occurredAt: '2026-07-29T10:00:01.000Z',
  });
  const candidateGateAttemptStore = new CandidateGateAttemptStore({
    privateRootDirectory: candidatesRoot,
    sourceRepositoryRoot,
  });
  const order: string[] = [];
  const beginReview = vi.spyOn(
    candidateGateAttemptStore,
    'beginReview',
  ).mockImplementation(async (input) => {
    order.push('reviewing');
    return beginCandidateGateReview(input.expected, {
      reviewSubjectManifestDigest: input.manifest.manifestDigest,
      reviewerInputDigest: input.reviewerInputDigest,
      occurredAt: '2026-07-29T10:00:02.000Z',
    });
  });
  const complete = vi.spyOn(
    candidateGateAttemptStore,
    'complete',
  ).mockImplementation(async (input) => {
    order.push('completed');
    return completeCandidateGateAttempt(input.expected, {
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      reviewerPayloadDigest: input.reviewerPayloadDigest,
      freshCriteriaVerdictDigest: input.verdict === null
        ? null
        : canonicalDigest(
            'wukong/fresh-criteria-verdict/v1',
            input.verdict,
          ),
      reviewerVerdictStatus: input.reviewerVerdictStatus,
      occurredAt: '2026-07-29T10:00:03.000Z',
    });
  });
  const workspaceIdentityDigest = digest('workspace');
  const trustProposal = createBrokerReviewTrustProposal({
    workspaceIdentityDigest,
    intent: 'once',
  });
  const brokerReviewTrust = grantBrokerReviewTrust(
    trustProposal,
    trustProposal.trustProposalDigest,
  );
  const consentProposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest,
    allowedOrigins: [
      'changed-tracked',
      'explicit-untracked',
      'scope-match',
      'gate-evidence',
    ],
    providerId: 'test-provider',
    endpoint: 'https://review.example.test/v1',
  });
  const reviewSubjectConsent = acknowledgeReviewSubjectConsent(
    consentProposal,
    consentProposal.consentProposalDigest,
  );
  const runtime = {
    attemptId: ATTEMPT_ID,
    runId: 'run_candidate_reviewer',
    contractId: 'contract_candidate_reviewer',
    planDigest: gatePlanDigest,
    selectionDigest: digest('selection'),
    runSettingsRef: 'run-settings',
    runSettings: {
      schemaVersion: 2,
      legacy: {
        writerModel: 'writer-model',
        reviewerModel: 'reviewer-model',
        permissionMode: 'manual',
        maxIterations: 10,
      },
      legacySettingsDigest: digest('legacy-settings'),
      brokerReviewTrust,
      reviewSubjectConsent,
      settingsDigest: digest('settings'),
    },
    workspaceIdentityDigest,
    criteria: [],
    carriedBlockerKeys: [],
    reviewPolicy: { mode: 'advisory-live' },
  } satisfies LoopGateReviewRuntimeV2;
  const spawn = vi.fn(async (options: {
    readonly prompt: string;
    readonly internalTools?: readonly ExecutableTool[];
  }) => {
    order.push('spawn');
    await inspectTools?.(options.internalTools ?? []);
    return {
      agentId: 'reviewer-agent',
      profileName: 'fresh-reviewer',
      resumed: false,
      completion: Promise.resolve({ result: result(options.prompt) }),
    };
  });
  const agent = {
    config: {
      cwd: sourceRepositoryRoot,
      modelAlias: 'reviewer-model',
    },
    modelProvider: {
      resolveProviderConfig: () => ({
        providerName: 'test-provider',
        provider: {
          type: 'anthropic',
          model: 'reviewer-model',
          baseUrl: 'https://review.example.test/v1',
        },
        modelCapabilities: {},
        type: 'anthropic',
        protocol: undefined,
      }),
    },
    subagentHost: { spawn },
  } as unknown as Pick<
    Agent,
    'config' | 'modelProvider' | 'subagentHost'
  >;
  return {
    input: {
      agent,
      worktreeLeaseStore,
      candidateDeltaStore,
      candidateGateAttemptStore,
      rootCapability,
      bootstrapPlan: {
        bootstrapPlanDigest: digest('bootstrap'),
      } as never,
      expectedAttempt,
      deterministicGate,
      reviewPlan,
      runtime,
      objective: 'Keep candidate behavior correct',
      parentToolCallId: 'tool-call-candidate-reviewer',
      signal: new AbortController().signal,
    },
    spawn,
    beginReview,
    complete,
    order,
  };
}

function freshPass(prompt: string): string {
  const attemptId = prompt.match(/Attempt: ([^\n]+)/u)?.[1];
  const reviewerInputDigest =
    prompt.match(/Reviewer input digest: ([^\n]+)/u)?.[1];
  return `FRESH_VERDICT_JSON: ${JSON.stringify({
    schemaVersion: 1,
    attemptId,
    reviewerInputDigest,
    status: 'PASS',
    criterionDispositions: [],
    priorBlockerDispositions: [],
    findings: [],
  })}`;
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/candidate-fresh-reviewer/v1',
    label,
  );
}
