import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildFinishLine,
  acknowledgeReviewSubjectConsent,
  canonicalDigest,
  createBrokerReviewTrustProposal,
  createCandidateBootstrapPlan,
  createReviewSubjectConsentProposal,
  grantBrokerReviewTrust,
  inspectSourceSnapshot,
  sealSourceSnapshot,
  type CandidateBootstrapPlanV1,
  type FinishLineProposal,
  type ReviewSubjectBroker,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CandidateDeltaStore } from '../src/candidate-delta-store';
import { runCandidateDeterministicGate } from '../src/candidate-gate-executor';
import { withCandidateReviewBroker } from '../src/candidate-review-broker';
import { createCandidateBrokeredReviewPlan } from '../src/candidate-review-plan';
import { SnapshotBlobLeaseStore } from '../src/snapshot-blob-lease-store';
import {
  type ActivatedWorktreeLeaseV1,
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T05:00:00.000Z');

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('candidate deterministic Gate', () => {
  it('binds a passing proof to the exact sealed candidate delta', async () => {
    const value = await fixture();
    await value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });
    await writeFile(
      join(value.candidateDirectory, 'candidate.ts'),
      'export const candidate = true;\n',
    );
    await rm(join(value.candidateDirectory, 'remove-me.ts'));
    await value.worktreeStore.transition(value.active.binding, 'verifying');

    const result = await runCandidateDeterministicGate({
      worktreeLeaseStore: value.worktreeStore,
      candidateDeltaStore: value.deltaStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
      contract: value.finishLine,
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      candidateId: value.active.lease.candidateId,
      leaseId: value.active.lease.leaseId,
      status: 'passed',
      reasonCode: 'passed',
      gatePlanDigest: value.finishLine.gatePlan.planDigest,
      proof: {
        status: 'passed',
        verification: {
          commandResults: [{
            command: 'node index.js',
            status: 'passed',
          }],
        },
      },
    });
    expect(result.candidateDeltaDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.candidateDeltaSealDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const seal = (await value.deltaStore.inspect(
      value.active.lease.candidateId,
    )).seal;
    expect(seal?.delta.candidateDeltaDigest).toBe(result.candidateDeltaDigest);
    if (seal === null) throw new Error('Candidate delta seal missing.');
    const reviewPlan = createCandidateBrokeredReviewPlan({
      deltaSeal: seal,
      deterministicGate: result,
    });
    expect(reviewPlan.subjectCandidates).toEqual([{
      logicalPath: 'candidate.ts',
      origin: 'explicit-untracked',
    }]);
    expect(reviewPlan.gateEvidence.filter(
      ({ producerId }) => producerId === 'candidate-delta',
    )).toHaveLength(2);
    expect(reviewPlan.gateEvidence.map(({ content }) => String(content)).join(
      '\n',
    )).toContain('"operation":"delete"');
    expect(reviewPlan.reviewPlanDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const workspaceIdentityDigest = digest('source-workspace');
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
    let escapedBroker: ReviewSubjectBroker | undefined;
    await expect(withCandidateReviewBroker({
      worktreeLeaseStore: value.worktreeStore,
      candidateDeltaStore: value.deltaStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
      reviewPlan,
      candidateGateAttemptId: '019f8c70-0000-7abc-8def-0123456789ab',
      runId: 'run_gate',
      contractId: 'contract_gate',
      planDigest: value.finishLine.gatePlan.planDigest,
      sourceWorkspaceIdentityDigest: workspaceIdentityDigest,
      brokerReviewTrust,
      reviewSubjectConsent,
    }, (broker) => {
      escapedBroker = broker;
      expect(broker.manifest.entries).toHaveLength(1);
      expect(broker.readReviewSubject(
        broker.manifest.entries[0]!.subjectRef,
      )).toContain('candidate = true');
      expect(broker.manifest.gateEvidence).not.toHaveLength(0);
    })).resolves.toBeUndefined();
    expect(() => escapedBroker?.readReviewSubject('escaped'))
      .toThrow(/already been destroyed/u);
    await expect(withCandidateReviewBroker({
      worktreeLeaseStore: value.worktreeStore,
      candidateDeltaStore: value.deltaStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
      reviewPlan,
      candidateGateAttemptId: '019f8c70-0001-7abc-8def-0123456789ab',
      runId: 'run_gate',
      contractId: 'contract_gate',
      planDigest: value.finishLine.gatePlan.planDigest,
      sourceWorkspaceIdentityDigest: workspaceIdentityDigest,
      brokerReviewTrust,
      reviewSubjectConsent,
    }, async () => {
      await writeFile(
        join(value.candidateDirectory, 'candidate.ts'),
        'export const candidate = false;\n',
      );
    })).rejects.toMatchObject({
      reasonCode: 'candidate_delta_conflict',
    });
  });

  it('returns NEEDS_WORK evidence for a failing check on the sealed delta', async () => {
    const value = await fixture();
    await value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });
    await writeFile(
      join(value.candidateDirectory, 'index.js'),
      'export const value = ;\n',
    );
    const verifying = await value.worktreeStore.transition(
      value.active.binding,
      'verifying',
    );

    const blocked = await runCandidateDeterministicGate({
      worktreeLeaseStore: value.worktreeStore,
      candidateDeltaStore: value.deltaStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
      contract: value.finishLine,
    });
    expect(blocked).toMatchObject({
      candidateId: value.active.lease.candidateId,
      status: 'blocked',
      reasonCode: 'check_failed',
      proof: {
        status: 'blocked',
      },
    });
    const activeAgain = await value.worktreeStore.transition(
      verifying.binding,
      'active',
    );
    await writeFile(
      join(value.candidateDirectory, 'index.js'),
      'export const value = 2;\n',
    );
    await value.worktreeStore.transition(activeAgain.binding, 'verifying');
    const passed = await runCandidateDeterministicGate({
      worktreeLeaseStore: value.worktreeStore,
      candidateDeltaStore: value.deltaStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
      contract: value.finishLine,
    });
    expect(passed.status).toBe('passed');
    expect(passed.candidateDeltaDigest).not.toBe(
      blocked.candidateDeltaDigest,
    );
    expect((await value.deltaStore.inspect(
      value.active.lease.candidateId,
    )).seal?.delta.candidateDeltaDigest).toBe(
      passed.candidateDeltaDigest,
    );
  });

  it('fails closed when a check mutates promotable candidate content', async () => {
    const value = await fixture([
      'node -e "require(\'node:fs\').writeFileSync(\'index.js\', \'changed\\\\n\')"',
    ]);
    await value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });
    await value.worktreeStore.transition(value.active.binding, 'verifying');

    await expect(runCandidateDeterministicGate({
      worktreeLeaseStore: value.worktreeStore,
      candidateDeltaStore: value.deltaStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
      contract: value.finishLine,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_delta_conflict',
    });
  });
});

interface Fixture {
  readonly candidateDirectory: string;
  readonly worktreeStore: WorktreeLeaseStore;
  readonly deltaStore: CandidateDeltaStore;
  readonly active: ActivatedWorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly finishLine: FinishLineProposal;
}

async function fixture(
  checks: readonly string[] = ['node index.js'],
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-candidate-gate-'));
  roots.push(parent);
  const repository = join(parent, 'repository');
  const candidatesRoot = join(parent, 'candidates');
  await mkdir(repository);
  await git(repository, ['init']);
  await writeFile(join(repository, 'index.js'), 'export const value = 1;\n');
  await writeFile(join(repository, 'remove-me.ts'), 'remove this\n');
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  const finishLine = await buildFinishLine({
    cwd: repository,
    objective: 'Keep the candidate syntax valid',
    explicitChecks: [...checks],
    includeDiscoveredChecks: false,
  });
  if (!finishLine.ok) {
    throw new Error('Unable to create Gate fixture.');
  }
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
    expiresAt: '2026-07-29T05:10:00.000Z',
  });
  const blob = await blobStore.confirm(staged.binding);
  const bootstrapPlan = createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8c30-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: snapshot.snapshotDigest,
    gatePlanDigest: finishLine.proposal.gatePlan.planDigest,
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
    goalId: 'goal_gate',
    contractId: 'contract_gate',
    runId: 'run_gate',
    ownerRunId: 'run_owner',
    bootstrapPlanDigest: bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: finishLine.proposal.gatePlan.planDigest,
    criteriaSelectionDigest: null,
    expiresAt: '2026-07-29T05:10:00.000Z',
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
  return {
    candidateDirectory: materializing.candidateDirectory,
    worktreeStore,
    deltaStore: new CandidateDeltaStore({
      privateRootDirectory: candidatesRoot,
      sourceRepositoryRoot: repository,
      now: () => new Date(BASE_TIME + 2_000),
    }),
    active,
    bootstrapPlan,
    finishLine: finishLine.proposal,
  };
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-gate/v1', label);
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
