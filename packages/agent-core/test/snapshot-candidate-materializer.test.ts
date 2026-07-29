import { execFile } from 'node:child_process';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  canonicalDigest,
  inspectSourceSnapshot,
  sealSourceSnapshot,
  type SourceSnapshotV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SnapshotBlobLeaseStore,
  type SnapshotBlobLeaseAuthorityV1,
} from '../src/snapshot-blob-lease-store';
import {
  captureProcessLivenessProof,
  type ProcessLivenessOutcome,
  type ProcessLivenessProofV1,
} from '../src/process-liveness-proof';
import {
  assessSnapshotCandidateRecovery,
  SnapshotCandidateMaterializer,
  validateMaterializedSnapshotCandidateRecord,
  validateSnapshotCandidateIntent,
} from '../src/snapshot-candidate-materializer';
import {
  WorktreeLeaseStore,
  WorktreeLeaseStoreError,
  type WorktreeLeaseAuthorityV1,
} from '../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T02:00:00.000Z');

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root });
  return result.stdout;
}

async function createDirtyFixture(options: {
  readonly ownerProcessLivenessProof?: ProcessLivenessProofV1;
  readonly probeLiveness?: (
    proof: ProcessLivenessProofV1,
  ) => Promise<ProcessLivenessOutcome>;
} = {}): Promise<{
  readonly parent: string;
  readonly repository: string;
  readonly candidatesRoot: string;
  readonly leaseRoot: string;
  readonly snapshot: SourceSnapshotV1;
  readonly authority: SnapshotBlobLeaseAuthorityV1;
  readonly store: SnapshotBlobLeaseStore;
  readonly worktreeAuthority: WorktreeLeaseAuthorityV1;
  readonly worktreeStore: WorktreeLeaseStore;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-candidate-materializer-'));
  roots.push(parent);
  const repository = join(parent, 'repository');
  const candidatesRoot = join(parent, 'candidates');
  const leaseRoot = join(parent, 'leases');
  await mkdir(repository);
  await git(repository, ['init']);
  await writeRepoFile(repository, 'src/index.ts', 'export const value = 1;\n');
  await writeRepoFile(repository, 'src/deleted.ts', 'export const deleted = true;\n');
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);

  await writeRepoFile(repository, 'src/index.ts', 'export const value = 2;\n');
  await git(repository, ['add', 'src/index.ts']);
  await writeRepoFile(repository, 'src/index.ts', 'export const value = 3;\n');
  await git(repository, ['rm', 'src/deleted.ts']);
  await writeRepoFile(repository, 'src/new.ts', 'export const added = true;\n');
  const snapshotCwd = join(repository, 'src');
  const inspected = await inspectSourceSnapshot({
    cwd: snapshotCwd,
    selectedUntrackedPaths: ['src/new.ts'],
  });
  if (inspected.status !== 'ready' || inspected.proposedSnapshot === null) {
    throw new Error('Unable to prepare a ready source snapshot fixture.');
  }
  const snapshot = inspected.proposedSnapshot;
  const sealed = await sealSourceSnapshot({ cwd: snapshotCwd, snapshot });
  const store = new SnapshotBlobLeaseStore({
    rootDirectory: leaseRoot,
    now: () => new Date(BASE_TIME),
  });
  const staged = await store.stageAndSeal({
    containerBytes: sealed.containerBytes,
    sourceSnapshot: snapshot,
    createdByRunId: 'run_creator',
    ownerRunId: 'run_owner',
    expiresAt: '2026-07-29T02:10:00.000Z',
  });
  const authority = await store.confirm(staged.binding);
  const worktreeStore = new WorktreeLeaseStore({
    candidatesRootDirectory: candidatesRoot,
    now: () => new Date(BASE_TIME + 500),
    probeLiveness: options.probeLiveness,
  });
  const worktreeAuthority = await worktreeStore.reserve({
    sourceRepositoryRoot: repository,
    sourceSnapshot: snapshot,
    snapshotBlobLease: authority.lease,
    goalId: 'goal_1',
    contractId: 'contract_1',
    runId: 'run_1',
    ownerRunId: 'run_owner',
    ownerProcessIdentityDigest:
      options.ownerProcessLivenessProof?.proofDigest,
    ownerProcessLivenessProof:
      options.ownerProcessLivenessProof,
    bootstrapPlanDigest: testDigest('bootstrap'),
    gatePlanDigest: testDigest('gate'),
    criteriaSelectionDigest: null,
    expiresAt: '2026-07-29T02:10:00.000Z',
  });
  return {
    parent,
    repository,
    candidatesRoot,
    leaseRoot,
    snapshot,
    authority,
    store,
    worktreeAuthority,
    worktreeStore,
  };
}

function testDigest(label: string): string {
  return canonicalDigest('wukong/test/candidate-materializer/v1', label);
}

function processProof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

describe('snapshot candidate materializer', () => {
  it('materializes and verifies exact index/worktree postimages before blob destruction', async () => {
    const fixture = await createDirtyFixture();
    const materializer = new SnapshotCandidateMaterializer({
      now: () => new Date(BASE_TIME + 1_000),
    });

    const result = await materializer.materialize({
      sourceRepositoryRoot: fixture.repository,
      sourceSnapshot: fixture.snapshot,
      leaseStore: fixture.store,
      confirmedBinding: fixture.authority.binding,
      worktreeLeaseStore: fixture.worktreeStore,
      worktreeLeaseBinding: fixture.worktreeAuthority.binding,
    });

    expect(await readFile(join(result.candidateDirectory, 'src/index.ts'), 'utf8'))
      .toBe('export const value = 3;\n');
    expect(await readFile(join(result.candidateDirectory, 'src/new.ts'), 'utf8'))
      .toBe('export const added = true;\n');
    await expect(access(join(result.candidateDirectory, 'src/deleted.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(result.candidateDirectory, ['show', ':src/index.ts']))
      .toBe('export const value = 2;\n');
    expect(await git(result.candidateDirectory, ['status', '--porcelain=v1']))
      .toBe('D  src/deleted.ts\nMM src/index.ts\n?? src/new.ts\n');
    expect(result.record).toMatchObject({
      state: 'materialized',
      sourceSnapshotDigest: fixture.snapshot.snapshotDigest,
      snapshotBlobLeaseId: fixture.authority.lease.blobLeaseId,
      confirmedBlobLeaseDigest: fixture.authority.lease.leaseDigest,
      worktreeLeaseId: fixture.worktreeAuthority.lease.leaseId,
      indexDigest: fixture.snapshot.indexDigest,
      trackedDeltaDigest: fixture.snapshot.trackedDeltaDigest,
    });
    expect(result.candidateRelativeCwd).toBe(join(result.candidateDirectory, 'src'));
    expect(result.record.materializedSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.record.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(validateMaterializedSnapshotCandidateRecord(result.record)).toBe(true);
    expect(result.worktreeLease.lease).toMatchObject({
      state: 'bootstrapping',
      worktreeIdentity: result.record.candidatePathIdentity,
      materializedSourceDigest: result.record.materializedSourceDigest,
    });
    expect((await fixture.worktreeStore.inspect(
      fixture.worktreeAuthority.lease.candidateId,
    )).state).toBe('bootstrapping');

    const ownerDirectory = dirname(result.candidateDirectory);
    const persistedRecord: unknown = JSON.parse(
      await readFile(join(ownerDirectory, 'candidate.json'), 'utf8'),
    );
    const persistedIntent: unknown = JSON.parse(
      await readFile(join(ownerDirectory, 'candidate-intent.json'), 'utf8'),
    );
    expect(persistedRecord).toEqual(result.record);
    expect(validateMaterializedSnapshotCandidateRecord(persistedRecord)).toBe(true);
    expect(validateSnapshotCandidateIntent(persistedIntent)).toBe(true);
    expect(validateMaterializedSnapshotCandidateRecord({
      ...result.record,
      indexDigest: `sha256:${'0'.repeat(64)}`,
    })).toBe(false);
    if (process.platform !== 'win32') {
      expect((await lstat(ownerDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(ownerDirectory, 'candidate.json'))).mode & 0o777)
        .toBe(0o600);
    }
    expect((await fixture.store.inspect(fixture.authority.lease.blobLeaseId)).state)
      .toBe('destroyed');
    await expect(access(join(
      fixture.leaseRoot,
      fixture.authority.lease.blobLeaseId,
      'payload.bin',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses sealed bytes even when the source worktree drifts after confirmation', async () => {
    const fixture = await createDirtyFixture();
    await writeRepoFile(fixture.repository, 'src/index.ts', 'source drift after approval\n');
    const materializer = new SnapshotCandidateMaterializer();

    const result = await materializer.materialize({
      sourceRepositoryRoot: fixture.repository,
      sourceSnapshot: fixture.snapshot,
      leaseStore: fixture.store,
      confirmedBinding: fixture.authority.binding,
      worktreeLeaseStore: fixture.worktreeStore,
      worktreeLeaseBinding: fixture.worktreeAuthority.binding,
    });

    expect(await readFile(join(result.candidateDirectory, 'src/index.ts'), 'utf8'))
      .toBe('export const value = 3;\n');
    expect(await readFile(join(fixture.repository, 'src/index.ts'), 'utf8'))
      .toBe('source drift after approval\n');
  });

  it('rejects a candidate root inside the source without consuming the lease', async () => {
    const fixture = await createDirtyFixture();
    const unsafeRoot = join(fixture.repository, '.wukong-candidates');
    const worktreeStore = new WorktreeLeaseStore({
      candidatesRootDirectory: unsafeRoot,
    });

    await expect(access(unsafeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(worktreeStore.reserve({
      sourceRepositoryRoot: fixture.repository,
      sourceSnapshot: fixture.snapshot,
      snapshotBlobLease: fixture.authority.lease,
      goalId: 'goal_1',
      contractId: 'contract_1',
      runId: 'run_1',
      ownerRunId: 'run_owner',
      bootstrapPlanDigest: testDigest('bootstrap'),
      gatePlanDigest: testDigest('gate'),
      criteriaSelectionDigest: null,
      expiresAt: '2026-07-29T02:10:00.000Z',
    })).rejects.toBeInstanceOf(WorktreeLeaseStoreError);
    await expect(access(unsafeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fixture.store.inspect(fixture.authority.lease.blobLeaseId)).state)
      .toBe('confirmed');
  });

  it('allows only one concurrent materializer to claim one confirmed lease', async () => {
    const fixture = await createDirtyFixture();
    const attempts = await Promise.allSettled([
      new SnapshotCandidateMaterializer().materialize({
        sourceRepositoryRoot: fixture.repository,
        sourceSnapshot: fixture.snapshot,
        leaseStore: fixture.store,
        confirmedBinding: fixture.authority.binding,
        worktreeLeaseStore: fixture.worktreeStore,
        worktreeLeaseBinding: fixture.worktreeAuthority.binding,
      }),
      new SnapshotCandidateMaterializer().materialize({
        sourceRepositoryRoot: fixture.repository,
        sourceSnapshot: fixture.snapshot,
        leaseStore: fixture.store,
        confirmedBinding: fixture.authority.binding,
        worktreeLeaseStore: fixture.worktreeStore,
        worktreeLeaseBinding: fixture.worktreeAuthority.binding,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await readdir(fixture.candidatesRoot)).toHaveLength(1);
  });

  it('recovers a verified candidate when the process stops before lease completion', async () => {
    const fixture = await createDirtyFixture({
      ownerProcessLivenessProof:
        await processProof(42, 'old-owner'),
      probeLiveness: () => Promise.resolve('dead'),
    });
    const materializer = new SnapshotCandidateMaterializer({
      now: () => new Date(BASE_TIME + 1_000),
    });
    let recoveryBinding: WorktreeLeaseAuthorityV1['binding'] | undefined;
    vi.spyOn(fixture.worktreeStore, 'completeMaterialization')
      .mockImplementationOnce(async (binding) => {
        recoveryBinding = binding;
        throw new Error('simulated process stop before lease completion');
      });

    await expect(materializer.materialize({
      sourceRepositoryRoot: fixture.repository,
      sourceSnapshot: fixture.snapshot,
      leaseStore: fixture.store,
      confirmedBinding: fixture.authority.binding,
      worktreeLeaseStore: fixture.worktreeStore,
      worktreeLeaseBinding: fixture.worktreeAuthority.binding,
    })).rejects.toThrow('simulated process stop');
    if (recoveryBinding === undefined) {
      throw new Error('The materializing binding was not captured.');
    }
    const interruptedLease = await fixture.worktreeStore.inspect(
      recoveryBinding.candidateId,
    );
    const adopted = await fixture.worktreeStore.adoptDeadOwner({
      candidateId: interruptedLease.candidateId,
      runId: interruptedLease.runId,
      ownerRunId: interruptedLease.ownerRunId,
      expectedLeaseDigest: interruptedLease.leaseDigest,
      nextProcessLivenessProof:
        await processProof(84, 'next-owner'),
    });

    const inspection =
      await fixture.worktreeStore.inspectMaterializationRecovery(
        adopted.lease.candidateId,
      );
    const assessment = assessSnapshotCandidateRecovery(inspection);
    expect(assessment.state).toBe('recoverable');
    if (assessment.state !== 'recoverable') {
      throw new Error('The candidate recovery assessment was not recoverable.');
    }
    expect(inspection.state).toBe('materialized_record_present');
    const recovered = await materializer.recoverMaterialized({
      snapshotBlobLeaseStore: fixture.store,
      worktreeLeaseStore: fixture.worktreeStore,
      worktreeLeaseBinding: adopted.binding,
      sourceSnapshot: fixture.snapshot,
    });
    expect(recovered.lease).toMatchObject({
      state: 'bootstrapping',
      materializedSourceDigest: assessment.record.materializedSourceDigest,
    });
    expect((await fixture.store.inspect(
      fixture.authority.lease.blobLeaseId,
    )).state).toBe('destroyed');
    expect((await fixture.worktreeStore.inspectMaterializationRecovery(
      recoveryBinding.candidateId,
    )).state).toBe('not_materializing');
  });

  it('refuses recovery when candidate bytes changed after the materialized record', async () => {
    const fixture = await createDirtyFixture();
    const materializer = new SnapshotCandidateMaterializer({
      now: () => new Date(BASE_TIME + 1_000),
    });
    let recoveryBinding: WorktreeLeaseAuthorityV1['binding'] | undefined;
    vi.spyOn(fixture.worktreeStore, 'completeMaterialization')
      .mockImplementationOnce(async (binding) => {
        recoveryBinding = binding;
        throw new Error('simulated process stop before lease completion');
      });
    await expect(materializer.materialize({
      sourceRepositoryRoot: fixture.repository,
      sourceSnapshot: fixture.snapshot,
      leaseStore: fixture.store,
      confirmedBinding: fixture.authority.binding,
      worktreeLeaseStore: fixture.worktreeStore,
      worktreeLeaseBinding: fixture.worktreeAuthority.binding,
    })).rejects.toThrow('simulated process stop');
    if (recoveryBinding === undefined) {
      throw new Error('The materializing binding was not captured.');
    }
    await writeFile(join(
      fixture.candidatesRoot,
      recoveryBinding.candidateId,
      'worktree',
      'src/index.ts',
    ), 'tampered after record\n');

    await expect(materializer.recoverMaterialized({
      snapshotBlobLeaseStore: fixture.store,
      worktreeLeaseStore: fixture.worktreeStore,
      worktreeLeaseBinding: recoveryBinding,
      sourceSnapshot: fixture.snapshot,
    })).rejects.toMatchObject({
      reasonCode: 'snapshot_candidate_verification_failed',
    });
    expect((await fixture.worktreeStore.inspect(
      recoveryBinding.candidateId,
    )).state).toBe('materializing');
  });
});
