import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  canonicalDigest,
  clearBrokerReviewTrustBindingsForTests,
  createBrokerReviewTrustProposal,
  createReviewSubjectConsentProposal,
  createVerificationCriteriaSelection,
  discoverVerificationCriteriaCatalog,
  grantBrokerReviewTrust,
  revokeBrokerReviewTrustBinding,
} from '@wukong/verification';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { GoalMode, type LoopRunReviewSettingsInput } from '../../src/agent/goal';
import type { AgentRecord } from '../../src/agent/records';
import { ErrorCodes, WukongError } from '../../src/errors';
import { UpdateGoalTool } from '../../src/tools/builtin';
import {
  FRESH_REVIEWER_MAX_STEPS,
  FRESH_REVIEWER_TIMEOUT_MS,
} from '../../src/tools/builtin/goal/update-goal';
import { executeTool } from './fixtures/execute-tool';

const mocks = vi.hoisted(() => ({
  runVerification: vi.fn(),
  runScan: vi.fn(),
  runJudge: vi.fn(),
  runProof: vi.fn(),
  createWorkspaceSnapshot: vi.fn(),
  validateFrozenGatePlan: vi.fn(),
  buildReviewSubjectBroker: vi.fn(),
}));

vi.mock('@wukong/verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wukong/verification')>();
  return {
    ...actual,
    runVerification: mocks.runVerification,
    runScan: mocks.runScan,
    runJudge: mocks.runJudge,
    runProof: mocks.runProof,
    createWorkspaceSnapshot: mocks.createWorkspaceSnapshot,
    validateFrozenGatePlan: mocks.validateFrozenGatePlan,
    ReviewSubjectBroker: { build: mocks.buildReviewSubjectBroker },
  };
});

const signal = new AbortController().signal;
const CHECK_COMMAND = 'node -e "process.exit(0)"';

function ctx<Input>(args: Input, inputSignal: AbortSignal = signal) {
  return { turnId: '0', toolCallId: 'call_1', args, signal: inputSignal };
}

function makeStore(): {
  readonly goals: GoalMode;
  readonly records: AgentRecord[];
} {
  const records: AgentRecord[] = [];
  const agent = {
    type: 'main',
    records: { logRecord: (record: AgentRecord) => records.push(record) },
    emitEvent: () => {},
    telemetry: { track: () => {} },
    context: { appendSystemReminder: () => {} },
    config: {
      cwd: process.cwd(),
      modelAlias: 'writer-model',
    },
    permission: { mode: 'manual' },
  } as unknown as Agent;
  return { goals: new GoalMode(agent), records };
}

function makeAgent(
  store: GoalMode,
  options: {
    readonly reminders?: Array<{ readonly content: string; readonly origin: unknown }>;
    readonly spawn?: ReturnType<typeof vi.fn>;
    readonly providerName?: string;
    readonly providerEndpoint?: string;
    readonly withoutReviewer?: boolean;
    readonly cwd?: string;
  } = {},
): Agent {
  const reminders = options.reminders ?? [];
  const spawn = options.spawn ?? vi.fn(async (input: { readonly prompt: string }) => ({
    completion: Promise.resolve({ result: freshVerdictFromPrompt(input.prompt, 'PASS') }),
  }));
  const providerName = options.providerName ?? 'anthropic';
  const providerEndpoint = options.providerEndpoint ?? 'https://api.anthropic.com';
  return {
    type: 'main',
    goal: store,
    config: { cwd: options.cwd ?? process.cwd(), modelAlias: 'writer-model' },
    records: { logRecord: () => {} },
    emitEvent: () => {},
    telemetry: { track: () => {} },
    context: {
      appendSystemReminder: (content: string, origin: unknown) => {
        reminders.push({ content, origin });
      },
    },
    modelProvider: {
      resolveProviderConfig: () => ({
        type: 'anthropic',
        providerName,
        provider: { baseUrl: providerEndpoint },
      }),
    },
    subagentHost: options.withoutReviewer ? undefined : { spawn },
  } as unknown as Agent;
}

async function createBrokeredV3Goal(goals: GoalMode, cwd: string): Promise<{
  readonly skillMd: string;
}> {
  const skillDir = join(cwd, '.wukong', 'skills', 'review-api');
  const skillMd = join(skillDir, 'SKILL.md');
  await mkdir(join(skillDir, 'verification'), { recursive: true });
  await writeFile(skillMd, [
    '---',
    'name: review-api',
    'description: Review API compatibility.',
    'metadata:',
    '  wukong.verification.criteria: verification/criteria.v1.json',
    '---',
    'Review the selected API behavior.',
  ].join('\n'));
  await writeFile(
    join(skillDir, 'verification', 'criteria.v1.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'wukong.verification-criteria',
      id: 'review-api',
      description: 'Review API compatibility.',
      scope: { kind: 'project', paths: ['src/api/**'] },
      criteria: [{
        id: 'typed-failures',
        text: 'API failures remain explicit and typed.',
        evidence: 'Cite the handler and deterministic evidence.',
      }],
    }),
  );
  const finishLine = await buildFinishLine({
    cwd,
    objective: 'Keep API failures typed',
    completionCriterion: 'The API criterion and frozen Gate pass',
    includeDiscoveredChecks: false,
  });
  if (!finishLine.ok) throw new Error(finishLine.failure.message);
  const catalog = await discoverVerificationCriteriaCatalog({
    workspaceRoot: cwd,
    roots: [{
      kind: 'project',
      root: join(cwd, '.wukong', 'skills'),
      workspaceIdentityDigest:
        finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
    }],
  });
  const entry = catalog.entries[0];
  if (entry === undefined) throw new Error('V3 catalog fixture missing');
  const selection = createVerificationCriteriaSelection(catalog, [{
    selectionId: entry.selectionId,
    provenanceDigest: entry.ref.provenanceDigest,
  }], catalog.catalogDigest);
  await goals.createGoal({
    objective: finishLine.proposal.objective,
    completionCriterion: finishLine.proposal.completionCriterion,
    stopCondition: 'proof-pass',
    loopContract: {
      schemaVersion: 3,
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      constraints: finishLine.proposal.constraints,
      finishLineReview: {
        ...finishLine.proposal.finishLineReview,
        acknowledgedWarningIds: finishLine.proposal.finishLineReview.warnings.map(
          (warning) => warning.id,
        ),
      },
      workspaceIdentity: finishLine.proposal.workspaceIdentity,
      workspaceTrust: {
        schemaVersion: 2,
        workspaceIdentityDigest:
          finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
        reviewSubjectPolicyVersion: 'review-subject/1',
        hasExecutableChecks: false,
        scopes: ['brokered-review-subject'],
      },
      gateApproval: finishLine.proposal.gateApproval,
      legacyGatePlan: finishLine.proposal.gatePlan,
      reviewPolicy: finishLine.proposal.reviewPolicy,
      verificationCriteria: selection,
      selectedRecipes: [{
        recipe: entry.recipe,
        provenanceDigest: entry.ref.provenanceDigest,
      }],
      reviewSettings: makeReviewSettings(
        finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
      ),
      source: 'user',
    },
  });
  return { skillMd };
}

function makeReviewSettings(
  workspaceIdentityDigest: string,
  providerId = 'anthropic',
  endpoint = 'https://api.anthropic.com',
): LoopRunReviewSettingsInput {
  const trustProposal = createBrokerReviewTrustProposal({
    workspaceIdentityDigest,
    intent: 'once',
  });
  const consentProposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest,
    allowedOrigins: ['changed-tracked', 'gate-evidence'],
    providerId,
    endpoint,
  });
  return {
    brokerReviewTrust: grantBrokerReviewTrust(
      trustProposal,
      trustProposal.trustProposalDigest,
      'gate-test-trust',
    ),
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
      1_000,
    ),
  };
}

async function createBrokeredGoal(
  store: GoalMode,
  input: {
    readonly objective?: string;
    readonly reviewModel?: string;
    readonly maxIterations?: number;
    readonly minIntervalMs?: number;
    readonly providerId?: string;
    readonly endpoint?: string;
  } = {},
) {
  const objective = input.objective ?? 'ship the change';
  const finishLine = await buildFinishLine({
    cwd: process.cwd(),
    objective,
    completionCriterion: 'The frozen check and every acceptance criterion pass.',
    explicitChecks: [CHECK_COMMAND],
    includeDiscoveredChecks: false,
  });
  if (!finishLine.ok) throw new Error(JSON.stringify(finishLine.failure));
  return store.createGoal({
    objective,
    completionCriterion: finishLine.proposal.completionCriterion,
    stopCondition: 'proof-pass',
    reviewModel: input.reviewModel,
    maxIterations: input.maxIterations,
    minIntervalMs: input.minIntervalMs,
    loopContract: {
      schemaVersion: 2,
      objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      constraints: finishLine.proposal.constraints,
      finishLineReview: {
        ...finishLine.proposal.finishLineReview,
        acknowledgedWarningIds: finishLine.proposal.finishLineReview.warnings.map(
          (warning) => warning.id,
        ),
      },
      workspaceIdentity: finishLine.proposal.workspaceIdentity,
      workspaceTrust: finishLine.proposal.workspaceTrust,
      gateApproval: finishLine.proposal.gateApproval,
      gatePlan: finishLine.proposal.gatePlan,
      reviewPolicy: finishLine.proposal.reviewPolicy,
      reviewSettings: makeReviewSettings(
        finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
        input.providerId,
        input.endpoint,
      ),
      source: 'user',
    },
  });
}

function proof(status: 'passed' | 'blocked') {
  return {
    status,
    recommendation: status === 'passed' ? 'Ready.' : 'Fix the failed delivery gate.',
    reasonCode: status === 'passed' ? 'passed' : 'check_failed',
    snapshotId: 'snapshot-id',
    workspaceFingerprint: {
      headSha: undefined,
      inputDigest: 'input',
      configDigest: 'config',
    },
    blockers: status === 'passed'
      ? []
      : [{
          id: 'check_failed',
          kind: 'check',
          summary: 'The frozen check failed.',
          command: CHECK_COMMAND,
          nextAction: 'Fix the failure and rerun the Loop Gate.',
        }],
    verification: {
      selectedCommands: [],
      commandResults: [{
        command: CHECK_COMMAND,
        status: status === 'passed' ? 'passed' : 'failed',
        exitCode: status === 'passed' ? 0 : 1,
        durationMs: 10,
        stdout: status === 'passed' ? 'verified' : '',
        stderr: status === 'passed' ? '' : 'failed',
      }],
      changedFiles: [],
      risks: [],
    },
    scan: { status: 'passed', risks: [] },
  };
}

function freshVerdictFromPrompt(
  prompt: string,
  status: 'PASS' | 'NEEDS_WORK' | 'INCONCLUSIVE',
): string {
  const attemptId = lineValue(prompt, 'Attempt: ');
  const reviewerInputDigest = lineValue(prompt, 'Reviewer input digest: ');
  const criteria = JSON.parse(lineValue(prompt, 'Frozen criteria: ')) as Array<{
    readonly criterionId: string;
    readonly criterionProvenanceDigest: string;
  }>;
  const priorBlockerKeys = JSON.parse(lineValue(prompt, 'Prior blocker keys: ')) as string[];
  const manifest = JSON.parse(lineValue(prompt, 'Review Subject manifest: ')) as {
    readonly gateEvidence: readonly {
      readonly producerId: string;
      readonly evidenceId: string;
      readonly brokeredEvidenceDigest: string;
    }[];
  };
  const gateEvidence = manifest.gateEvidence[0];
  const evidence = gateEvidence === undefined
    ? []
    : [{
        kind: 'gate-evidence' as const,
        producerId: gateEvidence.producerId,
        evidenceId: gateEvidence.evidenceId,
        evidenceDigest: gateEvidence.brokeredEvidenceDigest,
      }];
  const firstCriterion = criteria[0];
  const finding = status === 'NEEDS_WORK' && firstCriterion !== undefined
    ? [{
        id: 'criterion-not-satisfied',
        origin: 'criterion',
        criterionId: firstCriterion.criterionId,
        criterionProvenanceDigest: firstCriterion.criterionProvenanceDigest,
        severity: 'blocking',
        message: 'The criterion is not yet satisfied.',
        nextAction: 'Fix the criterion.',
        evidence,
      }]
    : [];
  const verdict = {
    schemaVersion: 1,
    attemptId,
    reviewerInputDigest,
    status,
    criterionDispositions: criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      criterionProvenanceDigest: criterion.criterionProvenanceDigest,
      status: status === 'PASS'
        ? 'satisfied'
        : status === 'NEEDS_WORK'
          ? 'unsatisfied'
          : 'unverified',
      evidence: status === 'INCONCLUSIVE' ? [] : evidence,
    })),
    priorBlockerDispositions: priorBlockerKeys.map((blockerKey) => ({
      blockerKey,
      status: status === 'PASS' ? 'resolved' : 'still-open',
      evidence: status === 'INCONCLUSIVE' ? [] : evidence,
    })),
    findings: finding,
  };
  return `FRESH_VERDICT_JSON: ${JSON.stringify(verdict)}`;
}

function lineValue(prompt: string, prefix: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`Prompt line missing: ${prefix}`);
  return line.slice(prefix.length);
}

describe('UpdateGoalTool 0.0.20 verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBrokerReviewTrustBindingsForTests();
    mocks.validateFrozenGatePlan.mockResolvedValue({ ok: true });
    mocks.createWorkspaceSnapshot.mockResolvedValue({
      id: 'snapshot-id',
      cwd: process.cwd(),
      headSha: undefined,
      inputDigest: 'input',
      configDigest: 'config',
      planDigest: 'plan',
      git: {
        cwd: process.cwd(),
        isRepo: true,
        statusText: '',
        diffText: '',
        diffStat: '',
        changedFiles: [],
      },
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    mocks.buildReviewSubjectBroker.mockImplementation(async (input: {
      readonly attemptId: string;
      readonly runId: string;
      readonly contractId: string;
      readonly planDigest: string;
      readonly workspaceFingerprint: string;
      readonly consent: {
        readonly consentDigest: string;
        readonly reviewSubjectPolicyVersion: string;
      };
    }) => {
      const gateEvidence = {
        producerId: 'project-checks',
        evidenceId: 'stdout',
        brokeredEvidenceDigest: canonicalDigest(
          'wukong/brokered-gate-evidence/v1',
          'verified',
        ),
        byteLength: 8,
        mediaType: 'text/plain' as const,
        redactionVersion: 'review-subject-redaction/1',
        secretScanVersion: 'review-subject-secret-scan/1',
      };
      const core = {
        schemaVersion: 1 as const,
        attemptId: input.attemptId,
        runId: input.runId,
        contractId: input.contractId,
        planDigest: input.planDigest,
        consentDigest: input.consent.consentDigest,
        workspaceFingerprint: input.workspaceFingerprint,
        policyVersion: input.consent.reviewSubjectPolicyVersion,
        entries: [],
        exclusions: [],
        gateEvidence: [gateEvidence],
        gateEvidenceExclusions: [],
      };
      return {
        manifest: {
          ...core,
          manifestDigest: canonicalDigest('wukong/review-subject-manifest/v1', core),
        },
        assertFresh: vi.fn(async () => {}),
        destroy: vi.fn(),
        readReviewSubject: vi.fn(),
        searchReviewSubjects: vi.fn(() => []),
        readGateEvidence: vi.fn(() => 'verified'),
      };
    });
  });

  it('blocks a legacy V1 Loop before checks or reviewer calls', async () => {
    const { goals, records } = makeStore();
    await goals.createGoal({ objective: 'legacy work', stopCondition: 'verify-pass' });
    const spawn = vi.fn();

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'legacy_contract_upgrade_required' },
    });
    expect(mocks.runProof).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(records.some((record) => record.type === 'loop.gate-attempt.create')).toBe(false);
  });

  it('completes a non-Loop goal without a delivery gate', async () => {
    const { goals } = makeStore();
    await goals.createGoal({ objective: 'ordinary work' });

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toBeNull();
    expect(mocks.runProof).not.toHaveBeenCalled();
  });

  it('runs one isolated fresh reviewer and completes a brokered V2 Loop', async () => {
    const { goals, records } = makeStore();
    await createBrokeredGoal(goals);
    const spawn = vi.fn(async (input: { readonly prompt: string }) => ({
      completion: Promise.resolve({ result: freshVerdictFromPrompt(input.prompt, 'PASS') }),
    }));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toBeNull();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'fresh-reviewer',
      isolated: true,
      modelAlias: 'writer-model',
      maxSteps: FRESH_REVIEWER_MAX_STEPS,
      internalTools: expect.arrayContaining([
        expect.objectContaining({ name: 'ReadReviewSubject' }),
        expect.objectContaining({ name: 'SearchReviewSubjects' }),
        expect.objectContaining({ name: 'ReadGateEvidence' }),
      ]),
    }));
    const durableOrder = records
      .map((record) => record.type)
      .filter((type) => type.startsWith('loop.'));
    expect(durableOrder).toEqual([
      'loop.run.create',
      'loop.gate-attempt.create',
      'loop.gate-check-result.create',
      'loop.builtin-risk-scan-result.create',
      'loop.review-subject-manifest.create',
      'loop.fresh-criteria-verdict.create',
      'loop.proof-aggregate.create',
      'loop.evidence-snapshot.create',
      'loop.gate-attempt.complete',
      'loop.run.terminal',
    ]);
  });

  it('still invokes exactly one reviewer when deterministic proof fails', async () => {
    const { goals } = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await createBrokeredGoal(goals);
    mocks.runProof.mockResolvedValue(proof('blocked'));
    const spawn = vi.fn(async (input: { readonly prompt: string }) => ({
      completion: Promise.resolve({ result: freshVerdictFromPrompt(input.prompt, 'PASS') }),
    }));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn, reminders })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(false);
    expect(spawn).toHaveBeenCalledOnce();
    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      loopResult: { status: 'NEEDS_WORK', reasonCode: 'check_failed' },
    });
    expect(reminders.at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_gate_failed',
    });
  });

  it('records bounded input but no verdict/completion for invalid reviewer output', async () => {
    const { goals, records } = makeStore();
    await createBrokeredGoal(goals);
    const spawn = vi.fn(async () => ({
      completion: Promise.resolve({ result: 'not a structured verdict' }),
    }));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { status: 'ERROR', reasonCode: 'reviewer_invalid_output' },
    });
    expect(records.some((record) => record.type === 'loop.review-subject-manifest.create')).toBe(true);
    expect(records.some((record) => record.type === 'loop.fresh-criteria-verdict.create')).toBe(false);
    expect(records.some((record) => record.type === 'loop.gate-attempt.complete')).toBe(false);
  });

  it('fails provider-consent preflight before attempt/check/provider work', async () => {
    const { goals, records } = makeStore();
    await createBrokeredGoal(goals);
    const spawn = vi.fn();

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, {
        spawn,
        providerName: 'openai',
        providerEndpoint: 'https://api.openai.com/v1',
      })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'review_subject_consent_required' },
    });
    expect(mocks.runProof).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(records.some((record) => record.type === 'loop.gate-attempt.create')).toBe(false);
  });

  it('fails a revoked broker grant before attempt/check/provider work', async () => {
    const { goals, records } = makeStore();
    await createBrokeredGoal(goals);
    const binding = goals.createLoopGateReviewRuntime()?.runSettings.brokerReviewTrust;
    if (binding === undefined) throw new Error('broker trust fixture missing');
    revokeBrokerReviewTrustBinding(binding.trustGrantId);
    const spawn = vi.fn();

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'review_subject_trust_required' },
    });
    expect(mocks.runProof).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(records.some((record) => record.type === 'loop.gate-attempt.create')).toBe(false);
  });

  it('fails selected Skill provenance drift before attempt/check/provider work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-v3-gate-drift-'));
    try {
      const { goals, records } = makeStore();
      const { skillMd } = await createBrokeredV3Goal(goals, cwd);
      await writeFile(skillMd, [
        '---',
        'name: review-api',
        'description: Review API compatibility.',
        'metadata:',
        '  wukong.verification.criteria: verification/criteria.v1.json',
        '---',
        'Changed after the V3 contract was frozen.',
      ].join('\n'));
      const spawn = vi.fn();

      await executeTool(
        new UpdateGoalTool(makeAgent(goals, { cwd, spawn })),
        ctx({ status: 'complete' }),
      );

      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        loopResult: { reasonCode: 'verification_criteria_changed' },
      });
      expect(mocks.runProof).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(records.some((record) => record.type === 'loop.gate-attempt.create'))
        .toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('adds unchanged files matched by the selected recipe scope to the broker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-v3-gate-scope-'));
    try {
      const { goals, records } = makeStore();
      await createBrokeredV3Goal(goals, cwd);
      await mkdir(join(cwd, 'src', 'api'), { recursive: true });
      await writeFile(
        join(cwd, 'src', 'api', 'users.ts'),
        'export const users = [];',
      );

      await executeTool(
        new UpdateGoalTool(makeAgent(goals, { cwd })),
        ctx({ status: 'complete' }),
      );

      expect(mocks.buildReviewSubjectBroker).toHaveBeenCalledWith(
        expect.objectContaining({
          candidates: expect.arrayContaining([{
            logicalPath: 'src/api/users.ts',
            origin: 'scope-match',
          }]),
        }),
      );
      expect(records.find((record) => record.type === 'loop.run.terminal'))
        .toMatchObject({ terminal: { status: 'PASS' } });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails reviewer availability preflight without creating an attempt', async () => {
    const { goals, records } = makeStore();
    await createBrokeredGoal(goals);

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { withoutReviewer: true })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'reviewer_unavailable' },
    });
    expect(mocks.runProof).not.toHaveBeenCalled();
    expect(records.some((record) => record.type === 'loop.gate-attempt.create')).toBe(false);
  });

  it('uses the frozen Loop reviewer model and never retries with the writer model', async () => {
    const { goals } = makeStore();
    await createBrokeredGoal(goals, { reviewModel: 'reviewer-model' });
    const spawn = vi.fn(async () => {
      throw new Error('provider unavailable');
    });

    await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'fresh-reviewer',
      modelAlias: 'reviewer-model',
    }));
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'reviewer_unavailable' },
    });
  });

  it('invalidates a reviewer verdict when broker trust is revoked mid-attempt', async () => {
    const { goals, records } = makeStore();
    await createBrokeredGoal(goals);
    const binding = goals.createLoopGateReviewRuntime()?.runSettings.brokerReviewTrust;
    if (binding === undefined) throw new Error('broker trust fixture missing');
    const spawn = vi.fn(async (input: { readonly prompt: string }) => {
      revokeBrokerReviewTrustBinding(binding.trustGrantId);
      return {
        completion: Promise.resolve({
          result: freshVerdictFromPrompt(input.prompt, 'PASS'),
        }),
      };
    });

    await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(spawn).toHaveBeenCalledOnce();
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'reviewer_evidence_stale' },
    });
    expect(records.some((record) => record.type === 'loop.gate-attempt.create')).toBe(true);
    expect(records.find((record) => record.type === 'loop.gate-attempt.complete'))
      .toMatchObject({
        attempt: {
          status: 'ERROR',
          reasonCode: 'reviewer_evidence_stale',
        },
      });
  });

  it('stops after the dedicated fresh-reviewer step limit without retrying', async () => {
    const { goals } = makeStore();
    await createBrokeredGoal(goals);
    const spawn = vi.fn(async () => ({
      completion: Promise.reject(new WukongError(
        ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
        'step limit',
      )),
    }));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { reasonCode: 'reviewer_limit_exceeded' },
    });
  });

  it('stops after the shared reviewer timeout without retrying', async () => {
    vi.useFakeTimers();
    try {
      const { goals } = makeStore();
      await createBrokeredGoal(goals);
      const spawn = vi.fn(async (input: { readonly signal: AbortSignal }) => ({
        completion: new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => {
            reject(input.signal.reason);
          }, { once: true });
        }),
      }));
      const running = executeTool(
        new UpdateGoalTool(makeAgent(goals, { spawn })),
        ctx({ status: 'complete' }),
      );
      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(FRESH_REVIEWER_TIMEOUT_MS);

      const result = await running;
      expect(result.stopTurn).toBe(true);
      expect(spawn).toHaveBeenCalledOnce();
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        loopResult: { reasonCode: 'reviewer_limit_exceeded' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates cancellation into deterministic proof checks', async () => {
    const { goals } = makeStore();
    await createBrokeredGoal(goals);
    const controller = new AbortController();
    mocks.runProof.mockImplementationOnce(async (input: { readonly signal: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          reject(input.signal.reason);
        }, { once: true });
      })
    ));
    const spawn = vi.fn();
    const running = executeTool(
      new UpdateGoalTool(makeAgent(goals, { spawn })),
      ctx({ status: 'complete' }, controller.signal),
    );
    await vi.waitFor(() => {
      expect(mocks.runProof).toHaveBeenCalledOnce();
    });
    controller.abort(new DOMException('Aborted', 'AbortError'));

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks at max iterations after a brokered NEEDS_WORK attempt', async () => {
    const { goals } = makeStore();
    await createBrokeredGoal(goals, { maxIterations: 1 });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      iteration: 1,
      loopResult: { reasonCode: 'max_iterations' },
    });
  });

  it('leaves configured interval pacing to the Goal driver', async () => {
    const { goals } = makeStore();
    await createBrokeredGoal(goals, { minIntervalMs: 1_000 });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(goals)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('configured interval');
    expect(goals.getGoal().goal).toMatchObject({ status: 'active', minIntervalMs: 60_000 });
  });
});
