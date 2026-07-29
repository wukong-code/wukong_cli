import { execFile } from 'node:child_process';
import {
  access,
  lstat,
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
  adoptWorktreeLease,
  canonicalDigest,
  canonicalJson,
  createCandidateBootstrapPlan,
  inspectSourceSnapshot,
  sealSourceSnapshot,
  transitionWorktreeLease,
  type CandidateBootstrapPlanV1,
  type SourceSnapshotV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withCandidateWriterAgent } from '../src/candidate-agent-writer';
import { CandidateDeltaStore } from '../src/candidate-delta-store';
import {
  captureProcessLivenessProof,
  type ProcessLivenessOutcome,
  type ProcessLivenessProofV1,
} from '../src/process-liveness-proof';
import { SingleModelProvider } from '../src/session/provider-manager';
import {
  SnapshotBlobLeaseStore,
  type SnapshotBlobLeaseAuthorityV1,
} from '../src/snapshot-blob-lease-store';
import {
  WorktreeLeaseStore,
  WorktreeLeaseStoreError,
  type WorktreeLeaseAuthorityV1,
} from '../src/worktree-lease-store';
import { testKaos } from './fixtures/test-kaos';
import { executeTool } from './tools/fixtures/execute-tool';
import {
  CandidateWorkspacePathPolicyV1,
} from '../src/tools/support/workspace';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T03:00:00.000Z');

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

interface Fixture {
  readonly parent: string;
  readonly repository: string;
  readonly candidatesRoot: string;
  readonly snapshot: SourceSnapshotV1;
  readonly blobAuthority: SnapshotBlobLeaseAuthorityV1;
  readonly store: WorktreeLeaseStore;
  readonly authority: WorktreeLeaseAuthorityV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
}

async function createFixture(options: {
  readonly ownerProcessLivenessProof?: ProcessLivenessProofV1;
  readonly probeLiveness?: (
    proof: ProcessLivenessProofV1,
  ) => Promise<ProcessLivenessOutcome>;
} = {}): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-worktree-lease-store-'));
  roots.push(parent);
  const repository = join(parent, 'repository');
  const candidatesRoot = join(parent, 'candidates');
  const blobRoot = join(parent, 'snapshot-blobs');
  await mkdir(repository);
  await git(repository, ['init']);
  await writeFile(join(repository, 'index.ts'), 'export const value = 1;\n');
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  await writeFile(join(repository, 'index.ts'), 'export const value = 2;\n');

  const inspected = await inspectSourceSnapshot({ cwd: repository });
  if (inspected.status !== 'ready' || inspected.proposedSnapshot === null) {
    throw new Error('Unable to prepare a source snapshot fixture.');
  }
  const snapshot = inspected.proposedSnapshot;
  const sealed = await sealSourceSnapshot({ cwd: repository, snapshot });
  const blobStore = new SnapshotBlobLeaseStore({
    rootDirectory: blobRoot,
    now: () => new Date(BASE_TIME),
  });
  const staged = await blobStore.stageAndSeal({
    containerBytes: sealed.containerBytes,
    sourceSnapshot: snapshot,
    createdByRunId: 'run_creator',
    ownerRunId: 'run_owner',
    expiresAt: '2026-07-29T03:10:00.000Z',
  });
  const blobAuthority = await blobStore.confirm(staged.binding);
  const store = new WorktreeLeaseStore({
    candidatesRootDirectory: candidatesRoot,
    now: () => new Date(BASE_TIME + 1_000),
    probeLiveness: options.probeLiveness,
  });
  const bootstrapPlan = createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8c60-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: snapshot.snapshotDigest,
    gatePlanDigest: digest('gate'),
    ecosystemRefs: [],
    lockfileDigests: [],
    steps: [],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: digest('budget'),
  });
  const authority = await store.reserve({
    sourceRepositoryRoot: repository,
    sourceSnapshot: snapshot,
    snapshotBlobLease: blobAuthority.lease,
    goalId: 'goal_1',
    contractId: 'contract_1',
    runId: 'run_1',
    ownerRunId: 'run_owner',
    ownerProcessIdentityDigest:
      options.ownerProcessLivenessProof?.proofDigest,
    ownerProcessLivenessProof:
      options.ownerProcessLivenessProof,
    bootstrapPlanDigest: bootstrapPlan.bootstrapPlanDigest,
    gatePlanDigest: bootstrapPlan.gatePlanDigest,
    criteriaSelectionDigest: null,
    expiresAt: '2026-07-29T03:10:00.000Z',
  });
  return {
    parent,
    repository,
    candidatesRoot,
    snapshot,
    blobAuthority,
    store,
    authority,
    bootstrapPlan,
  };
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/worktree-lease-store/v1', label);
}

function processProof(processId: number, marker: string) {
  return captureProcessLivenessProof(processId, {
    platform: 'darwin',
    processPresence: () => 'present',
    readStartMarker: () => Promise.resolve(marker),
  });
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root });
  return result.stdout;
}

function modeBits(mode: number): number {
  return mode & 0o777;
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

describe('WorktreeLeaseStore', () => {
  it.each(['live', 'unknown'] as const)(
    'refuses to adopt a %s materializing owner',
    async (outcome) => {
      const oldProof = await processProof(42, 'old-owner');
      const fixture = await createFixture({
        ownerProcessLivenessProof: oldProof,
        probeLiveness: () => Promise.resolve(outcome),
      });
      const materializing = await fixture.store.beginMaterialization(
        fixture.authority.binding,
      );

      await expect(fixture.store.adoptDeadOwner({
        candidateId: materializing.lease.candidateId,
        runId: materializing.lease.runId,
        ownerRunId: materializing.lease.ownerRunId,
        expectedLeaseDigest: materializing.lease.leaseDigest,
        nextProcessLivenessProof:
          await processProof(84, 'next-owner'),
      })).rejects.toMatchObject({
        reasonCode: outcome === 'live'
          ? 'worktree_lease_owner_live'
          : 'worktree_lease_liveness_unproven',
      });
    },
  );

  it('adopts a provably dead materializing owner and fences its old binding', async () => {
    const oldProof = await processProof(42, 'old-owner');
    const nextProof = await processProof(84, 'next-owner');
    const fixture = await createFixture({
      ownerProcessLivenessProof: oldProof,
      probeLiveness: () => Promise.resolve('dead'),
    });
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    const adopted = await fixture.store.adoptDeadOwner({
      candidateId: materializing.lease.candidateId,
      runId: materializing.lease.runId,
      ownerRunId: materializing.lease.ownerRunId,
      expectedLeaseDigest: materializing.lease.leaseDigest,
      nextProcessLivenessProof: nextProof,
    });

    expect(adopted.lease).toMatchObject({
      state: 'materializing',
      ownerProcessIdentityDigest: nextProof.proofDigest,
      casRevision: materializing.lease.casRevision + 1,
    });
    await expect(fixture.store.beginMaterialization(
      fixture.authority.binding,
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
    await expect(fixture.store.resumeOwned({
      candidateId: adopted.lease.candidateId,
      runId: adopted.lease.runId,
      ownerRunId: adopted.lease.ownerRunId,
      ownerProcessIdentityDigest: oldProof.proofDigest,
      expectedLeaseDigest: adopted.lease.leaseDigest,
    })).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
  });

  it('exposes authenticated ownership ancestry only inside a bootstrapping capability', async () => {
    const oldProof = await processProof(42, 'old-owner');
    const fixture = await createFixture({
      ownerProcessLivenessProof: oldProof,
      probeLiveness: () => Promise.resolve('dead'),
    });
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const bootstrapping =
      await fixture.store.completeMaterialization(
        materializing.binding,
        {
          candidatePathIdentity:
            await candidatePathIdentity(
              materializing.candidateDirectory,
            ),
          materializedSourceDigest: digest('materialized'),
          bootstrapRequired: true,
        },
      );
    const adopted = await fixture.store.adoptDeadOwner({
      candidateId: bootstrapping.lease.candidateId,
      runId: bootstrapping.lease.runId,
      ownerRunId: bootstrapping.lease.ownerRunId,
      expectedLeaseDigest: bootstrapping.lease.leaseDigest,
      nextProcessLivenessProof:
        await processProof(84, 'next-owner'),
    });

    await expect(fixture.store.withBootstrappingCandidate(
      adopted.binding,
      (_view, ownershipAncestors) => ownershipAncestors,
    )).resolves.toEqual([{
      leaseDigest: bootstrapping.lease.leaseDigest,
      fencingTokenDigest:
        bootstrapping.lease.fencingTokenDigest,
      state: 'bootstrapping',
    }]);
  });

  it('reserves private metadata and fences concurrent materialization claims', async () => {
    const fixture = await createFixture();
    const owner = join(
      fixture.candidatesRoot,
      fixture.authority.lease.candidateId,
    );

    expect(fixture.authority.lease).toMatchObject({
      state: 'creating',
      sourceSnapshotDigest: fixture.snapshot.snapshotDigest,
      snapshotBlobLeaseId: fixture.blobAuthority.lease.blobLeaseId,
    });
    expect(JSON.stringify(fixture.authority.binding)).toContain('[REDACTED]');
    if (process.platform !== 'win32') {
      expect(modeBits((await lstat(fixture.candidatesRoot)).mode)).toBe(0o700);
      expect(modeBits((await lstat(owner)).mode)).toBe(0o700);
      expect(modeBits((await lstat(join(owner, 'worktree-events'))).mode)).toBe(0o700);
      for (const file of [
        'worktree-lease.json',
        'worktree-capability.json',
        'worktree-lock',
      ]) {
        expect(modeBits((await lstat(join(owner, file))).mode)).toBe(0o600);
      }
    }

    const attempts = await Promise.allSettled([
      fixture.store.beginMaterialization(fixture.authority.binding),
      fixture.store.beginMaterialization(fixture.authority.binding),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect((await fixture.store.inspect(fixture.authority.lease.candidateId)).state)
      .toBe('materializing');
    expect((await fixture.store.inspectMaterializationRecovery(
      fixture.authority.lease.candidateId,
    )).state).toBe('materializing_empty');
  });

  it('only exposes the candidate root through an active capability', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const identity = await candidatePathIdentity(materializing.candidateDirectory);
    const completed = await fixture.store.completeMaterialization(
      materializing.binding,
      {
        candidatePathIdentity: identity,
        materializedSourceDigest: digest('materialized'),
        bootstrapRequired: true,
      },
    );
    expect(completed.lease.state).toBe('bootstrapping');
    const bootstrapView = await fixture.store.withBootstrappingCandidate(
      completed.binding,
      (candidate) => candidate,
    );
    expect(bootstrapView).toMatchObject({
      candidateDirectory: materializing.candidateDirectory,
      candidateRelativeCwd: materializing.candidateDirectory,
      workspace: {
        workspaceDir: materializing.candidateDirectory,
        additionalDirs: [],
        accessMode: 'workspace-only',
      },
    });
    expect(bootstrapView.bootstrapPrivateDirectory).toBe(
      join(
        fixture.candidatesRoot,
        completed.lease.candidateId,
        'bootstrap-private',
      ),
    );
    if (process.platform !== 'win32') {
      expect(modeBits(
        (await lstat(bootstrapView.bootstrapPrivateDirectory)).mode,
      )).toBe(0o700);
    }

    const active = await fixture.store.activate(completed.binding);
    await expect(fixture.store.withBootstrappingCandidate(
      active.binding,
      () => undefined,
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_invalid_state',
    });
    expect(Object.keys(active.rootCapability)).not.toContain('candidateDirectory');
    expect(JSON.stringify(active.rootCapability)).toContain('[PRIVATE]');
    const view = await fixture.store.withCandidateRoot(
      active.rootCapability,
      (candidate) => candidate,
    );
    expect(view).toEqual({
      candidateDirectory: materializing.candidateDirectory,
      candidateRelativeCwd: materializing.candidateDirectory,
      workspace: {
        workspaceDir: materializing.candidateDirectory,
        additionalDirs: [],
        accessMode: 'workspace-only',
      },
    });

    const adopted = await fixture.store.transferOwnership(active.binding, {
      newRunId: 'run_2',
      newOwnerRunId: 'run_owner_2',
      newOwnerProcessLivenessProof:
        await processProof(84, 'handoff-owner'),
      reasonCode: 'explicit_handoff',
    });
    expect(adopted.lease).toMatchObject({
      state: 'active',
      runId: 'run_2',
      ownerRunId: 'run_owner_2',
    });
    expect(adopted.lease.fencingTokenDigest)
      .not.toBe(active.lease.fencingTokenDigest);
    await expect(fixture.store.withCandidateRoot(
      active.rootCapability,
      () => undefined,
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
    await expect(fixture.store.transition(
      active.binding,
      'retained',
      'test_retention',
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
    const adoptedActive = await fixture.store.activate(adopted.binding);
    const retained = await fixture.store.transition(
      adoptedActive.binding,
      'retained',
      'test_retention',
    );
    expect(retained.lease.state).toBe('retained');
    await expect(fixture.store.withCandidateRoot(
      adoptedActive.rootCapability,
      () => undefined,
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_invalid_state',
    });
  });

  it('binds a Candidate Writer to the exact live root capability and minimal tools', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    await writeFile(join(materializing.candidateDirectory, 'source.txt'), 'before\n');
    const materialized = await fixture.store.completeMaterialization(
      materializing.binding,
      {
        candidatePathIdentity:
          await candidatePathIdentity(materializing.candidateDirectory),
        materializedSourceDigest: digest('materialized-writer'),
        bootstrapRequired: false,
      },
    );
    const active = await fixture.store.activate(materialized.binding);
    const dependencyDirectory = join(
      materializing.candidateDirectory,
      'node_modules',
      'fixture',
    );
    await mkdir(dependencyDirectory, { recursive: true });
    const dependencyFile = join(dependencyDirectory, 'index.js');
    const dependencyImage = join(dependencyDirectory, 'image.png');
    await writeFile(dependencyFile, 'module.exports = "dependency";\n');
    await writeFile(
      dependencyImage,
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    );
    const modelProvider = new SingleModelProvider({
      type: 'wukong',
      apiKey: 'test-key',
      model: 'writer-model',
    }, {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128_000,
    });
    const deltaStore = new CandidateDeltaStore({
      privateRootDirectory: fixture.candidatesRoot,
      sourceRepositoryRoot: fixture.repository,
      now: () => new Date(BASE_TIME + 2_000),
    });

    const escapedReadTool = await withCandidateWriterAgent(
      fixture.store,
      deltaStore,
      active.rootCapability,
      fixture.bootstrapPlan,
      {
        kaos: testKaos,
        modelProvider,
        modelAlias: 'writer-model',
        systemPrompt: 'Edit only the isolated candidate.',
      },
      async (agent) => {
        expect((await deltaStore.inspect(
          active.lease.candidateId,
        )).baseline.projection.entries.map(
          ({ canonicalRelativePath }) => canonicalRelativePath,
        )).toContain('source.txt');
        expect(agent.type).toBe('independent');
        expect(agent.toolMode).toBe('candidate-writer');
        expect(agent.tools.loopTools.map((tool) => tool.name).toSorted()).toEqual([
          'Edit',
          'Glob',
          'Grep',
          'Read',
          'ReadMediaFile',
          'Write',
        ]);
        expect(agent.tools.data().map((tool) => tool.name).toSorted()).toEqual([
          'Edit',
          'Glob',
          'Grep',
          'Read',
          'ReadMediaFile',
          'Write',
        ]);
        expect(() => {
          agent.tools.registerUserTool({
            name: 'Escape',
            description: 'escape',
            parameters: {},
          });
        }).toThrow(/cannot register user tools/u);
        expect(() => {
          agent.config.update({
            cwd: fixture.repository,
          });
        }).toThrow(/cwd is pinned/u);

        const deniedCalls = [
          {
            name: 'Read',
            args: { path: dependencyFile },
          },
          {
            name: 'Write',
            args: { path: dependencyFile, content: 'polluted\n' },
          },
          {
            name: 'Edit',
            args: {
              path: dependencyFile,
              old_string: 'dependency',
              new_string: 'polluted',
            },
          },
          {
            name: 'ReadMediaFile',
            args: { path: dependencyImage },
          },
          {
            name: 'Glob',
            args: {
              path: dependencyDirectory,
              pattern: '**/*',
              include_ignored: true,
            },
          },
          {
            name: 'Grep',
            args: {
              path: dependencyDirectory,
              pattern: 'dependency',
              output_mode: 'content',
            },
          },
        ] as const;
        for (const denied of deniedCalls) {
          const tool = agent.tools.loopTools.find(
            (candidate) => candidate.name === denied.name,
          );
          if (tool === undefined) {
            throw new Error(`${denied.name} tool missing.`);
          }
          const result = await executeTool(tool, {
            turnId: 'writer-turn',
            toolCallId: `writer-denied-${denied.name}`,
            args: denied.args,
            signal: new AbortController().signal,
          });
          expect(result.isError).toBe(true);
          expect(result.output).toContain(
            'bootstrap-owned generated paths',
          );
        }
        expect(await readFile(dependencyFile, 'utf8'))
          .toBe('module.exports = "dependency";\n');

        const writeTool = agent.tools.loopTools.find((tool) => tool.name === 'Write');
        if (writeTool === undefined) throw new Error('Write tool missing.');
        await expect(executeTool(writeTool, {
          turnId: 'writer-turn',
          toolCallId: 'writer-write',
          args: {
            path: join(materializing.candidateDirectory, 'source.txt'),
            content: 'after\n',
          },
          signal: new AbortController().signal,
        })).resolves.toMatchObject({
          output: expect.stringContaining('Wrote 6 bytes'),
        });
        expect(await readFile(
          join(materializing.candidateDirectory, 'source.txt'),
          'utf8',
        )).toBe('after\n');

        const readTool = agent.tools.loopTools.find((tool) => tool.name === 'Read');
        if (readTool === undefined) throw new Error('Read tool missing.');
        return readTool;
      },
    );

    await expect(executeTool(escapedReadTool, {
      turnId: 'escaped-turn',
      toolCallId: 'escaped-read',
      args: {
        path: join(materializing.candidateDirectory, 'source.txt'),
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });

    await fixture.store.transition(active.binding, 'verifying');
    const sealed = await deltaStore.sealDelta({
      worktreeLeaseStore: fixture.store,
      rootCapability: active.rootCapability,
      bootstrapPlan: fixture.bootstrapPlan,
    });
    expect(sealed.delta.changedPaths).toEqual(['source.txt']);
    expect(sealed.delta.changedPaths.some((path) =>
      path.includes('node_modules'))).toBe(false);
  });

  it('fails Candidate Writer closed when the bootstrap plan or live lease drifts', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    await writeFile(
      join(materializing.candidateDirectory, 'source.txt'),
      'before\n',
    );
    const materialized = await fixture.store.completeMaterialization(
      materializing.binding,
      {
        candidatePathIdentity:
          await candidatePathIdentity(materializing.candidateDirectory),
        materializedSourceDigest: digest('materialized-writer-drift'),
        bootstrapRequired: false,
      },
    );
    const active = await fixture.store.activate(materialized.binding);
    const modelProvider = new SingleModelProvider({
      type: 'wukong',
      apiKey: 'test-key',
      model: 'writer-model',
    });
    const deltaStore = new CandidateDeltaStore({
      privateRootDirectory: fixture.candidatesRoot,
      sourceRepositoryRoot: fixture.repository,
      now: () => new Date(BASE_TIME + 2_000),
    });
    const driftedPlan = createCandidateBootstrapPlan({
      bootstrapPlanId: '019f8cf1-0000-7abc-8def-0123456789ab',
      sourceSnapshotDigest: fixture.bootstrapPlan.sourceSnapshotDigest,
      gatePlanDigest: fixture.bootstrapPlan.gatePlanDigest,
      ecosystemRefs: [],
      lockfileDigests: [],
      steps: [],
      injectedEnvironmentNames: [],
      networkPolicy: 'deny',
      allowedRegistryEndpointDigests: [],
      permissionDigest: digest('drifted-permission'),
      bootstrapBudgetDigest: digest('drifted-budget'),
    });
    const driftedCallback = vi.fn();
    const driftedPathPolicy =
      CandidateWorkspacePathPolicyV1.create(driftedPlan);

    await expect(fixture.store.withCandidateRoot(
      active.rootCapability,
      driftedCallback,
      driftedPathPolicy,
    )).rejects.toThrow(/path policy is stale or unauthentic/u);
    expect(driftedCallback).not.toHaveBeenCalled();

    await expect(withCandidateWriterAgent(
      fixture.store,
      deltaStore,
      active.rootCapability,
      driftedPlan,
      {
        kaos: testKaos,
        modelProvider,
        modelAlias: 'writer-model',
        systemPrompt: 'Edit only the isolated candidate.',
      },
      driftedCallback,
    )).rejects.toMatchObject({
      reasonCode: 'candidate_delta_invalid_state',
    });
    expect(driftedCallback).not.toHaveBeenCalled();

    await expect(withCandidateWriterAgent(
      fixture.store,
      deltaStore,
      active.rootCapability,
      fixture.bootstrapPlan,
      {
        kaos: testKaos,
        modelProvider,
        modelAlias: 'writer-model',
        systemPrompt: 'Edit only the isolated candidate.',
      },
      async (agent) => {
        const writeTool = agent.tools.loopTools.find(
          (tool) => tool.name === 'Write',
        );
        if (writeTool === undefined) throw new Error('Write tool missing.');
        await fixture.store.transition(active.binding, 'verifying');
        await executeTool(writeTool, {
          turnId: 'writer-drift-turn',
          toolCallId: 'writer-drift-write',
          args: {
            path: join(
              materializing.candidateDirectory,
              'source.txt',
            ),
            content: 'must-not-write\n',
          },
          signal: new AbortController().signal,
        });
      },
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
    expect(await readFile(
      join(materializing.candidateDirectory, 'source.txt'),
      'utf8',
    )).toBe('before\n');
  });

  it('rejoins an exact Candidate Gate lease transition from durable evidence', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const materialized = await fixture.store.completeMaterialization(
      materializing.binding,
      {
        candidatePathIdentity:
          await candidatePathIdentity(materializing.candidateDirectory),
        materializedSourceDigest: digest('materialized-gate-join'),
        bootstrapRequired: false,
      },
    );
    const active = await fixture.store.activate(materialized.binding);
    const verifying = await fixture.store.transition(
      active.binding,
      'verifying',
    );
    const attemptId = '019f8ca1-0000-7abc-8def-0123456789ab';
    await fixture.store.transition(
      verifying.binding,
      'awaiting_promotion',
      `candidate_gate_passed:${attemptId}`,
    );

    await expect(fixture.store.hasTransitionEvidence({
      candidateId: verifying.lease.candidateId,
      leaseId: verifying.lease.leaseId,
      previousLeaseDigest: verifying.lease.leaseDigest,
      toState: 'awaiting_promotion',
      reasonCode: `candidate_gate_passed:${attemptId}`,
    })).resolves.toBe(true);
    await expect(fixture.store.hasTransitionEvidence({
      candidateId: verifying.lease.candidateId,
      leaseId: verifying.lease.leaseId,
      previousLeaseDigest: digest('other-verifying-lease'),
      toState: 'awaiting_promotion',
      reasonCode: `candidate_gate_passed:${attemptId}`,
    })).resolves.toBe(false);
  });

  it('rejects stale bindings after every successful CAS transition', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await expect(fixture.store.beginMaterialization(
      fixture.authority.binding,
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const identity = await candidatePathIdentity(materializing.candidateDirectory);
    await fixture.store.completeMaterialization(materializing.binding, {
      candidatePathIdentity: identity,
      materializedSourceDigest: digest('materialized'),
      bootstrapRequired: false,
    });
    await expect(fixture.store.completeMaterialization(materializing.binding, {
      candidatePathIdentity: identity,
      materializedSourceDigest: digest('materialized'),
      bootstrapRequired: false,
    })).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
  });

  it('repairs a valid journal that is exactly one durable transition ahead', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const identity = await candidatePathIdentity(materializing.candidateDirectory);
    const next = transitionWorktreeLease(materializing.lease, {
      toState: 'bootstrapping',
      occurredAt: '2026-07-29T03:00:02.000Z',
      worktreeIdentity: identity,
      materializedSourceDigest: digest('recovered-materialized'),
    });
    const owner = join(fixture.candidatesRoot, materializing.lease.candidateId);
    await writeFile(
      join(owner, 'worktree-events', '000000000002.json'),
      canonicalJson(next.event),
      { mode: 0o600 },
    );

    const repaired = await fixture.store.inspect(materializing.lease.candidateId);
    expect(repaired).toEqual(next.lease);
    const persisted: WorktreeLeaseV1 = JSON.parse(
      await readFile(join(owner, 'worktree-lease.json'), 'utf8'),
    );
    expect(persisted).toEqual(next.lease);
  });

  it('fails closed when the journal is invalid instead of rewriting it', async () => {
    const fixture = await createFixture();
    const owner = join(
      fixture.candidatesRoot,
      fixture.authority.lease.candidateId,
    );
    await writeFile(
      join(owner, 'worktree-events', '000000000001.json'),
      '{}',
      { mode: 0o600 },
    );

    await expect(fixture.store.inspect(
      fixture.authority.lease.candidateId,
    )).rejects.toBeInstanceOf(WorktreeLeaseStoreError);
    expect(JSON.parse(
      await readFile(join(owner, 'worktree-lease.json'), 'utf8'),
    )).toEqual(fixture.authority.lease);
  });

  it('reconciles an adoption interrupted after its event and resumes exact ownership', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const active = await fixture.store.completeMaterialization(
      materializing.binding,
      {
        candidatePathIdentity:
          await candidatePathIdentity(materializing.candidateDirectory),
        materializedSourceDigest: digest('materialized'),
        bootstrapRequired: false,
      },
    );
    const nextRawFencingToken = 'next-fencing-token-for-crash-recovery-0001';
    const nextProcessLivenessProof =
      await processProof(84, 'recovered-owner');
    const adopted = adoptWorktreeLease(active.lease, {
      newRunId: 'run_2',
      newOwnerRunId: 'run_owner_2',
      newOwnerProcessIdentityDigest:
        nextProcessLivenessProof.proofDigest,
      newFencingTokenDigest: canonicalDigest(
        'wukong/worktree-lease-fencing-token/v1',
        nextRawFencingToken,
      ),
      occurredAt: '2026-07-29T03:00:03.000Z',
      reasonCode: 'explicit_handoff',
    });
    const owner = join(fixture.candidatesRoot, active.lease.candidateId);
    const pendingPath = join(owner, 'worktree-ownership-pending.json');
    await writeFile(pendingPath, canonicalJson({
      schemaVersion: 1,
      leaseId: adopted.lease.leaseId,
      candidateId: adopted.lease.candidateId,
      previousLeaseDigest: active.lease.leaseDigest,
      nextLeaseDigest: adopted.lease.leaseDigest,
      newRawFencingToken: nextRawFencingToken,
      nextProcessLivenessProof,
    }), { mode: 0o600 });
    await writeFile(
      join(
        owner,
        'worktree-events',
        `${String(adopted.event.sequence).padStart(12, '0')}.json`,
      ),
      canonicalJson(adopted.event),
      { mode: 0o600 },
    );

    expect(await fixture.store.inspect(active.lease.candidateId))
      .toEqual(adopted.lease);
    await expect(access(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(
      await readFile(join(owner, 'worktree-capability.json'), 'utf8'),
    )).toMatchObject({ rawFencingToken: nextRawFencingToken });

    const resumed = await fixture.store.resumeOwned({
      candidateId: adopted.lease.candidateId,
      runId: adopted.lease.runId,
      ownerRunId: adopted.lease.ownerRunId,
      ownerProcessIdentityDigest:
        nextProcessLivenessProof.proofDigest,
      expectedLeaseDigest: adopted.lease.leaseDigest,
    });
    expect((await fixture.store.activate(resumed.binding)).lease.state).toBe('active');
    await expect(fixture.store.transition(
      active.binding,
      'retained',
      'stale_owner',
    )).rejects.toMatchObject({
      reasonCode: 'worktree_lease_stale_binding',
    });
  });

  it('restores a fenced candidate root while verification is in progress', async () => {
    const fixture = await createFixture();
    const materializing = await fixture.store.beginMaterialization(
      fixture.authority.binding,
    );
    await mkdir(materializing.candidateDirectory, { mode: 0o700 });
    const active = await fixture.store.completeMaterialization(
      materializing.binding,
      {
        candidatePathIdentity:
          await candidatePathIdentity(materializing.candidateDirectory),
        materializedSourceDigest: digest('materialized-for-restore'),
        bootstrapRequired: false,
      },
    );
    const verifying = await fixture.store.transition(
      active.binding,
      'verifying',
    );
    const restarted = new WorktreeLeaseStore({
      candidatesRootDirectory: fixture.candidatesRoot,
      now: () => new Date(BASE_TIME + 4_000),
    });
    const resumed = await restarted.resumeOwned({
      candidateId: verifying.lease.candidateId,
      runId: verifying.lease.runId,
      ownerRunId: verifying.lease.ownerRunId,
      expectedLeaseDigest: verifying.lease.leaseDigest,
    });
    const restored = await restarted.restoreCandidateRoot(
      resumed.binding,
    );

    expect(restored.lease.state).toBe('verifying');
    expect(await restarted.withCandidateRoot(
      restored.rootCapability,
      (view) => view.candidateDirectory,
    )).toBe(materializing.candidateDirectory);
    expect(await restarted.inspectVerifyingLeaseDigest(
      verifying.lease.candidateId,
    )).toBe(verifying.lease.leaseDigest);
    await restarted.transition(
      restored.binding,
      'awaiting_promotion',
      'candidate_gate_passed:test',
    );
    expect(await restarted.inspectVerifyingLeaseDigest(
      verifying.lease.candidateId,
    )).toBe(verifying.lease.leaseDigest);
  });
});
