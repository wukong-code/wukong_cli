import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adoptWorktreeLease,
  candidateBootstrapRecipeFor,
  canonicalDigest,
  createCandidateBootstrapPreflight,
  createCandidateBootstrapPreflightEntry,
  createWorktreeLease,
  transitionWorktreeLease,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recoverPreparedCandidateBootstrapOwnership,
} from '../src/candidate-bootstrap-orchestrator';
import {
  fingerprintGeneratedScopes,
} from '../src/candidate-bootstrap-executor';
import {
  buildCandidateBootstrapPlan,
} from '../src/candidate-bootstrap-plan-builder';
import {
  CandidateBootstrapStateStore,
} from '../src/candidate-bootstrap-state-store';
import {
  WorktreeLeaseBindingV1,
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('candidate bootstrap owner recovery', () => {
  it('rebinds a ready journal to the adopted fencing token', async () => {
    const value = await fixture();
    const previous = await value.stateStore.initialize(
      value.initialization,
    );
    const observed = await fingerprintGeneratedScopes(
      value.candidateDirectory,
      [],
    );

    await recoverPreparedCandidateBootstrapOwnership(
      value.recoveryInput,
    );
    const recovered = await value.stateStore.inspect(
      value.adoptedLease,
      value.prepared.plan,
    );
    await recoverPreparedCandidateBootstrapOwnership(
      value.recoveryInput,
    );
    const recoveredAgain = await value.stateStore.inspect(
      value.adoptedLease,
      value.prepared.plan,
    );

    expect(recovered).toMatchObject({
      worktreeLeaseDigest: value.adoptedLease.leaseDigest,
      worktreeFencingTokenDigest:
        value.adoptedLease.fencingTokenDigest,
      journal: {
        state: 'ready',
        currentWorktreeFencingTokenDigest:
          value.adoptedLease.fencingTokenDigest,
      },
    });
    expect(recovered.journalEvents.at(-1)).toMatchObject({
      eventType: 'ownership_adopted',
      previousWorktreeFencingTokenDigest:
        value.oldLease.fencingTokenDigest,
      worktreeFencingTokenDigest:
        value.adoptedLease.fencingTokenDigest,
      generatedScopeFingerprint: observed.fingerprint,
    });
    expect(recovered.stateDigest).not.toBe(previous.stateDigest);
    expect(recoveredAgain.stateDigest).toBe(recovered.stateDigest);
  });

  it('refuses to rebind a journal with an unknown running step', async () => {
    const value = await fixture();
    await value.stateStore.initialize(value.initialization);
    const step = value.prepared.plan.steps[0]!;
    await value.stateStore.prepareStep({
      worktreeLease: value.oldLease,
      bootstrapPlan: value.prepared.plan,
      step,
      reservationId: '019f8d10-0010-7abc-8def-0123456789ab',
      budgetEventId: '019f8d10-0011-7abc-8def-0123456789ab',
      journalEventId: '019f8d10-0012-7abc-8def-0123456789ab',
      reservedWallClockMs: 1_000,
      reservedGeneratedBytes: 1_000,
      reservedOutputBytes: 1_000,
      idempotencyKey: 'runtime_recovery_step',
    });
    await value.stateStore.startStep({
      worktreeLease: value.oldLease,
      bootstrapPlan: value.prepared.plan,
      step,
      reservationId: '019f8d10-0010-7abc-8def-0123456789ab',
      budgetEventId: '019f8d10-0013-7abc-8def-0123456789ab',
      journalEventId: '019f8d10-0014-7abc-8def-0123456789ab',
      idempotencyKey: 'runtime_recovery_step',
    });

    await expect(recoverPreparedCandidateBootstrapOwnership(
      value.recoveryInput,
    )).rejects.toMatchObject({
      reasonCode: 'candidate_bootstrap_state_stale_binding',
    });
  });
});

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), 'wukong-bootstrap-owner-recovery-'),
  );
  roots.push(root);
  const sourceDirectory = join(root, 'source');
  const binDirectory = join(root, 'bin');
  const candidateDirectory = join(root, 'candidate');
  const bootstrapPrivateDirectory = join(root, 'bootstrap-private');
  await Promise.all([
    mkdir(sourceDirectory),
    mkdir(binDirectory),
    mkdir(candidateDirectory),
    mkdir(bootstrapPrivateDirectory, { mode: 0o700 }),
  ]);
  await symlink('/bin/echo', join(binDirectory, 'npm'));
  const recipe = candidateBootstrapRecipeFor(
    'node',
    'package-lock.json',
  );
  if (recipe === null) throw new Error('Missing Node recipe.');
  const preflight = createCandidateBootstrapPreflight({
    sourceSnapshotDigest: digest('source'),
    gatePlanDigest: digest('gate'),
    entries: [
      createCandidateBootstrapPreflightEntry({
        ecosystem: 'node',
        ecosystemRef: 'node:npm',
        candidateRelativeCwd: '.',
        manifestPath: 'package.json',
        manifestDigest: digest('manifest'),
        lockfilePath: 'package-lock.json',
        lockfileDigest: digest('lockfile'),
        status: 'ready',
        reasonCode:
          'candidate_bootstrap_confirmation_required',
        recipe,
      }),
    ],
  });
  const prepared = await buildCandidateBootstrapPlan({
    preflight,
    expectedPreflightDigest: preflight.preflightDigest,
    sourceWorkspaceRoot: sourceDirectory,
    pathEnvironment: binDirectory,
  });
  const created = createWorktreeLease({
    leaseId: '019f8d10-0000-7abc-8def-0123456789ab',
    candidateId: '019f8d10-0001-7abc-8def-0123456789ab',
    goalId: 'goal_1',
    contractId: 'contract_1',
    runId: 'run_1',
    ownerRunId: 'owner_1',
    ownerProcessIdentityDigest: digest('process-1'),
    sourceSnapshotDigest: prepared.plan.sourceSnapshotDigest,
    snapshotBlobLeaseId:
      '019f8d10-0002-7abc-8def-0123456789ab',
    snapshotBlobLeaseDigest: digest('blob-lease'),
    manifestDigest: digest('blob-manifest'),
    materializationPolicyDigest: digest('materialization-policy'),
    bootstrapPlanDigest: prepared.plan.bootstrapPlanDigest,
    gatePlanDigest: prepared.plan.gatePlanDigest,
    criteriaSelectionDigest: null,
    repositoryIdentity: digest('repository'),
    baseCommit: 'a'.repeat(40),
    repositoryRelativeCwd: '.',
    candidateBranch:
      'wukong/candidate/019f8d10-0001-7abc-8def-0123456789ab',
    createdByRunId: 'run_1',
    createdAt: '2026-07-29T14:00:00.000Z',
    expiresAt: '2030-07-29T15:00:00.000Z',
    fencingTokenDigest: digest('fencing-1'),
  });
  const materializing = transitionWorktreeLease(created.lease, {
    toState: 'materializing',
    occurredAt: '2026-07-29T14:00:01.000Z',
  });
  const oldLease = transitionWorktreeLease(materializing.lease, {
    toState: 'bootstrapping',
    occurredAt: '2026-07-29T14:00:02.000Z',
    worktreeIdentity: digest('worktree'),
    materializedSourceDigest: digest('materialized'),
  }).lease;
  const adoptedLease = adoptWorktreeLease(oldLease, {
    newRunId: oldLease.runId,
    newOwnerRunId: oldLease.ownerRunId,
    newOwnerProcessIdentityDigest: digest('process-2'),
    newFencingTokenDigest: digest('fencing-2'),
    occurredAt: '2026-07-29T14:00:03.000Z',
    reasonCode: 'dead_owner_recovery',
  }).lease;
  const worktreeLeaseStore = new WorktreeLeaseStore({
    candidatesRootDirectory: join(root, 'candidates'),
  });
  vi.spyOn(worktreeLeaseStore, 'withBootstrappingCandidate')
    .mockImplementation(async (_binding, callback) => callback(
      {
        candidateDirectory,
        candidateRelativeCwd: candidateDirectory,
        bootstrapPrivateDirectory,
        workspace: {
          workspaceDir: candidateDirectory,
          additionalDirs: [],
          accessMode: 'workspace-only',
        },
      },
      [{
        leaseDigest: oldLease.leaseDigest,
        fencingTokenDigest: oldLease.fencingTokenDigest,
        state: 'bootstrapping',
      }],
    ));
  const worktreeAuthority = {
    lease: adoptedLease,
    binding: WorktreeLeaseBindingV1.create(
      adoptedLease,
      'adopted-private-fencing-token',
    ),
  };
  const stateStore = new CandidateBootstrapStateStore({
    rootDirectory: bootstrapPrivateDirectory,
  });
  return {
    candidateDirectory,
    prepared,
    oldLease,
    adoptedLease,
    stateStore,
    initialization: {
      worktreeLease: oldLease,
      bootstrapPlan: prepared.plan,
      bootstrapBudget: prepared.budget,
      journalId: '019f8d10-0003-7abc-8def-0123456789ab',
    },
    recoveryInput: {
      worktreeLeaseStore,
      worktreeAuthority,
      preparedBootstrap: prepared,
      approvedBootstrapPlanDigest:
        prepared.plan.bootstrapPlanDigest,
    },
  };
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/bootstrap-owner-recovery/v1',
    label,
  );
}
