import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  canonicalDigest,
  canonicalJson,
  createCandidateBootstrapPlan,
  createReviewSubjectConsentProposal,
  inspectSourceSnapshot,
  ReviewSubjectBroker,
  sealSourceSnapshot,
  type CandidateBootstrapPlanV1,
  type FreshCriteriaVerdictV1,
  type FinishLineProposal,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CandidateDeltaStore } from '../src/candidate-delta-store';
import {
  CandidateGateAttemptStore,
  CandidateGateAttemptStoreError,
} from '../src/candidate-gate-attempt-store';
import { runCandidateDeterministicGate } from '../src/candidate-gate-executor';
import { createCandidateBrokeredReviewPlan } from '../src/candidate-review-plan';
import { SnapshotBlobLeaseStore } from '../src/snapshot-blob-lease-store';
import {
  type ActivatedWorktreeLeaseV1,
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T09:00:00.000Z');
const ATTEMPT_ID = '019f8c80-0000-7abc-8def-0123456789ab';

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('CandidateGateAttemptStore', () => {
  it('returns typed not-found from an empty private root', async () => {
    const parent = await mkdtemp(
      join(tmpdir(), 'wukong-empty-gate-attempt-store-'),
    );
    roots.push(parent);
    const repository = join(parent, 'repository');
    const privateRoot = join(parent, 'attempts');
    await Promise.all([
      mkdir(repository),
      mkdir(privateRoot, { mode: 0o700 }),
    ]);
    const store = new CandidateGateAttemptStore({
      privateRootDirectory: privateRoot,
      sourceRepositoryRoot: repository,
    });

    await expect(store.inspect({
      candidateId: '019f8c80-0002-7abc-8def-0123456789ab',
      candidateGateAttemptId: ATTEMPT_ID,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_gate_attempt_not_found',
    });
    expect(await readdir(privateRoot)).toEqual([]);
  });

  it('persists an exact reviewer-backed PASS with idempotent CAS retries', async () => {
    const value = await fixture();
    const prepared = await value.attemptStore.initialize({
      ...live(value),
      candidateGateAttemptId: ATTEMPT_ID,
    });
    const deterministicPair = await Promise.all([
      value.attemptStore.recordDeterministic({
        ...live(value),
        expected: prepared,
        deterministicGate: value.deterministicGate,
        reviewPlan: value.reviewPlan,
      }),
      value.attemptStore.recordDeterministic({
        ...live(value),
        expected: prepared,
        deterministicGate: value.deterministicGate,
        reviewPlan: value.reviewPlan,
      }),
    ]);
    expect(deterministicPair[0].stateDigest)
      .toBe(deterministicPair[1].stateDigest);
    const deterministic = deterministicPair[0];
    const reviewerInputDigest = digest('reviewer-input');
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: value.candidateDirectory,
      attemptId: ATTEMPT_ID,
      runId: 'run_gate_attempt',
      contractId: 'contract_gate_attempt',
      planDigest: value.finishLine.gatePlan.planDigest,
      workspaceFingerprint: value.reviewPlan.workspaceFingerprint,
      consent: value.reviewSubjectConsent,
      candidates: value.reviewPlan.subjectCandidates,
      gateEvidence: value.reviewPlan.gateEvidence,
    });
    const reviewing = await value.attemptStore.beginReview({
      ...live(value),
      expected: deterministic,
      reviewPlan: value.reviewPlan,
      manifest: broker.manifest,
      reviewerInputDigest,
    });
    broker.destroy();
    const verdict: FreshCriteriaVerdictV1 = {
      schemaVersion: 1,
      attemptId: ATTEMPT_ID,
      reviewerInputDigest,
      status: 'PASS',
      criterionDispositions: [],
      priorBlockerDispositions: [],
      findings: [],
    };
    const completed = await value.attemptStore.complete({
      ...live(value),
      expected: reviewing,
      outcome: 'PASS',
      reasonCode: 'passed',
      reviewerPayloadDigest: digest('payload'),
      verdict,
      reviewerVerdictStatus: 'PASS',
    });

    expect(completed).toMatchObject({
      state: 'completed',
      casRevision: 3,
      candidateGateResult: {
        candidateGateOutcome: 'PASS',
        candidateDeltaDigest: value.reviewPlan.candidateDeltaDigest,
      },
    });
    expect((await value.attemptStore.complete({
      ...live(value),
      expected: reviewing,
      outcome: 'PASS',
      reasonCode: 'passed',
      reviewerPayloadDigest: digest('payload'),
      verdict,
      reviewerVerdictStatus: 'PASS',
    })).stateDigest).toBe(completed.stateDigest);
    expect((await value.attemptStore.inspect({
      candidateId: value.active.lease.candidateId,
      candidateGateAttemptId: ATTEMPT_ID,
    })).stateDigest).toBe(completed.stateDigest);
  });

  it('repairs one journal-ahead transition and fails closed on tampering', async () => {
    const value = await fixture();
    const prepared = await value.attemptStore.initialize({
      ...live(value),
      candidateGateAttemptId: ATTEMPT_ID,
    });
    const deterministic = await value.attemptStore.recordDeterministic({
      ...live(value),
      expected: prepared,
      deterministicGate: value.deterministicGate,
      reviewPlan: value.reviewPlan,
    });
    const reviewerInputDigest = digest('reviewer-input');
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: value.candidateDirectory,
      attemptId: ATTEMPT_ID,
      runId: 'run_gate_attempt',
      contractId: 'contract_gate_attempt',
      planDigest: value.finishLine.gatePlan.planDigest,
      workspaceFingerprint: value.reviewPlan.workspaceFingerprint,
      consent: value.reviewSubjectConsent,
      candidates: value.reviewPlan.subjectCandidates,
      gateEvidence: value.reviewPlan.gateEvidence,
    });
    const reviewing = await value.attemptStore.beginReview({
      ...live(value),
      expected: deterministic,
      reviewPlan: value.reviewPlan,
      manifest: broker.manifest,
      reviewerInputDigest,
    });
    broker.destroy();
    const completed = await value.attemptStore.complete({
      ...live(value),
      expected: reviewing,
      outcome: 'ERROR',
      reasonCode: 'reviewer_invalid_output',
      reviewerPayloadDigest: digest('invalid-payload'),
      verdict: null,
      reviewerVerdictStatus: null,
    });
    const paths = privatePaths(value);
    await writeFile(paths.state, canonicalJson(reviewing));
    const recoveredStore = new CandidateGateAttemptStore({
      privateRootDirectory: value.candidatesRoot,
      sourceRepositoryRoot: value.repository,
      now: () => new Date(BASE_TIME + 5_000),
    });
    expect((await recoveredStore.inspect({
      candidateId: value.active.lease.candidateId,
      candidateGateAttemptId: ATTEMPT_ID,
    })).stateDigest).toBe(completed.stateDigest);

    const eventPath = join(paths.events, '000000000003.json');
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
      eventDigest: string;
    };
    event.eventDigest = digest('tampered-event');
    await writeFile(eventPath, JSON.stringify(event));
    await expect(recoveredStore.inspect({
      candidateId: value.active.lease.candidateId,
      candidateGateAttemptId: ATTEMPT_ID,
    })).rejects.toBeInstanceOf(CandidateGateAttemptStoreError);
    await expect(recoveredStore.inspect({
      candidateId: value.active.lease.candidateId,
      candidateGateAttemptId: ATTEMPT_ID,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_gate_attempt_integrity_failed',
    });
  });

  it('rejects credential-shaped durable reasons before record/journal persistence', async () => {
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const value = await fixture();
    const prepared = await value.attemptStore.initialize({
      ...live(value),
      candidateGateAttemptId: ATTEMPT_ID,
    });
    const deterministic = await value.attemptStore.recordDeterministic({
      ...live(value),
      expected: prepared,
      deterministicGate: value.deterministicGate,
      reviewPlan: value.reviewPlan,
    });
    const reviewerInputDigest = digest('privacy-reviewer-input');
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: value.candidateDirectory,
      attemptId: ATTEMPT_ID,
      runId: 'run_gate_attempt',
      contractId: 'contract_gate_attempt',
      planDigest: value.finishLine.gatePlan.planDigest,
      workspaceFingerprint: value.reviewPlan.workspaceFingerprint,
      consent: value.reviewSubjectConsent,
      candidates: value.reviewPlan.subjectCandidates,
      gateEvidence: value.reviewPlan.gateEvidence,
    });
    const reviewing = await value.attemptStore.beginReview({
      ...live(value),
      expected: deterministic,
      reviewPlan: value.reviewPlan,
      manifest: broker.manifest,
      reviewerInputDigest,
    });
    broker.destroy();

    await expect(value.attemptStore.complete({
      ...live(value),
      expected: reviewing,
      outcome: 'ERROR',
      reasonCode: secret,
      reviewerPayloadDigest: digest('privacy-payload'),
      verdict: null,
      reviewerVerdictStatus: null,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_gate_attempt_invalid_input',
    });
    await expect(value.attemptStore.complete({
      ...live(value),
      expected: reviewing,
      outcome: 'ERROR',
      reasonCode: `{"AWS_SECRET_ACCESS_KEY":"${awsSecret}"}`,
      reviewerPayloadDigest: digest('privacy-json-payload'),
      verdict: null,
      reviewerVerdictStatus: null,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_gate_attempt_invalid_input',
    });
    const durableText = await readTreeText(
      privatePaths(value).directory,
    );
    expect(durableText).not.toContain(secret);
    expect(durableText).not.toContain(awsSecret);
    await expect(value.attemptStore.inspect({
      candidateId: value.active.lease.candidateId,
      candidateGateAttemptId: ATTEMPT_ID,
    })).resolves.toMatchObject({ state: 'reviewing' });
  });

  it('rejects stale CAS and candidate/delta binding changes', async () => {
    const value = await fixture();
    const prepared = await value.attemptStore.initialize({
      ...live(value),
      candidateGateAttemptId: ATTEMPT_ID,
    });
    await value.attemptStore.recordDeterministic({
      ...live(value),
      expected: prepared,
      deterministicGate: value.deterministicGate,
      reviewPlan: value.reviewPlan,
    });
    const fakeManifest = {
      schemaVersion: 1 as const,
      attemptId: ATTEMPT_ID,
      runId: 'run_gate_attempt',
      contractId: 'contract_gate_attempt',
      planDigest: value.finishLine.gatePlan.planDigest,
      consentDigest: value.reviewSubjectConsent.consentDigest,
      workspaceFingerprint: value.reviewPlan.workspaceFingerprint,
      policyVersion: value.reviewSubjectConsent.reviewSubjectPolicyVersion,
      entries: [],
      exclusions: [],
      gateEvidence: [],
      gateEvidenceExclusions: [],
      manifestDigest: digest('manifest'),
    };
    await expect(value.attemptStore.beginReview({
      ...live(value),
      expected: prepared,
      reviewPlan: value.reviewPlan,
      manifest: fakeManifest,
      reviewerInputDigest: digest('reviewer-input'),
    })).rejects.toMatchObject({
      reasonCode: 'candidate_gate_attempt_stale_binding',
    });

    await writeFile(
      join(value.candidateDirectory, 'candidate.ts'),
      'export const candidate = false;\n',
    );
    await expect(value.attemptStore.inspect({
      candidateId: value.active.lease.candidateId,
      candidateGateAttemptId: ATTEMPT_ID,
    })).resolves.toMatchObject({ state: 'deterministic_completed' });
    await expect(value.attemptStore.initialize({
      ...live(value),
      candidateGateAttemptId: '019f8c80-0001-7abc-8def-0123456789ab',
    })).rejects.toMatchObject({
      reasonCode: 'candidate_delta_conflict',
    });
  });
});

interface Fixture {
  readonly repository: string;
  readonly candidatesRoot: string;
  readonly candidateDirectory: string;
  readonly worktreeStore: WorktreeLeaseStore;
  readonly deltaStore: CandidateDeltaStore;
  readonly attemptStore: CandidateGateAttemptStore;
  readonly active: ActivatedWorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly finishLine: FinishLineProposal;
  readonly deterministicGate:
    Awaited<ReturnType<typeof runCandidateDeterministicGate>>;
  readonly reviewPlan:
    ReturnType<typeof createCandidateBrokeredReviewPlan>;
  readonly reviewSubjectConsent:
    ReturnType<typeof acknowledgeReviewSubjectConsent>;
}

function live(value: Fixture) {
  return {
    worktreeLeaseStore: value.worktreeStore,
    candidateDeltaStore: value.deltaStore,
    rootCapability: value.active.rootCapability,
    bootstrapPlan: value.bootstrapPlan,
  };
}

function privatePaths(value: Fixture) {
  const directory = join(
    value.candidatesRoot,
    value.active.lease.candidateId,
    'candidate-gate-attempts',
  );
  return {
    directory,
    state: join(directory, `${ATTEMPT_ID}.json`),
    events: join(directory, 'events', ATTEMPT_ID),
  };
}

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-gate-attempt-store-'));
  roots.push(parent);
  const repository = join(parent, 'repository');
  const candidatesRoot = join(parent, 'candidates');
  await mkdir(repository);
  await git(repository, ['init']);
  await writeFile(join(repository, 'index.js'), 'export const value = 1;\n');
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  const finishLineResult = await buildFinishLine({
    cwd: repository,
    objective: 'Keep candidate syntax valid',
    explicitChecks: ['node index.js'],
    includeDiscoveredChecks: false,
  });
  if (!finishLineResult.ok) throw new Error('Unable to build Finish Line.');
  const finishLine = finishLineResult.proposal;
  const inspected = await inspectSourceSnapshot({ cwd: repository });
  if (inspected.status !== 'ready' || inspected.proposedSnapshot === null) {
    throw new Error('Unable to inspect source fixture.');
  }
  const snapshot = inspected.proposedSnapshot;
  const sealed = await sealSourceSnapshot({ cwd: repository, snapshot });
  const blobStore = new SnapshotBlobLeaseStore({
    rootDirectory: join(parent, 'blobs'),
    now: () => new Date(BASE_TIME),
  });
  const staged = await blobStore.stageAndSeal({
    containerBytes: sealed.containerBytes,
    sourceSnapshot: snapshot,
    createdByRunId: 'run_creator',
    ownerRunId: 'run_owner',
    expiresAt: '2026-07-29T09:10:00.000Z',
  });
  const blob = await blobStore.confirm(staged.binding);
  const bootstrapPlan = createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8c81-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: snapshot.snapshotDigest,
    gatePlanDigest: finishLine.gatePlan.planDigest,
    ecosystemRefs: [],
    lockfileDigests: [],
    steps: [],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: digest('budget'),
  });
  const worktreeStore = new WorktreeLeaseStore({
    candidatesRootDirectory: candidatesRoot,
    now: () => new Date(BASE_TIME + 1_000),
  });
  const reserved = await worktreeStore.reserve({
    sourceRepositoryRoot: repository,
    sourceSnapshot: snapshot,
    snapshotBlobLease: blob.lease,
    goalId: 'goal_gate_attempt',
    contractId: 'contract_gate_attempt',
    runId: 'run_gate_attempt',
    ownerRunId: 'run_owner',
    bootstrapPlanDigest: bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: finishLine.gatePlan.planDigest,
    criteriaSelectionDigest: null,
    expiresAt: '2026-07-29T09:10:00.000Z',
  });
  const materializing = await worktreeStore.beginMaterialization(
    reserved.binding,
  );
  await git(repository, [
    'worktree',
    'add',
    '--detach',
    materializing.candidateDirectory,
    snapshot.baseCommit,
  ]);
  await chmod(materializing.candidateDirectory, 0o700);
  const materialized = await worktreeStore.completeMaterialization(
    materializing.binding,
    {
      candidatePathIdentity:
        await candidatePathIdentity(materializing.candidateDirectory),
      materializedSourceDigest: digest('materialized'),
      bootstrapRequired: false,
    },
  );
  const active = await worktreeStore.activate(materialized.binding);
  const deltaStore = new CandidateDeltaStore({
    privateRootDirectory: candidatesRoot,
    sourceRepositoryRoot: repository,
    now: () => new Date(BASE_TIME + 2_000),
  });
  await deltaStore.initializeBaseline({
    worktreeLeaseStore: worktreeStore,
    rootCapability: active.rootCapability,
    bootstrapPlan,
  });
  await writeFile(
    join(materializing.candidateDirectory, 'candidate.ts'),
    'export const candidate = true;\n',
  );
  await worktreeStore.transition(active.binding, 'verifying');
  const deterministicGate = await runCandidateDeterministicGate({
    worktreeLeaseStore: worktreeStore,
    candidateDeltaStore: deltaStore,
    rootCapability: active.rootCapability,
    bootstrapPlan,
    contract: finishLine,
  });
  if (deterministicGate.status !== 'passed') {
    throw new Error('Candidate deterministic Gate did not pass.');
  }
  const seal = (await deltaStore.inspect(active.lease.candidateId)).seal;
  if (seal === null) throw new Error('Candidate delta seal missing.');
  const reviewPlan = createCandidateBrokeredReviewPlan({
    deltaSeal: seal,
    deterministicGate,
  });
  const workspaceIdentityDigest = digest('workspace');
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
  return {
    repository,
    candidatesRoot,
    candidateDirectory: materializing.candidateDirectory,
    worktreeStore,
    deltaStore,
    attemptStore: new CandidateGateAttemptStore({
      privateRootDirectory: candidatesRoot,
      sourceRepositoryRoot: repository,
      now: () => new Date(BASE_TIME + 3_000),
    }),
    active,
    bootstrapPlan,
    finishLine,
    deterministicGate,
    reviewPlan,
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
    ),
  };
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-gate-attempt-store/v1', label);
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root });
  return result.stdout;
}

async function candidatePathIdentity(path: string): Promise<string> {
  const [actualPath, info] = await Promise.all([
    realpath(path),
    stat(path, { bigint: true }),
  ]);
  return canonicalDigest('wukong/candidate-path-identity/v1', {
    pathDigest: canonicalDigest('wukong/private-path/v1', actualPath),
    device: info.dev.toString(),
    inode: info.ino.toString(),
  });
}

async function readTreeText(root: string): Promise<string> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(await readTreeText(path));
    else if (entry.isFile()) {
      output.push(await readFile(path, 'utf8').catch(() => ''));
    }
  }
  return output.join('\n');
}
