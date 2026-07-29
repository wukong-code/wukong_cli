import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  canonicalDigest,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  inspectSourceSnapshot,
  sealSourceSnapshot,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CandidateDeltaStore,
  CandidateDeltaStoreError,
} from '../src/candidate-delta-store';
import { SnapshotBlobLeaseStore } from '../src/snapshot-blob-lease-store';
import {
  type ActivatedWorktreeLeaseV1,
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T07:00:00.000Z');

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('CandidateDeltaStore', () => {
  it('persists the post-bootstrap baseline and seals only Agent changes', async () => {
    const value = await fixture();
    const baseline = await value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });

    expect(baseline.projection.entries.map(({ canonicalRelativePath }) =>
      canonicalRelativePath)).toContain('dirty-user.ts');

    const candidate = value.candidateDirectory;
    await writeFile(join(candidate, 'create.ts'), 'created\n');
    await rm(join(candidate, 'delete.ts'));
    await chmod(join(candidate, 'mode.sh'), 0o755);
    await rename(
      join(candidate, 'rename-old.ts'),
      join(candidate, 'rename-new.ts'),
    );
    await writeFile(join(candidate, 'update.ts'), 'after\n');
    await mkdir(join(candidate, 'node_modules'));
    await writeFile(join(candidate, 'node_modules', 'generated.js'), 'skip\n');
    await mkdir(join(candidate, 'generated-output'));
    await writeFile(
      join(candidate, 'generated-output', 'bootstrap.log'),
      'skip plan-owned output\n',
    );

    await value.worktreeStore.transition(value.active.binding, 'verifying');
    const seal = await value.deltaStore.sealDelta({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });

    expect(seal.delta.changedPaths).toEqual([
      'create.ts',
      'delete.ts',
      'mode.sh',
      'rename-new.ts',
      'rename-old.ts',
      'update.ts',
    ]);
    expect(seal.delta.changedPaths).not.toContain('dirty-user.ts');
    expect(seal.delta.changedPaths).not.toContain('node_modules/generated.js');
    expect(seal.delta.changedPaths)
      .not.toContain('generated-output/bootstrap.log');
    expect(seal.manifest.changes.map(({ operation }) => operation).toSorted())
      .toEqual(['create', 'delete', 'mode', 'rename', 'update']);
    expect((await value.deltaStore.sealDelta({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    })).sealDigest).toBe(seal.sealDigest);
    expect((await value.deltaStore.inspect(value.active.lease.candidateId)).seal)
      .toEqual(seal);
    const recoveredStore = new CandidateDeltaStore({
      privateRootDirectory: value.candidatesRoot,
      sourceRepositoryRoot: value.sourceRepositoryRoot,
      now: () => new Date(BASE_TIME + 3_000),
    });
    expect((await recoveredStore.inspect(value.active.lease.candidateId)).seal)
      .toEqual(seal);
  });

  it('fails closed on post-seal mutation and private-record tampering', async () => {
    const value = await fixture();
    await value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });
    await writeFile(join(value.candidateDirectory, 'create.ts'), 'created\n');
    await value.worktreeStore.transition(value.active.binding, 'verifying');
    await value.deltaStore.sealDelta({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    });
    await writeFile(join(value.candidateDirectory, 'create.ts'), 'changed\n');

    await expect(value.deltaStore.sealDelta({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_delta_conflict',
    });

    const baselinePath = join(
      value.candidatesRoot,
      value.active.lease.candidateId,
      'candidate-baseline.json',
    );
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as {
      recordDigest: string;
    };
    baseline.recordDigest = digest('tampered');
    await writeFile(baselinePath, JSON.stringify(baseline));

    await expect(
      value.deltaStore.inspect(value.active.lease.candidateId),
    ).rejects.toBeInstanceOf(CandidateDeltaStoreError);
    await expect(
      value.deltaStore.inspect(value.active.lease.candidateId),
    ).rejects.toMatchObject({
      reasonCode: 'candidate_delta_integrity_failed',
    });
  });

  it('rejects multiply-linked files in a candidate projection', async () => {
    const value = await fixture();
    await link(
      join(value.candidateDirectory, 'update.ts'),
      join(value.candidateDirectory, 'linked.ts'),
    );

    await expect(value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_delta_integrity_failed',
    });
  });

  it('fails closed when a projection parent is replaced by an escaping symlink', async () => {
    const value = await fixture();
    const outside = join(dirname(value.candidateDirectory), 'outside-tree');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.ts'), 'outside\n');
    await symlink(outside, join(value.candidateDirectory, 'replaced-parent'));

    await expect(value.deltaStore.initializeBaseline({
      worktreeLeaseStore: value.worktreeStore,
      rootCapability: value.active.rootCapability,
      bootstrapPlan: value.bootstrapPlan,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_delta_integrity_failed',
    });
  });
});

interface Fixture {
  readonly candidatesRoot: string;
  readonly sourceRepositoryRoot: string;
  readonly candidateDirectory: string;
  readonly worktreeStore: WorktreeLeaseStore;
  readonly deltaStore: CandidateDeltaStore;
  readonly active: ActivatedWorktreeLeaseV1;
  readonly bootstrapPlan: ReturnType<typeof createCandidateBootstrapPlan>;
}

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-candidate-delta-'));
  roots.push(parent);
  const repository = join(parent, 'repository');
  const candidatesRoot = join(parent, 'candidates');
  await mkdir(repository);
  await git(repository, ['init']);
  await Promise.all([
    writeFile(join(repository, 'delete.ts'), 'delete me\n'),
    writeFile(join(repository, 'mode.sh'), 'echo ok\n'),
    writeFile(join(repository, 'rename-old.ts'), 'same bytes\n'),
    writeFile(join(repository, 'update.ts'), 'before\n'),
  ]);
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
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
    expiresAt: '2026-07-29T07:10:00.000Z',
  });
  const blob = await blobStore.confirm(staged.binding);
  const bootstrapStep = createCandidateBootstrapStep({
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
    generatedPathScopes: ['generated-output', 'node_modules'],
    timeoutMs: 5_000,
  });
  const bootstrapPlan = createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8c50-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: snapshot.snapshotDigest,
    gatePlanDigest: digest('gate'),
    ecosystemRefs: ['node:npm'],
    lockfileDigests: [],
    steps: [bootstrapStep],
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
    goalId: 'goal_delta',
    contractId: 'contract_delta',
    runId: 'run_delta',
    ownerRunId: 'run_owner',
    bootstrapPlanDigest: bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: bootstrapPlan.gatePlanDigest,
    criteriaSelectionDigest: null,
    expiresAt: '2026-07-29T07:10:00.000Z',
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
  await writeFile(
    join(materializing.candidateDirectory, 'dirty-user.ts'),
    'user preexisting change\n',
  );
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
    candidatesRoot,
    sourceRepositoryRoot: repository,
    candidateDirectory: materializing.candidateDirectory,
    worktreeStore,
    deltaStore: new CandidateDeltaStore({
      privateRootDirectory: candidatesRoot,
      sourceRepositoryRoot: repository,
      now: () => new Date(BASE_TIME + 2_000),
    }),
    active,
    bootstrapPlan,
  };
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-delta-store/v1', label);
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
