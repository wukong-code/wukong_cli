import {
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
  createBootstrapBudget,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  createWorktreeLease,
  digestCandidateBootstrapArgv,
  digestCandidateBootstrapEnvironment,
  transitionWorktreeLease,
  type BootstrapBudgetV1,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapStepV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CandidateBootstrapExecutor,
  type ExecuteCandidateBootstrapStepV1,
} from '../src/candidate-bootstrap-executor';
import {
  CANDIDATE_BOOTSTRAP_CWD_REF,
} from '../src/candidate-bootstrap-environment';
import { CandidateBootstrapStateStore } from '../src/candidate-bootstrap-state-store';
import {
  inspectTrustedExecutable,
  type TrustedExecutableHandleV1,
} from '../src/trusted-executable';
import {
  WorktreeLeaseBindingV1,
  type BootstrappingCandidateViewV1,
  type WorktreeLeaseAuthorityV1,
} from '../src/worktree-lease-store';

const roots: string[] = [];
const ENVIRONMENT = {
  CI: '1',
  TOKEN: 'executor-private-secret',
};
const IDS = {
  plan: '019f8bf0-0000-7abc-8def-0123456789ab',
  budget: '019f8bf0-0001-7abc-8def-0123456789ab',
  journal: '019f8bf0-0002-7abc-8def-0123456789ab',
  lease: '019f8bf0-0003-7abc-8def-0123456789ab',
  candidate: '019f8bf0-0004-7abc-8def-0123456789ab',
  blobLease: '019f8bf0-0005-7abc-8def-0123456789ab',
  reservation: '019f8bf0-0010-7abc-8def-0123456789ab',
  reserveBudget: '019f8bf0-0011-7abc-8def-0123456789ab',
  prepareJournal: '019f8bf0-0012-7abc-8def-0123456789ab',
  startBudget: '019f8bf0-0013-7abc-8def-0123456789ab',
  startJournal: '019f8bf0-0014-7abc-8def-0123456789ab',
  finishBudget: '019f8bf0-0015-7abc-8def-0123456789ab',
  finishJournal: '019f8bf0-0016-7abc-8def-0123456789ab',
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly parent: string;
  readonly candidate: string;
  readonly privateRoot: string;
  readonly executable: TrustedExecutableHandleV1;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly budget: BootstrapBudgetV1;
  readonly step: CandidateBootstrapStepV1;
  readonly plan: CandidateBootstrapPlanV1;
  readonly lease: WorktreeLeaseV1;
  readonly authority: WorktreeLeaseAuthorityV1;
  readonly executor: CandidateBootstrapExecutor;
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/bootstrap-executor/v1', label);
}

async function fixture(
  script: string,
  options: {
    readonly timeoutMs?: number;
    readonly outputLimit?: number;
    readonly generatedLimit?: number;
    readonly wallClockLimit?: number;
    readonly explicitNetwork?: boolean;
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-executor-'));
  roots.push(parent);
  const candidate = join(parent, 'candidate');
  const privateRoot = join(parent, 'bootstrap-private');
  await mkdir(candidate, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  await writeFile(join(candidate, 'source.txt'), 'source\n');
  const executable = await inspectTrustedExecutable({
    executablePath: await realpath(process.execPath),
    versionProbeArgs: ['--version'],
    forbiddenRoots: [parent],
  });
  const argv = ['-e', script];
  const environment = options.environment ?? ENVIRONMENT;
  const budget = createBootstrapBudget({
    budgetId: IDS.budget,
    bootstrapPlanId: IDS.plan,
    wallClockLimitMs: options.wallClockLimit ?? 20_000,
    generatedByteLimit: options.generatedLimit ?? 1_000_000,
    processOutputByteLimit: options.outputLimit ?? 100_000,
    stepLimit: 2,
  });
  const step = createCandidateBootstrapStep({
    stepId: 'node_bootstrap',
    recipeRef: 'builtin:node-eval-test',
    recipeVersion: '1.0.0',
    executableIdentity: executable.identity.executableIdentityDigest,
    runtimeVersionDigest: executable.identity.runtimeVersionDigest,
    exactArgvPrivateRef: 'private/bootstrap/argv/node',
    argvDigest: digestCandidateBootstrapArgv(argv),
    effectiveEnvironmentPrivateRef: 'private/bootstrap/env/node',
    effectiveEnvironmentDigest:
      digestCandidateBootstrapEnvironment(environment),
    candidateRelativeCwd: '.',
    generatedPathScopes: ['node_modules'],
    timeoutMs: options.timeoutMs ?? 5_000,
  });
  const plan = createCandidateBootstrapPlan({
    bootstrapPlanId: IDS.plan,
    sourceSnapshotDigest: digest('snapshot'),
    gatePlanDigest: digest('gate'),
    ecosystemRefs: ['node:test'],
    lockfileDigests: [],
    steps: [step],
    injectedEnvironmentNames: ['TOKEN'],
    networkPolicy: options.explicitNetwork === true
      ? 'explicit_once'
      : 'deny',
    allowedRegistryEndpointDigests: options.explicitNetwork === true
      ? [digest('registry-endpoint')]
      : [],
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
    createdAt: '2026-07-29T07:00:00.000Z',
    expiresAt: '2030-07-29T08:00:00.000Z',
    fencingTokenDigest: digest('fencing'),
  });
  const materializing = transitionWorktreeLease(created.lease, {
    toState: 'materializing',
    occurredAt: '2026-07-29T07:00:01.000Z',
  });
  const bootstrapping = transitionWorktreeLease(materializing.lease, {
    toState: 'bootstrapping',
    occurredAt: '2026-07-29T07:00:02.000Z',
    worktreeIdentity: digest('worktree'),
    materializedSourceDigest: digest('materialized'),
  }).lease;
  const authority = {
    lease: bootstrapping,
    binding: WorktreeLeaseBindingV1.create(
      bootstrapping,
      'test-raw-fencing-token',
    ),
  };
  const view: BootstrappingCandidateViewV1 = {
    candidateDirectory: candidate,
    candidateRelativeCwd: candidate,
    bootstrapPrivateDirectory: privateRoot,
    workspace: {
      workspaceDir: candidate,
      additionalDirs: [],
      accessMode: 'workspace-only',
    },
  };
  const executor = new CandidateBootstrapExecutor({
    worktreeLeaseStore: {
      withBootstrappingCandidate: async (_binding, callback) =>
        callback(view, []),
    },
  });
  return {
    parent,
    candidate,
    privateRoot,
    executable,
    argv,
    environment,
    budget,
    step,
    plan,
    lease: bootstrapping,
    authority,
    executor,
  };
}

function executionInput(
  value: Fixture,
  overrides: Partial<ExecuteCandidateBootstrapStepV1> = {},
): ExecuteCandidateBootstrapStepV1 {
  return {
    worktreeAuthority: value.authority,
    bootstrapPlan: value.plan,
    bootstrapBudget: value.budget,
    journalId: IDS.journal,
    step: value.step,
    trustedExecutable: value.executable,
    argv: value.argv,
    effectiveEnvironment: value.environment,
    privateInputsExpiresAt: '2030-07-29T07:30:00.000Z',
    reservationId: IDS.reservation,
    reserveBudgetEventId: IDS.reserveBudget,
    prepareJournalEventId: IDS.prepareJournal,
    startBudgetEventId: IDS.startBudget,
    startJournalEventId: IDS.startJournal,
    finishBudgetEventId: IDS.finishBudget,
    finishJournalEventId: IDS.finishJournal,
    reservedWallClockMs: 10_000,
    reservedGeneratedBytes: 500_000,
    reservedOutputBytes: 50_000,
    idempotencyKey: 'node_bootstrap_1',
    ...overrides,
  };
}

const describePosix = process.platform === 'win32'
  ? describe.skip
  : describe;

describePosix('CandidateBootstrapExecutor', () => {
  it('resolves approved candidate-relative cache paths only at spawn', async () => {
    const value = await fixture(
      'const fs=require("node:fs");'
      + 'fs.mkdirSync("node_modules",{recursive:true});'
      + 'fs.writeFileSync("node_modules/path.txt",process.env.GOPATH);',
      {
        environment: {
          CI: '1',
          TOKEN: 'candidate-path-test',
          GOPATH:
            `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-path`,
        },
      },
    );

    await expect(value.executor.executeStep(executionInput(value)))
      .resolves.toMatchObject({ status: 'observed' });
    expect(await readFile(
      join(value.candidate, 'node_modules', 'path.txt'),
      'utf8',
    )).toBe(join(
      await realpath(value.candidate),
      '.wukong-bootstrap',
      'go-path',
    ));
  });

  it('accepts an explicit-once audited registry plan without claiming network isolation', async () => {
    const value = await fixture(
      'process.stdout.write("explicit network plan\\n");',
      { explicitNetwork: true },
    );
    await expect(value.executor.executeStep(executionInput(value)))
      .resolves.toMatchObject({
        status: 'observed',
        exitCode: 0,
      });
  });

  it('executes exact private inputs and persists only digest evidence', async () => {
    const value = await fixture(`
      if (process.env.HOME || process.env.PATH) process.exit(10);
      if (process.env.TOKEN !== 'executor-private-secret') process.exit(11);
      const fs = require('node:fs');
      fs.mkdirSync('node_modules', { recursive: true });
      fs.writeFileSync('node_modules/generated.txt', 'generated\\n');
      process.stdout.write('ok\\n');
    `);
    const result = await value.executor.executeStep(executionInput(value));

    expect(result).toMatchObject({
      recovered: false,
      status: 'observed',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      outputLimitExceeded: false,
      protectedProjectionChanged: false,
    });
    expect(await readFile(
      join(value.candidate, 'node_modules/generated.txt'),
      'utf8',
    )).toBe('generated\n');
    const privateFiles = await Promise.all(
      (await readdir(value.privateRoot)).map(
        (name) => readFile(join(value.privateRoot, name), 'utf8')
          .catch(() => ''),
      ),
    );
    expect(privateFiles.join('\n'))
      .not.toContain('executor-private-secret');
  });

  it('keeps env/stdout/stderr credentials out of records, journals, and tombstones', async () => {
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const url =
      `https://alice:${secret}@example.test/v1?token=${secret}`;
    const value = await fixture(`
      process.stdout.write(${JSON.stringify(
        `Authorization: Bearer ${secret}\nTOKEN=${secret}\n${url}\n`,
      )});
      process.stderr.write(${JSON.stringify(
        `stderr TOKEN=${secret} ${url}\n`,
      )});
    `, {
      environment: { CI: '1', TOKEN: secret },
    });

    const result = await value.executor.executeStep(executionInput(value));
    const durableText = await readTreeText(value.privateRoot);

    expect(result).toMatchObject({
      status: 'observed',
      stdoutDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      stderrDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(durableText).not.toContain(secret);
    expect(durableText).not.toContain('alice');
    expect(durableText).not.toContain('Authorization: Bearer');
  });

  it('fails when bootstrap mutates source content outside generated scopes', async () => {
    const value = await fixture(`
      require('node:fs').writeFileSync('source.txt', 'mutated\\n');
    `);
    const result = await value.executor.executeStep(executionInput(value));

    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 0,
      protectedProjectionChanged: true,
    });
  });

  it('retains full reservation after output exceeds the durable limit', async () => {
    const value = await fixture(
      `process.stdout.write('x'.repeat(100000));`,
      { outputLimit: 1_000 },
    );
    const result = await value.executor.executeStep(executionInput(value, {
      reservedOutputBytes: 1_000,
    }));
    const state = await new CandidateBootstrapStateStore({
      rootDirectory: value.privateRoot,
    }).inspect(value.lease, value.plan);

    expect(result).toMatchObject({
      status: 'retained_unknown',
      outputLimitExceeded: true,
    });
    expect(result.outputBytes).toBeGreaterThan(1_000);
    expect(state).toMatchObject({
      journal: { state: 'step_running' },
      reservations: [{ state: 'retained_unknown' }],
    });
  });

  it('kills a timed-out process group and records a verified failure', async () => {
    const value = await fixture(
      `setTimeout(() => {}, 10000);`,
      { timeoutMs: 1_000 },
    );
    const result = await value.executor.executeStep(executionInput(value, {
      reservedWallClockMs: 5_000,
    }));

    expect(result).toMatchObject({
      status: 'failed',
      timedOut: true,
      protectedProjectionChanged: false,
    });
  });

  it('returns durable completion on retry without spawning the step again', async () => {
    const value = await fixture(`
      const fs = require('node:fs');
      fs.mkdirSync('node_modules', { recursive: true });
      const path = 'node_modules/count.txt';
      const count = fs.existsSync(path) ? Number(fs.readFileSync(path)) : 0;
      fs.writeFileSync(path, String(count + 1));
    `);
    const input = executionInput(value);
    const first = await value.executor.executeStep(input);
    const second = await value.executor.executeStep(input);

    expect(first).toMatchObject({ recovered: false, status: 'observed' });
    expect(second).toMatchObject({ recovered: true, status: 'observed' });
    expect(await readFile(
      join(value.candidate, 'node_modules/count.txt'),
      'utf8',
    )).toBe('1');
  });

  it('rejects completed-step recovery when generated scopes drift', async () => {
    const value = await fixture(`
      const fs = require('node:fs');
      fs.mkdirSync('node_modules', { recursive: true });
      fs.writeFileSync('node_modules/generated.txt', 'original');
    `);
    const input = executionInput(value);
    await value.executor.executeStep(input);
    await writeFile(
      join(value.candidate, 'node_modules/generated.txt'),
      'tampered',
    );

    await expect(value.executor.executeStep(input))
      .rejects.toMatchObject({
        reasonCode:
          'candidate_bootstrap_executor_integrity_failed',
      });
  });

  it('reconciles durable prepared state as unstarted without spawning', async () => {
    const value = await fixture(`
      require('node:fs').writeFileSync('source.txt', 'must-not-run\\n');
    `);
    const state = new CandidateBootstrapStateStore({
      rootDirectory: value.privateRoot,
    });
    await state.initialize({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      bootstrapBudget: value.budget,
      journalId: IDS.journal,
    });
    await state.prepareStep({
      worktreeLease: value.lease,
      bootstrapPlan: value.plan,
      step: value.step,
      reservationId: IDS.reservation,
      budgetEventId: IDS.reserveBudget,
      journalEventId: IDS.prepareJournal,
      reservedWallClockMs: 10_000,
      reservedGeneratedBytes: 500_000,
      reservedOutputBytes: 50_000,
      idempotencyKey: 'node_bootstrap_1',
    });

    const result = await value.executor.executeStep(executionInput(value));
    expect(result).toMatchObject({
      recovered: true,
      status: 'failed',
      exitCode: -1,
    });
    expect(await readFile(join(value.candidate, 'source.txt'), 'utf8'))
      .toBe('source\n');
    expect((await state.inspect(value.lease, value.plan))).toMatchObject({
      journal: { state: 'blocked' },
      reservations: [{ state: 'cancelled' }],
    });
  });
});

async function readTreeText(root: string): Promise<string> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(await readTreeText(path));
    } else if (entry.isFile()) {
      output.push(await readFile(path, 'utf8').catch(() => ''));
    }
  }
  return output.join('\n');
}
