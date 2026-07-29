import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
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
  acknowledgePromotionConsent,
  appendPromotionChangeEvent,
  buildTargetStateFingerprint,
  canonicalDigest,
  createCandidateBootstrapPlan,
  createPromotionApplyJournal,
  createPromotionConsentProposal,
  createPromotionPathState,
  inspectSourceSnapshot,
  sealSourceSnapshot,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CandidateDeltaStore,
} from '../src/candidate-delta-store';
import {
  PromotionApplyJournalStore,
} from '../src/promotion-apply-journal-store';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  SnapshotBlobLeaseStore,
} from '../src/snapshot-blob-lease-store';
import {
  TargetPromotionApplyOrchestrator,
} from '../src/target-promotion-apply-orchestrator';
import {
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';
import {
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T15:30:00.000Z');

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('TargetPromotionApplyOrchestrator', () => {
  it('joins exact consent, fenced Apply journal, and post-Apply fingerprint', async () => {
    const value = await fixture();
    const result = await value.orchestrator.run(value.runInput);

    expect(result.journal.state).toBe('applied');
    expect(result.journal.targetAfterFingerprintDigest)
      .toBe(result.targetAfterFingerprint.fingerprintDigest);
    expect(result.finalVerifyingAuthority.lease.state)
      .toBe('final_verifying');
    expect(await readFile(
      join(value.repository, 'tracked.txt'),
      'utf8',
    )).toBe('after\n');
  });

  it('applies zero bytes and enters reconciliation when target eligibility drifts', async () => {
    const value = await fixture();
    await writeFile(join(value.repository, 'tracked.txt'), 'external\n');

    await expect(value.orchestrator.run(value.runInput))
      .rejects.toMatchObject({
        reasonCode: 'promotion_apply_reconciliation_required',
      });
    expect(await readFile(
      join(value.repository, 'tracked.txt'),
      'utf8',
    )).toBe('external\n');
    await expect(value.targetStore.inspect(
      value.applying.lease.targetRegistryKey,
    )).resolves.toMatchObject({ state: 'reconciliation_required' });
  });

  it('honors cancellation before Apply without writing or poisoning recovery', async () => {
    const value = await fixture();
    const controller = new AbortController();
    const cancelled = new DOMException(
      'Apply cancelled before write',
      'AbortError',
    );
    controller.abort(cancelled);

    await expect(value.orchestrator.run({
      ...value.runInput,
      signal: controller.signal,
    })).rejects.toBe(cancelled);
    expect(await readFile(
      join(value.repository, 'tracked.txt'),
      'utf8',
    )).toBe('before\n');
    await expect(value.targetStore.inspect(
      value.applying.lease.targetRegistryKey,
    )).resolves.toMatchObject({ state: 'applying' });
    await expect(value.orchestrator.run(value.runInput))
      .resolves.toMatchObject({
        journal: { state: 'applied' },
        finalVerifyingAuthority: {
          lease: { state: 'final_verifying' },
        },
      });
  });

  it('stops after a durable change boundary and resumes without replay', async () => {
    const value = await fixture();
    const controller = new AbortController();
    const cancelled = new DOMException(
      'Apply cancelled after durable change',
      'AbortError',
    );
    const journalStore = value.runInput.journalStore;
    const append = journalStore.append.bind(journalStore);
    vi.spyOn(journalStore, 'append').mockImplementation(
      async (...args) => {
        const journal = await append(...args);
        if (journal.events.at(-1)?.eventType === 'applied') {
          controller.abort(cancelled);
        }
        return journal;
      },
    );

    await expect(value.orchestrator.run({
      ...value.runInput,
      signal: controller.signal,
    })).rejects.toBe(cancelled);
    expect(await readFile(
      join(value.repository, 'tracked.txt'),
      'utf8',
    )).toBe('after\n');
    await expect(value.targetStore.inspect(
      value.applying.lease.targetRegistryKey,
    )).resolves.toMatchObject({ state: 'applying' });

    vi.restoreAllMocks();
    const resumed = await value.orchestrator.run(value.runInput);
    expect(resumed.journal.events.filter(
      (event) => event.eventType === 'applied',
    )).toHaveLength(1);
    expect(resumed.finalVerifyingAuthority.lease.state)
      .toBe('final_verifying');
  });

  it('rejects an adopted prepared postimage without a transaction receipt', async () => {
    const value = await fixture();
    const change =
      value.runInput.candidateDeltaSeal.manifest.changes[0]!;
    const preimage = change.preimage!;
    const postimage = change.postimage!;
    await value.targetStore.withExclusiveLease(
      value.applying.binding,
      'applying',
      async (view) => {
        const initial = createPromotionApplyJournal({
          journalId: value.runInput.journalId,
          promotionId: view.lease.promotionId,
          targetPromotionLeaseId:
            view.lease.targetPromotionLeaseId,
          targetRegistryKey: view.lease.targetRegistryKey,
          createdByTargetFencingTokenDigest:
            view.lease.fencingTokenDigest,
          candidateId:
            value.runInput.candidateDeltaSeal.candidateId,
          candidateDeltaDigest:
            value.runInput.candidateDeltaSeal.delta
              .candidateDeltaDigest,
          orderedChangeManifestDigest:
            value.runInput.candidateDeltaSeal.manifest
              .orderedChangeManifestDigest,
          changeCount: 1,
          targetBeforeFingerprintDigest:
            value.runInput.expectedTargetBeforeFingerprint
              .fingerprintDigest,
          targetBeforeContentDigest:
            value.runInput.candidateDeltaSeal.delta
              .materializedSourceDigest,
          materializedSourceDigest:
            value.runInput.candidateDeltaSeal.delta
              .materializedSourceDigest,
          agentDeltaDigest:
            value.runInput.candidateDeltaSeal.delta.agentDeltaDigest,
        });
        await value.runInput.journalStore.createOrLoad(view, initial);
        const prepared = appendPromotionChangeEvent(initial, {
          eventId: '019f8d00-0003-7abc-8def-0123456789ab',
          changeIndex: 0,
          operation: change.operation,
          eventType: 'prepared',
          expectedPreimages: [projectionState(preimage)],
          expectedPostimages: [projectionState(postimage)],
          observedStates: [projectionState(preimage)],
          targetFencingTokenDigest:
            view.lease.fencingTokenDigest,
          idempotencyKey: digest('prepared-change'),
          occurredAt: '2026-07-29T15:30:05.000Z',
        });
        await value.runInput.journalStore.append(
          view,
          initial.journalHeadDigest,
          prepared,
        );
      },
    );
    await writeFile(join(value.repository, 'tracked.txt'), 'after\n');
    const nextProof = await proof(84, 'next-process');
    const adopted = await value.targetStore.adoptApplying({
      targetRegistryKey: value.applying.lease.targetRegistryKey,
      ownerRunId: value.applying.lease.ownerRunId,
      expectedLeaseDigest: value.applying.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });

    await expect(value.orchestrator.run({
      ...value.runInput,
      targetPromotionBinding: adopted.binding,
    })).rejects.toMatchObject({
      reasonCode: 'promotion_apply_reconciliation_required',
    });
    expect(await readFile(
      join(value.repository, 'tracked.txt'),
      'utf8',
    )).toBe('after\n');
  });
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-apply-join-'));
  roots.push(parent);
  const repository = join(parent, 'repository');
  const candidatesRoot = join(parent, 'candidates');
  await mkdir(repository);
  await git(repository, ['init']);
  await writeFile(join(repository, 'tracked.txt'), 'before\n');
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  const inspected = await inspectSourceSnapshot({ cwd: repository });
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null) {
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
    expiresAt: '2026-07-29T15:40:00.000Z',
  });
  const blob = await blobStore.confirm(staged.binding);
  const bootstrapPlan = createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8d00-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: snapshot.snapshotDigest,
    gatePlanDigest: digest('gate-plan'),
    ecosystemRefs: [],
    lockfileDigests: [],
    steps: [],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('bootstrap-permission'),
    bootstrapBudgetDigest: digest('bootstrap-budget'),
  });
  const worktreeStore = new WorktreeLeaseStore({
    candidatesRootDirectory: candidatesRoot,
    now: () => new Date(BASE_TIME + 1_000),
  });
  const reserved = await worktreeStore.reserve({
    sourceRepositoryRoot: repository,
    sourceSnapshot: snapshot,
    snapshotBlobLease: blob.lease,
    goalId: 'goal_apply',
    contractId: 'contract_apply',
    runId: 'run_apply',
    ownerRunId: 'run_owner',
    bootstrapPlanDigest: bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: bootstrapPlan.gatePlanDigest,
    criteriaSelectionDigest: null,
    expiresAt: '2026-07-29T15:40:00.000Z',
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
      materializedSourceDigest: digest('materialized-source'),
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
    join(materializing.candidateDirectory, 'tracked.txt'),
    'after\n',
  );
  await worktreeStore.transition(active.binding, 'verifying');
  const candidateDeltaSeal = await deltaStore.sealDelta({
    worktreeLeaseStore: worktreeStore,
    rootCapability: active.rootCapability,
    bootstrapPlan,
  });
  const targetFingerprint = await buildTargetStateFingerprint({
    cwd: repository,
    expectedSourceSnapshot: snapshot,
    promotableContentDigest:
      candidateDeltaSeal.delta.candidateWorkspaceDigest,
  });
  const promotionId = '019f8d00-0001-7abc-8def-0123456789ab';
  const proposal = createPromotionConsentProposal({
    promotionId,
    candidateId: active.lease.candidateId,
    candidateDeltaDigest:
      candidateDeltaSeal.delta.candidateDeltaDigest,
    candidateGateResultDigest: digest('candidate-gate'),
    sourceSnapshotDigest: snapshot.snapshotDigest,
    targetFingerprint,
    permissionDigest: digest('promotion-permission'),
  });
  const targetStore = new TargetPromotionLeaseStore({
    registryRootDirectory: join(parent, 'target-registry'),
    now: () => new Date(BASE_TIME + 3_000),
    probeLiveness: () => Promise.resolve('dead'),
  });
  const ownerProcessLivenessProof =
    await proof(42, 'old-process');
  const acquired = await targetStore.acquire({
    consent: acknowledgePromotionConsent(
      proposal,
      proposal.proposalDigest,
      '2026-07-29T15:29:00.000Z',
    ),
    targetFingerprint,
    ownerRunId: 'run_apply',
    ownerProcessIdentityDigest:
      ownerProcessLivenessProof.proofDigest,
    ownerProcessLivenessProof,
  });
  const applying = await targetStore.transition(
    acquired.binding,
    'applying',
  );
  const orchestrator = new TargetPromotionApplyOrchestrator({
    now: () => new Date(BASE_TIME + 4_000),
  });
  return {
    repository,
    targetStore,
    applying,
    orchestrator,
    runInput: {
      targetPromotionLeaseStore: targetStore,
      targetPromotionBinding: applying.binding,
      journalStore: new PromotionApplyJournalStore({
        now: () => new Date(BASE_TIME + 4_000),
      }),
      worktreeLeaseStore: worktreeStore,
      candidateRootCapability: active.rootCapability,
      candidateDeltaSeal,
      expectedSourceSnapshot: snapshot,
      expectedTargetBeforeFingerprint: targetFingerprint,
      targetDirectory: repository,
      journalId: '019f8d00-0002-7abc-8def-0123456789ab',
    },
  };
}

function projectionState(entry: {
  readonly canonicalRelativePath: string;
  readonly mode: number;
  readonly contentDigest: string;
}) {
  return createPromotionPathState({
    candidateRelativePath: entry.canonicalRelativePath,
    presence: 'present',
    fileType: 'regular',
    mode: entry.mode & 0o777,
    contentDigest: entry.contentDigest,
  });
}

function proof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd: root });
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

function digest(label: string): string {
  return canonicalDigest('wukong/test/apply-orchestrator/v1', label);
}
