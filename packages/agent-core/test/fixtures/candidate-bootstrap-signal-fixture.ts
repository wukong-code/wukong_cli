import {
  canonicalDigest,
  createBootstrapBudget,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  createWorktreeLease,
  digestCandidateBootstrapArgv,
  digestCandidateBootstrapEnvironment,
  transitionWorktreeLease,
} from '@wukong/verification';

export const SIGNAL_FIXTURE_IDS = {
  plan: '019f9000-0000-7abc-8def-0123456789ab',
  budget: '019f9000-0001-7abc-8def-0123456789ab',
  journal: '019f9000-0002-7abc-8def-0123456789ab',
  lease: '019f9000-0003-7abc-8def-0123456789ab',
  candidate: '019f9000-0004-7abc-8def-0123456789ab',
  blobLease: '019f9000-0005-7abc-8def-0123456789ab',
  reservation: '019f9000-0006-7abc-8def-0123456789ab',
  reserveBudget: '019f9000-0007-7abc-8def-0123456789ab',
  prepareJournal: '019f9000-0008-7abc-8def-0123456789ab',
  startBudget: '019f9000-0009-7abc-8def-0123456789ab',
  startJournal: '019f9000-0010-7abc-8def-0123456789ab',
  retainBudget: '019f9000-0011-7abc-8def-0123456789ab',
} as const;

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/bootstrap-hard-signal/v1',
    label,
  );
}

export function candidateBootstrapSignalFixture() {
  const argv = ['fixture'];
  const environment = { CI: '1', PATH: '' };
  const step = createCandidateBootstrapStep({
    stepId: 'signal_bootstrap',
    recipeRef: 'builtin:test:hard-signal',
    recipeVersion: '1',
    executableIdentity: digest('executable'),
    runtimeVersionDigest: digest('runtime'),
    exactArgvPrivateRef: 'private/bootstrap/argv/signal',
    argvDigest: digestCandidateBootstrapArgv(argv),
    effectiveEnvironmentPrivateRef:
      'private/bootstrap/environment/signal',
    effectiveEnvironmentDigest:
      digestCandidateBootstrapEnvironment(environment),
    candidateRelativeCwd: '.',
    generatedPathScopes: ['.wukong-bootstrap'],
    timeoutMs: 60_000,
  });
  const budget = createBootstrapBudget({
    budgetId: SIGNAL_FIXTURE_IDS.budget,
    bootstrapPlanId: SIGNAL_FIXTURE_IDS.plan,
    wallClockLimitMs: 60_000,
    generatedByteLimit: 1_000_000,
    processOutputByteLimit: 100_000,
    stepLimit: 1,
  });
  const plan = createCandidateBootstrapPlan({
    bootstrapPlanId: SIGNAL_FIXTURE_IDS.plan,
    sourceSnapshotDigest: digest('snapshot'),
    gatePlanDigest: digest('gate'),
    ecosystemRefs: ['test:signal'],
    lockfileDigests: [],
    steps: [step],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: budget.budgetDigest,
  });
  const created = createWorktreeLease({
    leaseId: SIGNAL_FIXTURE_IDS.lease,
    candidateId: SIGNAL_FIXTURE_IDS.candidate,
    goalId: 'goal_signal',
    contractId: 'contract_signal',
    runId: 'run_signal',
    ownerRunId: 'owner_signal',
    ownerProcessIdentityDigest: digest('process'),
    sourceSnapshotDigest: plan.sourceSnapshotDigest,
    snapshotBlobLeaseId: SIGNAL_FIXTURE_IDS.blobLease,
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
      `wukong/candidate/${SIGNAL_FIXTURE_IDS.candidate}`,
    createdByRunId: 'run_signal',
    createdAt: '2026-07-29T10:00:00.000Z',
    expiresAt: '2030-07-29T10:00:00.000Z',
    fencingTokenDigest: digest('fencing'),
  });
  const materializing = transitionWorktreeLease(created.lease, {
    toState: 'materializing',
    occurredAt: '2026-07-29T10:00:01.000Z',
  });
  const lease = transitionWorktreeLease(materializing.lease, {
    toState: 'bootstrapping',
    occurredAt: '2026-07-29T10:00:02.000Z',
    worktreeIdentity: digest('worktree'),
    materializedSourceDigest: digest('materialized'),
  }).lease;
  return {
    argv,
    environment,
    step,
    budget,
    plan,
    lease,
  };
}
