import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  candidateBootstrapRecipeFor,
  canonicalDigest,
  createBrokerReviewTrustProposal,
  createCandidateBootstrapPlan,
  createCandidateBootstrapPreflight,
  createCandidateBootstrapPreflightEntry,
  createReviewSubjectConsentProposal,
  grantBrokerReviewTrust,
  inspectSourceSnapshot,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCandidateBootstrapPlan,
} from '../src/candidate-bootstrap-plan-builder';
import {
  IsolatedLoopCandidatePreparerError,
  prepareIsolatedLoopCandidate,
} from '../src/isolated-loop-candidate-preparer';
import {
  runIsolatedLoopCandidateIteration,
} from '../src/isolated-loop-candidate-iteration';
import type { Agent } from '../src/agent';
import type {
  LoopGateReviewRuntimeV2,
  LoopRunSettingsV2,
} from '../src/agent/goal';
import { CandidateDeltaStore } from '../src/candidate-delta-store';
import {
  CandidateGateAttemptStore,
} from '../src/candidate-gate-attempt-store';
import { SnapshotBlobLeaseStore } from '../src/snapshot-blob-lease-store';
import {
  SnapshotCandidateMaterializer,
} from '../src/snapshot-candidate-materializer';
import { WorktreeLeaseStore } from '../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T08:00:00.000Z');
const IDS = {
  goal: '10000000-0000-4000-8000-000000000001',
  contract: '20000000-0000-4000-8000-000000000002',
  run: '30000000-0000-4000-8000-000000000003',
  ownerRun: '40000000-0000-4000-8000-000000000004',
  bootstrapPlan: '50000000-0000-4000-8000-000000000005',
} as const;

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/isolated-loop-candidate-preparer/v1',
    label,
  );
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root });
  return result.stdout;
}

async function fixture() {
  const parent = await mkdtemp(
    join(tmpdir(), 'wukong-isolated-candidate-preparer-'),
  );
  roots.push(parent);
  const repository = join(parent, 'repository');
  await mkdir(repository);
  await git(repository, ['init']);
  await writeFile(join(repository, 'main.ts'), 'export const value = 1;\n');
  await git(repository, ['add', 'main.ts']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  await writeFile(join(repository, 'main.ts'), 'export const value = 2;\n');
  const finishLine = await buildFinishLine({
    cwd: repository,
    objective: 'Update the isolated candidate',
    completionCriterion: 'The candidate passes its frozen Gate',
    includeDiscoveredChecks: false,
  });
  if (!finishLine.ok) {
    throw new Error('Unable to build the test Finish Line.');
  }
  const inspected = await inspectSourceSnapshot({ cwd: repository });
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null) {
    throw new Error('Unable to inspect the test repository.');
  }
  const gatePlanDigest = finishLine.proposal.gatePlan.planDigest;
  const bootstrapPlan = createCandidateBootstrapPlan({
    bootstrapPlanId: IDS.bootstrapPlan,
    sourceSnapshotDigest: inspected.proposedSnapshot.snapshotDigest,
    gatePlanDigest,
    ecosystemRefs: [],
    lockfileDigests: [],
    steps: [],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: digest('budget'),
  });
  const snapshotBlobLeaseStore = new SnapshotBlobLeaseStore({
    rootDirectory: join(parent, 'snapshot-blobs'),
    now: () => new Date(BASE_TIME),
  });
  const worktreeLeaseStore = new WorktreeLeaseStore({
    candidatesRootDirectory: join(parent, 'candidates'),
    now: () => new Date(BASE_TIME + 1_000),
  });
  return {
    parent,
    repository,
    snapshot: inspected.proposedSnapshot,
    gatePlanDigest,
    bootstrapPlan,
    snapshotBlobLeaseStore,
    worktreeLeaseStore,
    materializer: new SnapshotCandidateMaterializer({
      now: () => new Date(BASE_TIME + 2_000),
    }),
    finishLine: finishLine.proposal,
  };
}

function reviewRuntime(
  value: Awaited<ReturnType<typeof fixture>>,
): LoopGateReviewRuntimeV2 {
  const workspaceIdentityDigest =
    value.finishLine.workspaceIdentity.workspaceIdentityDigest;
  const trustProposal = createBrokerReviewTrustProposal({
    workspaceIdentityDigest,
    intent: 'once',
  });
  const consentProposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest,
    allowedOrigins: [
      'changed-tracked',
      'explicit-untracked',
      'scope-match',
      'gate-evidence',
    ],
    providerId: 'anthropic',
    endpoint: 'https://api.anthropic.com',
  });
  const legacy = {
    permissionMode: 'manual' as const,
    maxIterations: 10,
  };
  const settingsCore = {
    schemaVersion: 2 as const,
    legacy,
    legacySettingsDigest: canonicalDigest(
      'wukong/loop-run-settings/legacy/v1',
      legacy,
    ),
    brokerReviewTrust: grantBrokerReviewTrust(
      trustProposal,
      trustProposal.trustProposalDigest,
      'test-isolated-broker-trust',
    ),
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
      BASE_TIME,
    ),
  };
  const runSettings: LoopRunSettingsV2 = {
    ...settingsCore,
    settingsDigest: canonicalDigest(
      'wukong/loop-run-settings/v2',
      settingsCore,
    ),
  };
  return {
    attemptId: '60000000-0000-4000-8000-000000000006',
    runId: IDS.run,
    contractId: IDS.contract,
    planDigest: value.gatePlanDigest,
    selectionDigest: digest('none-selection'),
    runSettingsRef: '70000000-0000-4000-8000-000000000007',
    runSettings,
    workspaceIdentityDigest,
    criteria: [{
      criterionId: 'objective',
      criterionProvenanceDigest: digest('objective-provenance'),
      text: value.finishLine.objective,
    }],
    carriedBlockerKeys: [],
    reviewPolicy: value.finishLine.reviewPolicy,
  };
}

describe('prepareIsolatedLoopCandidate', () => {
  it('binds, materializes and activates an exact no-bootstrap candidate', async () => {
    const value = await fixture();
    const recorded: string[] = [];

    const prepared = await prepareIsolatedLoopCandidate({
      sourceRepositoryRoot: value.repository,
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      snapshotBlobLeaseStore: value.snapshotBlobLeaseStore,
      worktreeLeaseStore: value.worktreeLeaseStore,
      materializer: value.materializer,
      goalId: IDS.goal,
      contractId: IDS.contract,
      runId: IDS.run,
      ownerRunId: IDS.ownerRun,
      bootstrapPlan: value.bootstrapPlan,
      gatePlanDigest: value.gatePlanDigest,
      criteriaSelectionDigest: null,
      expiresAt: '2026-07-29T08:10:00.000Z',
      recordBinding: (binding) => {
        recorded.push(binding.bindingDigest);
        return binding;
      },
    });

    expect(recorded).toEqual([prepared.binding.bindingDigest]);
    expect(prepared.worktree.lease).toMatchObject({
      state: 'active',
      candidateId: prepared.binding.candidateId,
      leaseId: prepared.binding.worktreeLeaseId,
    });
    expect(await readFile(
      join(
        value.parent,
        'candidates',
        prepared.binding.candidateId,
        'worktree',
        'main.ts',
      ),
      'utf8',
    )).toBe('export const value = 2;\n');
    const blobLeaseId = prepared.worktree.lease.snapshotBlobLeaseId;
    expect((await value.snapshotBlobLeaseStore.inspect(blobLeaseId)).state)
      .toBe('destroyed');
    await expect(access(join(
      value.parent,
      'snapshot-blobs',
      blobLeaseId,
      'payload.bin',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes an exact confirmed bootstrap plan before activating', async () => {
    const value = await fixture();
    const bin = join(value.parent, 'bin');
    await mkdir(bin);
    await symlink('/bin/echo', join(bin, 'npm'));
    const recipe = candidateBootstrapRecipeFor(
      'node',
      'package-lock.json',
    );
    if (recipe === null) throw new Error('Missing Node recipe.');
    const preflight = createCandidateBootstrapPreflight({
      sourceSnapshotDigest: value.snapshot.snapshotDigest,
      gatePlanDigest: value.gatePlanDigest,
      entries: [createCandidateBootstrapPreflightEntry({
        ecosystem: 'node',
        ecosystemRef: 'node:npm',
        candidateRelativeCwd: '.',
        manifestPath: 'package.json',
        manifestDigest: digest('package-json'),
        lockfilePath: 'package-lock.json',
        lockfileDigest: digest('package-lock'),
        status: 'ready',
        reasonCode: 'candidate_bootstrap_confirmation_required',
        recipe,
      })],
    });
    const bootstrap = await buildCandidateBootstrapPlan({
      preflight,
      expectedPreflightDigest: preflight.preflightDigest,
      sourceWorkspaceRoot: value.repository,
      pathEnvironment: bin,
    });

    const prepared = await prepareIsolatedLoopCandidate({
      sourceRepositoryRoot: value.repository,
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      snapshotBlobLeaseStore: value.snapshotBlobLeaseStore,
      worktreeLeaseStore: value.worktreeLeaseStore,
      materializer: value.materializer,
      goalId: IDS.goal,
      contractId: IDS.contract,
      runId: IDS.run,
      ownerRunId: IDS.ownerRun,
      bootstrapPlan: bootstrap.plan,
      preparedBootstrap: bootstrap,
      approvedBootstrapPlanDigest:
        bootstrap.plan.bootstrapPlanDigest,
      gatePlanDigest: value.gatePlanDigest,
      criteriaSelectionDigest: null,
      expiresAt: '2030-07-29T08:10:00.000Z',
      recordBinding: (binding) => binding,
    });

    expect(prepared.worktree.lease.state).toBe('active');
    expect(prepared.bootstrapResults).toMatchObject([{
      status: 'observed',
      exitCode: 0,
      recovered: false,
    }]);
  });

  it('does not materialize before the durable Goal binding is accepted', async () => {
    const value = await fixture();
    let candidateId: string | undefined;

    await expect(prepareIsolatedLoopCandidate({
      sourceRepositoryRoot: value.repository,
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      snapshotBlobLeaseStore: value.snapshotBlobLeaseStore,
      worktreeLeaseStore: value.worktreeLeaseStore,
      materializer: value.materializer,
      goalId: IDS.goal,
      contractId: IDS.contract,
      runId: IDS.run,
      ownerRunId: IDS.ownerRun,
      bootstrapPlan: value.bootstrapPlan,
      gatePlanDigest: value.gatePlanDigest,
      criteriaSelectionDigest: null,
      expiresAt: '2026-07-29T08:10:00.000Z',
      recordBinding: (binding) => {
        candidateId = binding.candidateId;
        throw new Error('record store unavailable');
      },
    })).rejects.toMatchObject({
      reasonCode: 'isolated_loop_candidate_binding_rejected',
    } satisfies Partial<IsolatedLoopCandidatePreparerError>);

    expect(candidateId).toBeDefined();
    if (candidateId === undefined) return;
    const lease = await value.worktreeLeaseStore.inspect(candidateId);
    expect(lease.state).toBe('creating');
    expect((await value.snapshotBlobLeaseStore.inspect(
      lease.snapshotBlobLeaseId,
    )).state).toBe('confirmed');
    await expect(access(join(
      value.parent,
      'candidates',
      candidateId,
      'worktree',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks an unavailable Windows backend before Blob, Goal binding, or worktree writes', async () => {
    const value = await fixture();
    const recordBinding = vi.fn((binding) => binding);

    await expect(prepareIsolatedLoopCandidate({
      sourceRepositoryRoot: value.repository,
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      snapshotBlobLeaseStore: value.snapshotBlobLeaseStore,
      worktreeLeaseStore: value.worktreeLeaseStore,
      materializer: value.materializer,
      goalId: IDS.goal,
      contractId: IDS.contract,
      runId: IDS.run,
      ownerRunId: IDS.ownerRun,
      bootstrapPlan: value.bootstrapPlan,
      gatePlanDigest: value.gatePlanDigest,
      criteriaSelectionDigest: null,
      expiresAt: '2026-07-29T08:10:00.000Z',
      recordBinding,
      candidateWorkspaceBackendProbe: () => ({
        available: false,
        platform: 'win32',
        backend: null,
        reasonCode: 'candidate_atomic_backend_platform_unsupported',
      }),
    })).rejects.toMatchObject({
      reasonCode: 'isolated_loop_candidate_backend_unavailable',
    } satisfies Partial<IsolatedLoopCandidatePreparerError>);

    expect(recordBinding).not.toHaveBeenCalled();
    await expect(access(join(value.parent, 'snapshot-blobs')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(value.parent, 'candidates')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the private Gate from a restored verifying candidate', async () => {
    const value = await fixture();
    const prepared = await prepareIsolatedLoopCandidate({
      sourceRepositoryRoot: value.repository,
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      snapshotBlobLeaseStore: value.snapshotBlobLeaseStore,
      worktreeLeaseStore: value.worktreeLeaseStore,
      materializer: value.materializer,
      goalId: IDS.goal,
      contractId: IDS.contract,
      runId: IDS.run,
      ownerRunId: IDS.ownerRun,
      bootstrapPlan: value.bootstrapPlan,
      gatePlanDigest: value.gatePlanDigest,
      criteriaSelectionDigest: null,
      expiresAt: '2026-07-29T08:10:00.000Z',
      recordBinding: (binding) => binding,
    });
    const privateRoot = join(value.parent, 'private-runtime');
    await mkdir(privateRoot, { mode: 0o700 });
    const candidateDeltaStore = new CandidateDeltaStore({
      privateRootDirectory: privateRoot,
      sourceRepositoryRoot: value.repository,
      now: () => new Date(BASE_TIME + 3_000),
    });
    await candidateDeltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeLeaseStore,
      rootCapability: prepared.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });
    const verifying = await value.worktreeLeaseStore.transition(
      prepared.worktree.binding,
      'verifying',
    );
    const restartedStore = new WorktreeLeaseStore({
      candidatesRootDirectory: join(value.parent, 'candidates'),
      now: () => new Date(BASE_TIME + 4_000),
    });
    const resumed = await restartedStore.resumeOwned({
      candidateId: prepared.binding.candidateId,
      runId: IDS.run,
      ownerRunId: IDS.ownerRun,
      expectedLeaseDigest: verifying.lease.leaseDigest,
    });
    const restored = await restartedStore.restoreCandidateRoot(
      resumed.binding,
    );
    const candidateGateAttemptStore = new CandidateGateAttemptStore({
      privateRootDirectory: privateRoot,
      sourceRepositoryRoot: value.repository,
      now: () => new Date(BASE_TIME + 5_000),
    });
    const agent = {
      config: { modelAlias: undefined },
      modelProvider: undefined,
      subagentHost: undefined,
    } as unknown as Agent;
    const iterationInput = {
      agent,
      binding: prepared.binding,
      worktreeLeaseStore: restartedStore,
      worktreeBinding: restored.binding,
      rootCapability: restored.rootCapability,
      candidateDeltaStore,
      candidateGateAttemptStore,
      bootstrapPlan: value.bootstrapPlan,
      gateContract: value.finishLine,
      gateRuntime: reviewRuntime(value),
      objective: value.finishLine.objective,
      writerSystemPrompt: 'Work only in the isolated candidate.',
      writerMaxSteps: 8,
      parentToolCallId: 'isolated-loop-test',
      signal: new AbortController().signal,
    } as const;

    const first = await runIsolatedLoopCandidateIteration(
      iterationInput,
    );

    expect(first.writerRan).toBe(false);
    expect(first.gate.attempt.candidateGateResult?.candidateGateOutcome)
      .toBe('NEEDS_WORK');
    expect(first.gate.leaseState).toBe('active');
    expect(first.candidateGateAttemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
