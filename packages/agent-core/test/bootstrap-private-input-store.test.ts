import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  createWorktreeLease,
  digestCandidateBootstrapArgv,
  digestCandidateBootstrapEnvironment,
  transitionWorktreeLease,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapStepV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BootstrapPrivateInputStore,
  BootstrapPrivateInputStoreError,
} from '../src/bootstrap-private-input-store';
import {
  inspectTrustedExecutable,
  type TrustedExecutableHandleV1,
} from '../src/trusted-executable';

const roots: string[] = [];
const BASE_TIME = Date.parse('2026-07-29T05:00:00.000Z');
const ARGV = ['--version'];
const PRIVATE_SECRET =
  'sk_live_wukongPrivacySentinel123456789';
const ENVIRONMENT = {
  CI: '1',
  TOKEN: PRIVATE_SECRET,
  API_KEY: PRIVATE_SECRET,
  AUTHORIZATION: `Bearer ${PRIVATE_SECRET}`,
  REGISTRY_URL:
    `https://alice:${PRIVATE_SECRET}@example.test/v1?token=${PRIVATE_SECRET}`,
};

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

interface Fixture {
  readonly parent: string;
  readonly root: string;
  readonly executable: TrustedExecutableHandleV1;
  readonly step: CandidateBootstrapStepV1;
  readonly plan: CandidateBootstrapPlanV1;
  readonly lease: WorktreeLeaseV1;
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/bootstrap-private-store/v1', label);
}

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-private-'));
  roots.push(parent);
  const root = join(parent, 'bootstrap-private');
  await mkdir(root, { mode: 0o700 });
  const executable = await inspectTrustedExecutable({
    executablePath: await realpath(process.execPath),
    versionProbeArgs: ['--version'],
    forbiddenRoots: [parent],
  });
  const step = createCandidateBootstrapStep({
    stepId: 'runtime_version',
    recipeRef: 'builtin:runtime-version',
    recipeVersion: '1.0.0',
    executableIdentity: executable.identity.executableIdentityDigest,
    runtimeVersionDigest: executable.identity.runtimeVersionDigest,
    exactArgvPrivateRef: 'private/bootstrap/argv/runtime-version',
    argvDigest: digestCandidateBootstrapArgv(ARGV),
    effectiveEnvironmentPrivateRef:
      'private/bootstrap/env/runtime-version',
    effectiveEnvironmentDigest:
      digestCandidateBootstrapEnvironment(ENVIRONMENT),
    candidateRelativeCwd: '.',
    generatedPathScopes: [],
    timeoutMs: 5_000,
  });
  const plan = createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8bd0-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: digest('snapshot'),
    gatePlanDigest: digest('gate'),
    ecosystemRefs: ['runtime:node'],
    lockfileDigests: [],
    steps: [step],
    injectedEnvironmentNames: ['TOKEN'],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: digest('budget'),
  });
  const created = createWorktreeLease({
    leaseId: '019f8bd0-0001-7abc-8def-0123456789ab',
    candidateId: '019f8bd0-0002-7abc-8def-0123456789ab',
    goalId: 'goal_1',
    contractId: 'contract_1',
    runId: 'run_1',
    ownerRunId: 'owner_1',
    ownerProcessIdentityDigest: digest('process-1'),
    sourceSnapshotDigest: plan.sourceSnapshotDigest,
    snapshotBlobLeaseId: '019f8bd0-0003-7abc-8def-0123456789ab',
    snapshotBlobLeaseDigest: digest('blob-lease'),
    manifestDigest: digest('manifest'),
    materializationPolicyDigest: digest('materialization-policy'),
    bootstrapPlanDigest: plan.bootstrapPlanDigest,
    gatePlanDigest: plan.gatePlanDigest,
    criteriaSelectionDigest: null,
    repositoryIdentity: digest('repository'),
    baseCommit: 'a'.repeat(40),
    repositoryRelativeCwd: '.',
    candidateBranch:
      'wukong/candidate/019f8bd0-0002-7abc-8def-0123456789ab',
    createdByRunId: 'run_1',
    createdAt: '2026-07-29T05:00:00.000Z',
    expiresAt: '2026-07-29T05:10:00.000Z',
    fencingTokenDigest: digest('fencing'),
  });
  const materializing = transitionWorktreeLease(created.lease, {
    toState: 'materializing',
    occurredAt: '2026-07-29T05:00:01.000Z',
  });
  const bootstrapping = transitionWorktreeLease(materializing.lease, {
    toState: 'bootstrapping',
    occurredAt: '2026-07-29T05:00:02.000Z',
    worktreeIdentity: digest('worktree'),
    materializedSourceDigest: digest('materialized'),
  });
  return {
    parent,
    root,
    executable,
    step,
    plan,
    lease: bootstrapping.lease,
  };
}

describe('BootstrapPrivateInputStore', () => {
  it('stores exact argv/environment privately and exposes them only in a callback', async () => {
    const value = await fixture();
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 3_000),
    });
    const handle = await store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    });

    expect(JSON.stringify(handle)).toContain('[PRIVATE]');
    expect(JSON.stringify(handle)).not.toContain(PRIVATE_SECRET);
    const seen = await store.withInputs(handle, (inputs) => ({
      argv: inputs.argv,
      environment: inputs.effectiveEnvironment,
      executablePath: inputs.executablePath,
    }));
    expect(seen.argv).toEqual(ARGV);
    expect(seen.environment).toEqual(ENVIRONMENT);
    expect(seen.executablePath).toBe(await realpath(process.execPath));
    const files = (await readdir(value.root))
      .filter((name) => name.startsWith('step-'));
    expect(files).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await lstat(join(value.root, files[0]!))).mode & 0o777)
        .toBe(0o600);
    }
  });

  it('stages idempotently and resumes from the same private root', async () => {
    const value = await fixture();
    const firstStore = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 3_000),
    });
    const input = {
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    } as const;
    const first = await firstStore.stage(input);
    const second = await firstStore.stage(input);
    expect(second.recordDigest).toBe(first.recordDigest);

    const resumed = await new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 4_000),
    }).resume(value.lease, value.plan, value.step);
    expect(resumed.recordDigest).toBe(first.recordDigest);
  });

  it('rejects missing injected environment values and digest drift', async () => {
    const value = await fixture();
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 3_000),
    });

    await expect(store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: { CI: '1' },
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    })).rejects.toBeInstanceOf(BootstrapPrivateInputStoreError);
    await expect(store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ['changed'],
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    })).rejects.toMatchObject({
      reasonCode: 'bootstrap_private_invalid_input',
    });
  });

  it('fails closed after private record tampering', async () => {
    const value = await fixture();
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 3_000),
    });
    const handle = await store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    });
    const recordName = (await readdir(value.root))
      .find((name) => name.startsWith('step-'));
    const recordPath = join(value.root, recordName!);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.effectiveEnvironment.TOKEN = 'tampered';
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });

    await expect(store.withInputs(handle, () => undefined))
      .rejects.toMatchObject({
        reasonCode: 'bootstrap_private_integrity_failed',
      });
  });

  it('destroys secret-bearing inputs and leaves only a digest tombstone', async () => {
    const value = await fixture();
    const now = { value: BASE_TIME + 3_000 };
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(now.value),
    });
    const handle = await store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    });
    now.value = Date.parse('2026-07-29T05:06:00.000Z');
    await expect(store.withInputs(handle, () => undefined))
      .rejects.toMatchObject({ reasonCode: 'bootstrap_private_expired' });
    await store.destroy(handle);
    await store.destroy(handle);

    const names = (await readdir(value.root))
      .filter((name) => name.startsWith('step-'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.destroyed\.json$/u);
    const tombstone = await readFile(join(value.root, names[0]!), 'utf8');
    expect(tombstone).not.toContain(PRIVATE_SECRET);
    expect(tombstone).not.toContain('alice');
    expect(tombstone).not.toContain('Authorization');
    expect(tombstone).not.toContain(await realpath(process.execPath));
    await expect(store.resume(value.lease, value.plan, value.step))
      .rejects.toMatchObject({ reasonCode: 'bootstrap_private_destroyed' });
  });

  it('finishes deletion after a crash between tombstone and unlink', async () => {
    const value = await fixture();
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 3_000),
    });
    const handle = await store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    });
    const recordName = (await readdir(value.root))
      .find((name) => /^step-.*\.json$/u.test(name));
    const recordPath = join(value.root, recordName!);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    const tombstoneCore = {
      schemaVersion: 1 as const,
      leaseId: record.leaseId,
      candidateId: record.candidateId,
      bootstrapPlanDigest: record.bootstrapPlanDigest,
      stepId: record.stepId,
      stepDigest: record.stepDigest,
      destroyedRecordDigest: record.recordDigest,
      destroyedAt: '2026-07-29T05:00:04.000Z',
    };
    const tombstone = {
      ...tombstoneCore,
      tombstoneDigest: canonicalDigest(
        'wukong/bootstrap-step-private-inputs-tombstone/v1',
        tombstoneCore,
      ),
    };
    await writeFile(
      join(
        value.root,
        `step-${value.step.stepDigest.slice('sha256:'.length)}.destroyed.json`,
      ),
      canonicalJson(tombstone),
      { mode: 0o600 },
    );

    await expect(store.withInputs(handle, () => undefined))
      .rejects.toMatchObject({ reasonCode: 'bootstrap_private_destroyed' });
    await store.destroy(handle);
    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(value.root))
        .filter((name) => name.startsWith('step-')),
    ).toHaveLength(1);
  });

  it('rejects a handle issued by another private store', async () => {
    const value = await fixture();
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
      now: () => new Date(BASE_TIME + 3_000),
    });
    const handle = await store.stage({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      argv: ARGV,
      effectiveEnvironment: ENVIRONMENT,
      trustedExecutable: value.executable,
      expiresAt: '2026-07-29T05:05:00.000Z',
    });
    const otherRoot = join(value.parent, 'other-private');
    await mkdir(otherRoot, { mode: 0o700 });
    const other = new BootstrapPrivateInputStore({
      rootDirectory: otherRoot,
    });

    await expect(other.withInputs(handle, () => undefined))
      .rejects.toMatchObject({
        reasonCode: 'bootstrap_private_stale_handle',
      });
    await expect(access(join(otherRoot, 'unexpected')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a non-private store root', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    await chmod(value.root, 0o755);
    const store = new BootstrapPrivateInputStore({
      rootDirectory: value.root,
    });

    await expect(store.resume(value.lease, value.plan, value.step))
      .rejects.toMatchObject({
        reasonCode: 'bootstrap_private_root_unsafe',
      });
  });
});
