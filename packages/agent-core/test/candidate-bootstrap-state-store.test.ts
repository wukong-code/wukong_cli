import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adoptWorktreeLease,
  canonicalDigest,
  createBootstrapBudget,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  createWorktreeLease,
  transitionWorktreeLease,
  type BootstrapBudgetV1,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapStepV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CandidateBootstrapStateStore,
  CandidateBootstrapStateStoreError,
} from '../src/candidate-bootstrap-state-store';

const roots: string[] = [];
const IDS = {
  plan: '019f8be0-0000-7abc-8def-0123456789ab',
  budget: '019f8be0-0001-7abc-8def-0123456789ab',
  journal: '019f8be0-0002-7abc-8def-0123456789ab',
  lease: '019f8be0-0003-7abc-8def-0123456789ab',
  candidate: '019f8be0-0004-7abc-8def-0123456789ab',
  blobLease: '019f8be0-0005-7abc-8def-0123456789ab',
  reservation: '019f8be0-0010-7abc-8def-0123456789ab',
  reserveEvent: '019f8be0-0011-7abc-8def-0123456789ab',
  prepareEvent: '019f8be0-0012-7abc-8def-0123456789ab',
  startBudgetEvent: '019f8be0-0013-7abc-8def-0123456789ab',
  startJournalEvent: '019f8be0-0014-7abc-8def-0123456789ab',
  finishBudgetEvent: '019f8be0-0015-7abc-8def-0123456789ab',
  finishJournalEvent: '019f8be0-0016-7abc-8def-0123456789ab',
  adoptEvent: '019f8be0-0017-7abc-8def-0123456789ab',
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly root: string;
  readonly step: CandidateBootstrapStepV1;
  readonly plan: CandidateBootstrapPlanV1;
  readonly budget: BootstrapBudgetV1;
  readonly lease: WorktreeLeaseV1;
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/bootstrap-state-store/v1', label);
}

async function fixture(
  budgetOverrides: Partial<{
    wallClockLimitMs: number;
    generatedByteLimit: number;
    processOutputByteLimit: number;
  }> = {},
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-state-'));
  roots.push(parent);
  const root = join(parent, 'bootstrap-private');
  await mkdir(root, { mode: 0o700 });
  const budget = createBootstrapBudget({
    budgetId: IDS.budget,
    bootstrapPlanId: IDS.plan,
    wallClockLimitMs: budgetOverrides.wallClockLimitMs ?? 10_000,
    generatedByteLimit: budgetOverrides.generatedByteLimit ?? 2_000,
    processOutputByteLimit:
      budgetOverrides.processOutputByteLimit ?? 1_000,
    stepLimit: 4,
  });
  const step = createCandidateBootstrapStep({
    stepId: 'install_dependencies',
    recipeRef: 'builtin:node-frozen-install',
    recipeVersion: '1.0.0',
    executableIdentity: digest('executable'),
    runtimeVersionDigest: digest('runtime'),
    exactArgvPrivateRef: 'private/bootstrap/argv/install',
    argvDigest: digest('argv'),
    effectiveEnvironmentPrivateRef: 'private/bootstrap/env/install',
    effectiveEnvironmentDigest: digest('environment'),
    candidateRelativeCwd: '.',
    generatedPathScopes: ['node_modules'],
    timeoutMs: 5_000,
  });
  const plan = createCandidateBootstrapPlan({
    bootstrapPlanId: IDS.plan,
    sourceSnapshotDigest: digest('snapshot'),
    gatePlanDigest: digest('gate'),
    ecosystemRefs: ['node:pnpm'],
    lockfileDigests: [digest('lockfile')],
    steps: [step],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: budget.budgetDigest,
  });
  const created = createWorktreeLease({
    leaseId: IDS.lease,
    candidateId: IDS.candidate,
    goalId: 'goal_1',
    contractId: 'contract_1',
    runId: 'run_1',
    ownerRunId: 'owner_1',
    ownerProcessIdentityDigest: digest('process-1'),
    sourceSnapshotDigest: plan.sourceSnapshotDigest,
    snapshotBlobLeaseId: IDS.blobLease,
    snapshotBlobLeaseDigest: digest('blob-lease'),
    manifestDigest: digest('manifest'),
    materializationPolicyDigest: digest('materialization-policy'),
    bootstrapPlanDigest: plan.bootstrapPlanDigest,
    gatePlanDigest: plan.gatePlanDigest,
    criteriaSelectionDigest: null,
    repositoryIdentity: digest('repository'),
    baseCommit: 'a'.repeat(40),
    repositoryRelativeCwd: '.',
    candidateBranch: `wukong/candidate/${IDS.candidate}`,
    createdByRunId: 'run_1',
    createdAt: '2026-07-29T06:00:00.000Z',
    expiresAt: '2026-07-29T07:00:00.000Z',
    fencingTokenDigest: digest('fencing-1'),
  });
  const materializing = transitionWorktreeLease(created.lease, {
    toState: 'materializing',
    occurredAt: '2026-07-29T06:00:01.000Z',
  });
  const bootstrapping = transitionWorktreeLease(materializing.lease, {
    toState: 'bootstrapping',
    occurredAt: '2026-07-29T06:00:02.000Z',
    worktreeIdentity: digest('worktree'),
    materializedSourceDigest: digest('materialized'),
  });
  return { root, step, plan, budget, lease: bootstrapping.lease };
}

function initialization(value: Fixture) {
  return {
    worktreeLease: value.lease,
    bootstrapPlan: value.plan,
    bootstrapBudget: value.budget,
    journalId: IDS.journal,
  };
}

function prepareInput(value: Fixture) {
  return {
    worktreeLease: value.lease,
    bootstrapPlan: value.plan,
    step: value.step,
    reservationId: IDS.reservation,
    budgetEventId: IDS.reserveEvent,
    journalEventId: IDS.prepareEvent,
    reservedWallClockMs: 5_000,
    reservedGeneratedBytes: 1_000,
    reservedOutputBytes: 500,
    idempotencyKey: 'install_dependencies_1',
  };
}

function startInput(value: Fixture) {
  return {
    worktreeLease: value.lease,
    bootstrapPlan: value.plan,
    step: value.step,
    reservationId: IDS.reservation,
    budgetEventId: IDS.startBudgetEvent,
    journalEventId: IDS.startJournalEvent,
    idempotencyKey: 'install_dependencies_1',
  };
}

describe('CandidateBootstrapStateStore', () => {
  it('initializes idempotently and persists a private validated state', async () => {
    const value = await fixture();
    const store = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    const first = await store.initialize(initialization(value));
    const second = await store.initialize(initialization(value));

    expect(second.stateDigest).toBe(first.stateDigest);
    expect(await store.inspect(value.lease, value.plan)).toEqual(first);
    if (process.platform !== 'win32') {
      expect(
        (await lstat(join(value.root, 'bootstrap-state.json'))).mode
          & 0o777,
      ).toBe(0o600);
    }
  });

  it('atomically prepares, starts and settles one exact plan step', async () => {
    const value = await fixture();
    const store = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    await store.initialize(initialization(value));
    const prepared = await store.prepareStep(prepareInput(value));
    expect((await store.prepareStep(prepareInput(value))).stateDigest)
      .toBe(prepared.stateDigest);
    const started = await store.startStep(startInput(value));
    expect((await store.startStep(startInput(value))).stateDigest)
      .toBe(started.stateDigest);
    const finish = {
      ...startInput(value),
      budgetEventId: IDS.finishBudgetEvent,
      journalEventId: IDS.finishJournalEvent,
      eventType: 'observed',
      generatedScopeFingerprint: digest('generated-after'),
      exitCode: 0,
      actualWallClockMs: 1_500,
      actualGeneratedBytes: 400,
      actualOutputBytes: 120,
    } as const;
    const finished = await store.finishStep(finish);
    expect((await store.finishStep(finish)).stateDigest)
      .toBe(finished.stateDigest);

    expect(prepared).toMatchObject({
      revision: 1,
      budget: { revision: 1 },
      journal: { revision: 1, state: 'step_prepared' },
    });
    expect(started).toMatchObject({
      revision: 2,
      budget: { revision: 2 },
      journal: { revision: 2, state: 'step_running' },
    });
    expect(finished).toMatchObject({
      revision: 3,
      budget: { revision: 3 },
      journal: { revision: 3, state: 'ready' },
      reservations: [{
        state: 'settled',
        actualWallClockMs: 1_500,
        actualGeneratedBytes: 400,
        actualOutputBytes: 120,
      }],
    });
    const resumed = await new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    }).inspect(value.lease, value.plan);
    expect(resumed.stateDigest).toBe(finished.stateDigest);
    const adoptedLease = adoptWorktreeLease(value.lease, {
      newRunId: 'run_2',
      newOwnerRunId: 'owner_2',
      newOwnerProcessIdentityDigest: digest('process-2'),
      newFencingTokenDigest: digest('fencing-2'),
      occurredAt: '2026-07-29T06:00:03.000Z',
      reasonCode: 'resume_after_crash',
    }).lease;
    await expect(store.inspectOwnershipRecovery({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      ownershipAncestors: [{
        leaseDigest: value.lease.leaseDigest,
        fencingTokenDigest: value.lease.fencingTokenDigest,
        state: 'bootstrapping',
      }],
    })).resolves.toEqual({
      status: 'requires_adoption',
      stateDigest: finished.stateDigest,
      generatedPathScopes: ['node_modules'],
    });
  });

  it('serializes competing prepares and preserves exact plan order', async () => {
    const value = await fixture();
    const first = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    const second = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    await first.initialize(initialization(value));

    const results = await Promise.allSettled([
      first.prepareStep(prepareInput(value)),
      second.prepareStep({
        ...prepareInput(value),
        reservationId: '019f8be0-0020-7abc-8def-0123456789ab',
        budgetEventId: '019f8be0-0021-7abc-8def-0123456789ab',
        journalEventId: '019f8be0-0022-7abc-8def-0123456789ab',
        idempotencyKey: 'competing_prepare',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected'))
      .toHaveLength(1);
    expect((await first.inspect(value.lease, value.plan)).reservations)
      .toHaveLength(1);
  });

  it('retains an unknown running step and refuses ownership adoption', async () => {
    const value = await fixture();
    const store = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    await store.initialize(initialization(value));
    await store.prepareStep(prepareInput(value));
    await store.startStep(startInput(value));
    const unknown = await store.retainUnknown({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      reservationId: IDS.reservation,
      budgetEventId: IDS.finishBudgetEvent,
    });
    const adoptedLease = adoptWorktreeLease(value.lease, {
      newRunId: 'run_2',
      newOwnerRunId: 'owner_2',
      newOwnerProcessIdentityDigest: digest('process-2'),
      newFencingTokenDigest: digest('fencing-2'),
      occurredAt: '2026-07-29T06:00:03.000Z',
      reasonCode: 'resume_after_crash',
    }).lease;

    expect(unknown).toMatchObject({
      budget: { revision: 3 },
      journal: { state: 'step_running', revision: 2 },
      reservations: [{ state: 'retained_unknown' }],
    });
    await expect(store.adoptOwnership({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      expectedPreviousStateDigest: unknown.stateDigest,
      journalEventId: IDS.adoptEvent,
      observedGeneratedScopeFingerprint: digest('generated'),
      idempotencyKey: 'adopt_run_2',
    })).rejects.toMatchObject({
      reasonCode: 'candidate_bootstrap_state_stale_binding',
    });
    await expect(store.inspectOwnershipRecovery({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      ownershipAncestors: [{
        leaseDigest: value.lease.leaseDigest,
        fencingTokenDigest: value.lease.fencingTokenDigest,
        state: 'bootstrapping',
      }],
    })).rejects.toMatchObject({
      reasonCode: 'candidate_bootstrap_state_stale_binding',
    });
  });

  it('adopts a new fencing token only while no step is in flight', async () => {
    const value = await fixture();
    const store = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    const initial = await store.initialize(initialization(value));
    const adoptedLease = adoptWorktreeLease(value.lease, {
      newRunId: 'run_2',
      newOwnerRunId: 'owner_2',
      newOwnerProcessIdentityDigest: digest('process-2'),
      newFencingTokenDigest: digest('fencing-2'),
      occurredAt: '2026-07-29T06:00:03.000Z',
      reasonCode: 'resume_after_crash',
    }).lease;
    const recovery = await store.inspectOwnershipRecovery({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      ownershipAncestors: [{
        leaseDigest: value.lease.leaseDigest,
        fencingTokenDigest: value.lease.fencingTokenDigest,
        state: 'bootstrapping',
      }],
    });
    expect(recovery).toEqual({
      status: 'requires_adoption',
      stateDigest: initial.stateDigest,
      generatedPathScopes: [],
    });
    const adopted = await store.adoptOwnership({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      expectedPreviousStateDigest: recovery!.stateDigest,
      journalEventId: IDS.adoptEvent,
      observedGeneratedScopeFingerprint: digest('generated'),
      idempotencyKey: 'adopt_run_2',
    });
    const adoptedAgain = await store.adoptOwnership({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      expectedPreviousStateDigest: initial.stateDigest,
      journalEventId: IDS.adoptEvent,
      observedGeneratedScopeFingerprint: digest('generated'),
      idempotencyKey: 'adopt_run_2',
    });
    await expect(store.inspectOwnershipRecovery({
      worktreeLease: adoptedLease,
      bootstrapPlan: value.plan,
      ownershipAncestors: [{
        leaseDigest: value.lease.leaseDigest,
        fencingTokenDigest: value.lease.fencingTokenDigest,
        state: 'bootstrapping',
      }],
    })).resolves.toMatchObject({
      status: 'current',
      stateDigest: adopted.stateDigest,
    });

    expect(adopted).toMatchObject({
      worktreeLeaseDigest: adoptedLease.leaseDigest,
      worktreeFencingTokenDigest: digest('fencing-2'),
      journal: {
        state: 'ready',
        currentWorktreeFencingTokenDigest: digest('fencing-2'),
      },
    });
    expect(adoptedAgain.stateDigest).toBe(adopted.stateDigest);
    await expect(store.inspect(value.lease, value.plan))
      .rejects.toMatchObject({
        reasonCode: 'candidate_bootstrap_state_stale_binding',
      });
    await expect(store.inspect(adoptedLease, value.plan))
      .resolves.toMatchObject({ stateDigest: adopted.stateDigest });
  });

  it('fails closed after state tampering or unsafe root permissions', async () => {
    const value = await fixture();
    const store = new CandidateBootstrapStateStore({
      rootDirectory: value.root,
    });
    await store.initialize(initialization(value));
    const statePath = join(value.root, 'bootstrap-state.json');
    const record = JSON.parse(await readFile(statePath, 'utf8'));
    record.budget.wallClockLimitMs += 1;
    await writeFile(statePath, JSON.stringify(record), { mode: 0o600 });

    await expect(store.inspect(value.lease, value.plan))
      .rejects.toBeInstanceOf(CandidateBootstrapStateStoreError);
    if (process.platform !== 'win32') {
      await chmod(value.root, 0o755);
      await expect(store.inspect(value.lease, value.plan))
        .rejects.toMatchObject({
          reasonCode: 'candidate_bootstrap_state_root_unsafe',
        });
    }
  });
});
