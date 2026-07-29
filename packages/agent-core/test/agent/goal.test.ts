import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgePromotionConsent,
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  canonicalDigest,
  createBrokerReviewTrustProposal,
  createFreshReviewerInputDigest,
  createIsolatedLoopCandidateBinding,
  createPromotionConsentProposal,
  createReviewSubjectConsentProposal,
  createTargetStateFingerprint,
  grantBrokerReviewTrust,
  ReviewSubjectBroker,
} from '@wukong/verification';

import type { Agent } from '../../src/agent';
import {
  GoalMode,
  type GoalChange,
  type LoopRunReviewSettingsInput,
  type GoalSnapshot,
} from '../../src/agent/goal';
import type { AgentRecord } from '../../src/agent/records';
import type { AgentReplayRecord } from '../../src/rpc/resumed';
import { ErrorCodes } from '../../src/errors';
import {
  acceptanceContractDigest,
  criteriaSelectionDigest,
} from '../../src/target-final-gate-audit-bridge';
import {
  TargetFinalGateAttemptStore,
} from '../../src/target-final-gate-attempt-store';
import {
  TargetPromotionLeaseStore,
} from '../../src/target-promotion-lease-store';
import type { TelemetryProperties } from '../../src/telemetry';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

interface TelemetryRecord {
  readonly event: string;
  readonly properties: TelemetryProperties;
}

function makeGoalMode() {
  const records: AgentRecord[] = [];
  const replay: AgentReplayRecord[] = [];
  const events: Array<{ readonly type: string; readonly snapshot?: GoalSnapshot | null; readonly change?: GoalChange }> = [];
  const telemetry: TelemetryRecord[] = [];
  const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
  const agent = {
    records: {
      logRecord: (record: AgentRecord) => {
        records.push(record);
      },
    },
    emitEvent: (event: { readonly type: string; readonly snapshot?: GoalSnapshot | null; readonly change?: GoalChange }) => {
      events.push(event);
    },
    telemetry: {
      track: (event: string, properties: TelemetryProperties) => {
        telemetry.push({ event, properties });
      },
    },
    context: {
      appendSystemReminder: (content: string, origin: unknown) => {
        reminders.push({ content, origin });
      },
    },
    replayBuilder: {
      push: (record: AgentReplayRecord) => {
        replay.push(record);
      },
    },
    config: {
      cwd: process.cwd(),
      modelAlias: 'writer-model',
    },
    permission: {
      mode: 'manual',
    },
  } as unknown as Agent;

  return {
    goals: new GoalMode(agent),
    records,
    replay,
    events,
    telemetry,
    reminders,
  };
}

function replayGoalRecord(goals: GoalMode, record: AgentRecord): void {
  // This test helper intentionally ignores records outside the durable Loop proof chain.
  // oxlint-disable-next-line typescript-eslint/switch-exhaustiveness-check
  switch (record.type) {
    case 'goal.create':
      goals.restoreCreate(record);
      break;
    case 'goal.contract.create':
      goals.restoreContractCreate(record);
      break;
    case 'loop.run.create':
      goals.restoreLoopRunCreate(record);
      break;
    case 'loop.run-review-settings.assign':
      goals.restoreLoopRunReviewSettingsAssignment(record);
      break;
    case 'loop.isolated-candidate.bind':
      goals.restoreIsolatedLoopCandidateBinding(record);
      break;
    case 'loop.isolated-candidate.iteration':
      goals.restoreIsolatedLoopCandidateIteration(record);
      break;
    case 'loop.gate-attempt.create':
    case 'loop.gate-check-result.create':
    case 'loop.builtin-risk-scan-result.create':
    case 'loop.reviewer-result.create':
    case 'loop.review-subject-manifest.create':
    case 'loop.fresh-criteria-verdict.create':
    case 'loop.proof-aggregate.create':
    case 'loop.evidence-snapshot.create':
    case 'loop.continuation.create':
      goals.restoreLoopAuditRecord(record);
      break;
    case 'loop.gate-attempt.complete':
      goals.restoreGateAttemptComplete(record);
      break;
    case 'loop.run.terminal':
      goals.restoreLoopRunTerminal(record);
      break;
    default:
      break;
  }
}

function makeReviewSettings(
  workspaceIdentityDigest: string,
  acknowledgedAt = 1_000,
): LoopRunReviewSettingsInput {
  const trustProposal = createBrokerReviewTrustProposal({
    workspaceIdentityDigest,
    intent: 'once',
  });
  const consentProposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest,
    allowedOrigins: ['changed-tracked', 'gate-evidence'],
    providerId: 'anthropic',
    endpoint: 'https://api.anthropic.com',
  });
  return {
    brokerReviewTrust: grantBrokerReviewTrust(
      trustProposal,
      trustProposal.trustProposalDigest,
      'test-broker-trust-grant',
    ),
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
      acknowledgedAt,
    ),
  };
}

async function recordBrokeredGate(
  goals: GoalMode,
  input: {
    readonly workspaceFingerprint: string;
    readonly checkStatus?: 'passed' | 'failed';
    readonly status: 'PASS' | 'NEEDS_WORK';
    readonly reasonCode: string;
    readonly findingDiagnostics?: {
      readonly message: string;
      readonly nextAction: string;
    };
  },
) {
  const runtime = goals.createLoopGateReviewRuntime();
  if (runtime === null) throw new Error('brokered runtime missing');
  goals.beginLoopGateAttempt(runtime, input.workspaceFingerprint);
  const deterministicEvidence = goals.recordGateDeterministicEvidence({
    runtime,
    workspaceFingerprint: input.workspaceFingerprint,
    checks: input.checkStatus === undefined
      ? []
      : [{
          command: 'node -e "process.exit(0)"',
          status: input.checkStatus,
          exitCode: input.checkStatus === 'passed' ? 0 : 1,
          stdout: '',
          stderr: input.checkStatus === 'passed' ? '' : 'flaky',
        }],
    scanFindings: [],
  });
  const broker = await ReviewSubjectBroker.build({
    workspaceRoot: process.cwd(),
    attemptId: runtime.attemptId,
    runId: runtime.runId,
    contractId: runtime.contractId,
    planDigest: runtime.planDigest,
    workspaceFingerprint: input.workspaceFingerprint,
    consent: runtime.runSettings.reviewSubjectConsent,
    candidates: [],
    gateEvidence: [{
      producerId: 'test-gate',
      evidenceId: 'result',
      content: 'The frozen acceptance criteria were verified by the test fixture.',
      mediaType: 'text/plain',
    }],
  });
  const gateEvidence = broker.manifest.gateEvidence[0];
  if (gateEvidence === undefined) throw new Error('gate evidence missing');
  const evidence = [{
    kind: 'gate-evidence' as const,
    producerId: gateEvidence.producerId,
    evidenceId: gateEvidence.evidenceId,
    evidenceDigest: gateEvidence.brokeredEvidenceDigest,
  }];
  const reviewerInputDigest = createFreshReviewerInputDigest({
    attemptId: runtime.attemptId,
    contractId: runtime.contractId,
    planDigest: runtime.planDigest,
    selectionDigest: runtime.selectionDigest,
    subjectManifestDigest: broker.manifest.manifestDigest,
    orderedCheckResultDigests: deterministicEvidence.orderedCheckResultDigests,
    priorBlockerSetDigest: canonicalDigest(
      'wukong/carried-blocker-set/v1',
      runtime.carriedBlockerKeys,
    ),
    reviewPolicyDigest: canonicalDigest(
      'wukong/fresh-review-policy-binding/v1',
      runtime.reviewPolicy,
    ),
    consentDigest: runtime.runSettings.reviewSubjectConsent.consentDigest,
  });
  const verdict = {
    schemaVersion: 1 as const,
    attemptId: runtime.attemptId,
    reviewerInputDigest,
    status: 'PASS' as const,
    criterionDispositions: runtime.criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      criterionProvenanceDigest: criterion.criterionProvenanceDigest,
      status: 'satisfied' as const,
      evidence,
    })),
    priorBlockerDispositions: runtime.carriedBlockerKeys.map((blockerKey) => ({
      blockerKey,
      status: 'resolved' as const,
      evidence,
    })),
    findings: input.findingDiagnostics === undefined
      ? []
      : [{
          id: 'diagnostic-finding',
          origin: 'independent' as const,
          severity: 'important' as const,
          message: input.findingDiagnostics.message,
          nextAction: input.findingDiagnostics.nextAction,
          evidence,
        }],
  };
  try {
    return goals.recordGateAttempt({
      runtime,
      deterministicEvidence,
      status: input.status,
      reasonCode: input.reasonCode,
      reviewSubjectManifest: broker.manifest,
      freshCriteriaVerdict: verdict,
      reviewerInputDigest,
      blockerKeys: [],
    });
  } finally {
    broker.destroy();
  }
}

describe('GoalMode creation', () => {
  it('creates a goal and exposes it through getGoal', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({ objective: 'Ship feature X' });

    expect(snapshot.objective).toBe('Ship feature X');
    expect(snapshot.status).toBe('active');
    expect(goals.getGoal().goal?.goalId).toBe(snapshot.goalId);
  });

  it('stores a completion criterion when provided', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({
      objective: 'Ship feature X',
      completionCriterion: ' tests pass ',
    });

    expect(snapshot.completionCriterion).toBe('tests pass');
    expect(goals.getGoal().goal?.completionCriterion).toBe('tests pass');
  });

  it('sets no default work caps when none is provided', async () => {
    const { goals } = makeGoalMode();

    const snapshot = await goals.createGoal({ objective: 'Do work' });

    expect(snapshot.budget.turnBudget).toBeNull();
    expect(snapshot.budget.tokenBudget).toBeNull();
    expect(snapshot.budget.wallClockBudgetMs).toBeNull();
    expect(snapshot.budget.overBudget).toBe(false);
  });

  it('rejects empty and too-long objectives', async () => {
    const { goals } = makeGoalMode();

    await expect(goals.createGoal({ objective: '   ' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
    await expect(goals.createGoal({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('rejects duplicate active, paused, and blocked goals without replace', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'first' });
    await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
    await goals.pauseGoal();
    await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
    await goals.resumeGoal();
    await goals.markBlocked({ reason: 'stuck' });
    await expect(goals.createGoal({ objective: 'second' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_ALREADY_EXISTS,
    });
  });

  it('replaces an existing goal when replace is set', async () => {
    const { goals, records } = makeGoalMode();

    const first = await goals.createGoal({ objective: 'first' });
    const second = await goals.createGoal({ objective: 'second', replace: true });

    expect(second.goalId).not.toBe(first.goalId);
    expect(goals.getGoal().goal?.objective).toBe('second');
    expect(records.map((record) => record.type)).toEqual(['goal.create', 'goal.clear', 'goal.create']);
  });
});

describe('GoalMode lifecycle', () => {
  it('persists one exact isolated candidate binding per Loop run', async () => {
    const { goals, records } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Persist the isolated candidate',
      completionCriterion: 'The candidate survives replay',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    const created = await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
        objective: finishLine.proposal.objective,
        completionCriterion: finishLine.proposal.completionCriterion,
        constraints: finishLine.proposal.constraints,
        finishLineReview: {
          ...finishLine.proposal.finishLineReview,
          acknowledgedWarningIds:
            finishLine.proposal.finishLineReview.warnings.map(
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
        ),
        source: 'user',
      },
    });
    expect(created.loopContract?.schemaVersion).toBe(2);
    if (created.loopContract?.schemaVersion !== 2
      || created.loopRunId === undefined) return;
    expect(goals.createIsolatedLoopCandidateRuntimeContext())
      .toMatchObject({
        schemaVersion: 1,
        goalId: created.goalId,
        contractId: created.loopContract.contractId,
        runId: created.loopRunId,
        ownerRunId: created.loopRunId,
        objective: finishLine.proposal.objective,
        gatePlanDigest: created.loopContract.gatePlan.planDigest,
        criteriaSelectionDigest: null,
        gateContract: {
          gatePlan: created.loopContract.gatePlan,
        },
      });
    const bindingInput = {
      goalId: created.goalId,
      contractId: created.loopContract.contractId,
      runId: created.loopRunId,
      ownerRunId: '10000000-0000-4000-8000-000000000001',
      candidateId: '20000000-0000-4000-8000-000000000002',
      worktreeLeaseId: '30000000-0000-4000-8000-000000000003',
      sourceSnapshotDigest: canonicalDigest(
        'wukong/test/source-snapshot/v1',
        'source',
      ),
      bootstrapPlanDigest: canonicalDigest(
        'wukong/test/bootstrap-plan/v1',
        'bootstrap',
      ),
      gatePlanDigest: created.loopContract.gatePlan.planDigest,
      criteriaSelectionDigest: null,
      reservedLeaseDigest: canonicalDigest(
        'wukong/test/reserved-lease/v1',
        'lease',
      ),
      createdAt: '2026-07-29T08:00:00.000Z',
    } as const;
    const binding = createIsolatedLoopCandidateBinding(bindingInput);

    expect(goals.recordIsolatedLoopCandidateBinding(binding))
      .toEqual(binding);
    expect(goals.recordIsolatedLoopCandidateBinding(binding))
      .toEqual(binding);
    expect(goals.getGoal().goal?.isolatedLoopCandidate).toEqual({
      candidateId: binding.candidateId,
      worktreeLeaseId: binding.worktreeLeaseId,
      bindingDigest: binding.bindingDigest,
    });
    expect(records.filter(
      (record) => record.type === 'loop.isolated-candidate.bind',
    )).toHaveLength(1);
    const iterationInput = {
      bindingDigest: binding.bindingDigest,
      candidateGateAttemptId:
        '60000000-0000-4000-8000-000000000006',
      candidateGateResultDigest: canonicalDigest(
        'wukong/test/candidate-gate-result/v1',
        'result',
      ),
    };
    expect(goals.recordIsolatedLoopCandidateIteration(iterationInput)
      .iteration).toBe(1);
    expect(goals.recordIsolatedLoopCandidateIteration(iterationInput)
      .iteration).toBe(1);
    expect(records.filter(
      (record) =>
        record.type === 'loop.isolated-candidate.iteration',
    )).toHaveLength(1);

    const conflicting = createIsolatedLoopCandidateBinding({
      ...bindingInput,
      candidateId: '40000000-0000-4000-8000-000000000004',
      worktreeLeaseId: '50000000-0000-4000-8000-000000000005',
    });
    expect(() => goals.recordIsolatedLoopCandidateBinding(conflicting))
      .toThrow(/already bound/u);

    const replayed = makeGoalMode().goals;
    for (const record of records) replayGoalRecord(replayed, record);
    expect(replayed.getIsolatedLoopCandidateBinding()).toEqual(binding);
    expect(replayed.getGoal().goal?.iteration).toBe(1);
  });

  it('creates only one continuation run for concurrent resume requests', async () => {
    const { goals, records } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Continue once',
      completionCriterion: 'The next bounded run finishes',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
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
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        source: 'user',
      },
    });
    goals.recordLoopTerminal({
      status: 'NEEDS_WORK',
      reasonCode: 'max_iterations',
      blockerKeys: ['check:test:failed'],
    });
    await goals.markBlocked({ reason: 'max iterations' }, 'system');
    const reviewSettings = makeReviewSettings(
      finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
    );

    const [left, right] = await Promise.all([
      goals.resumeGoal({ reviewSettings }, 'user'),
      goals.resumeGoal({ reviewSettings }, 'user'),
    ]);

    expect(left.loopRunId).toBe(right.loopRunId);
    expect(left.iteration).toBe(0);
    expect(records.filter((record) => record.type === 'loop.continuation.create')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'loop.run.create')).toHaveLength(2);
  });

  it('assigns brokered review settings to a legacy active V2 run before resume', async () => {
    const { goals, records } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Resume a legacy V2 run',
      completionCriterion: 'The run uses brokered review settings',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
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
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        source: 'user',
      },
    });
    await goals.pauseGoal();
    await expect(goals.resumeGoal()).rejects.toMatchObject({
      code: ErrorCodes.GOAL_NOT_RESUMABLE,
    });

    const reviewSettings = makeReviewSettings(
      finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
    );
    const resumed = await goals.resumeGoal({ reviewSettings });
    const runtime = goals.createLoopGateReviewRuntime();

    expect(resumed.status).toBe('active');
    expect(runtime).toMatchObject({
      runSettings: {
        reviewSubjectConsent: {
          consentDigest: reviewSettings.reviewSubjectConsent.consentDigest,
        },
      },
    });
    expect(
      records.filter((record) => record.type === 'loop.run-review-settings.assign'),
    ).toHaveLength(1);

    const replayed = makeGoalMode().goals;
    for (const record of records) {
      // This fixture restores only the contract/run settings records it exercises.
      // oxlint-disable-next-line typescript-eslint/switch-exhaustiveness-check
      switch (record.type) {
        case 'goal.create':
          replayed.restoreCreate(record);
          break;
        case 'goal.contract.create':
          replayed.restoreContractCreate(record);
          break;
        case 'loop.run.create':
          replayed.restoreLoopRunCreate(record);
          break;
        case 'loop.run-review-settings.assign':
          replayed.restoreLoopRunReviewSettingsAssignment(record);
          break;
        default:
          break;
      }
    }
    expect(replayed.createLoopGateReviewRuntime()?.runSettings.settingsDigest)
      .toBe(runtime?.runSettings.settingsDigest);
  });

  it('requires a new consent binding for a terminal continuation', async () => {
    const { goals } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Continue with fresh consent',
      completionCriterion: 'The next run has its own consent binding',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    const firstSettings = makeReviewSettings(
      finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
      1_000,
    );
    await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
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
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        reviewSettings: firstSettings,
        source: 'user',
      },
    });
    goals.recordLoopTerminal({
      status: 'NEEDS_WORK',
      reasonCode: 'max_iterations',
    });
    await goals.markBlocked({ reason: 'max iterations' }, 'system');

    await expect(goals.resumeGoal()).rejects.toMatchObject({
      code: ErrorCodes.GOAL_NOT_RESUMABLE,
    });
    const nextSettings = makeReviewSettings(
      finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
      2_000,
    );
    expect(nextSettings.reviewSubjectConsent.consentDigest)
      .not.toBe(firstSettings.reviewSubjectConsent.consentDigest);
    const resumed = await goals.resumeGoal({ reviewSettings: nextSettings });
    const runtime = goals.createLoopGateReviewRuntime();

    expect(resumed.status).toBe('active');
    expect(runtime?.runSettings.reviewSubjectConsent.consentDigest)
      .toBe(nextSettings.reviewSubjectConsent.consentDigest);
  });

  it('emits typed lifecycle and completion changes', async () => {
    const { goals, events } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    expect(events.at(-1)?.change).toBeUndefined();

    await goals.pauseGoal();
    expect(events.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'paused' });

    await goals.resumeGoal();
    expect(events.at(-1)?.change).toMatchObject({ kind: 'lifecycle', status: 'active' });

    await goals.markComplete({ reason: 'done' }, 'model');
    const completion = events.find((event) => event.change?.kind === 'completion')?.change;
    expect(completion).toMatchObject({ kind: 'completion', status: 'complete', reason: 'done' });
    expect(goals.getGoal().goal).toBeNull();
    expect(events.at(-1)?.snapshot).toBeNull();
  });

  it('keeps blocked goals resumable', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    const blocked = await goals.markBlocked({ reason: 'need creds' });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.terminalReason).toBe('need creds');

    const resumed = await goals.resumeGoal();
    expect(resumed.status).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();
  });

  it('pauseOnInterrupt parks active goals and no-ops for stopped goals', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    const paused = await goals.pauseOnInterrupt({ reason: 'Paused after interruption' });
    expect(paused?.status).toBe('paused');
    expect(paused?.terminalReason).toBe('Paused after interruption');

    expect(await goals.pauseOnInterrupt({ reason: 'again' })).toBeNull();
    expect(goals.getGoal().goal?.status).toBe('paused');
  });

  it('cancelGoal discards the goal and throws when missing', async () => {
    const { goals, reminders } = makeGoalMode();

    await goals.createGoal({ objective: 'work' });
    const removed = await goals.cancelGoal();
    expect(removed.status).toBe('active');
    expect(goals.getGoal()).toEqual({ goal: null });
    expect(reminders).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('Ignore earlier active-goal reminders'),
        origin: { kind: 'system_trigger', name: 'goal_cancelled' },
      }),
    ]);
    await expect(goals.cancelGoal()).rejects.toMatchObject({ code: ErrorCodes.GOAL_NOT_FOUND });
  });
});

describe('GoalMode accounting and budgets', () => {
  it('counts tokens and turns only while active', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work' });
    await goals.recordTokenUsage(30);
    await goals.incrementTurn();
    expect(goals.getGoal().goal).toMatchObject({ tokensUsed: 30, turnsUsed: 1 });

    await goals.pauseGoal();
    await goals.recordTokenUsage(12);
    await goals.incrementTurn();
    expect(goals.getGoal().goal).toMatchObject({ tokensUsed: 30, turnsUsed: 1 });
  });

  it('sets budget limits through SetGoalBudget-style updates', async () => {
    const { goals } = makeGoalMode();

    await goals.createGoal({ objective: 'work' });
    const snapshot = await goals.setBudgetLimits({
      budgetLimits: { tokenBudget: 100, turnBudget: 2, wallClockBudgetMs: 1000 },
    }, 'model');

    expect(snapshot.budget.tokenBudget).toBe(100);
    expect(snapshot.budget.turnBudget).toBe(2);
    expect(snapshot.budget.wallClockBudgetMs).toBe(1000);
  });

  it('tracks telemetry without goal text', async () => {
    const { goals, telemetry } = makeGoalMode();

    await goals.createGoal({ objective: 'private objective', replace: true });
    await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 100 } }, 'model');
    await goals.incrementTurn();
    await goals.pauseGoal({ reason: 'private pause reason' });
    await goals.resumeGoal();
    await goals.markComplete({ reason: 'private completion reason' }, 'model');

    expect(telemetry.map((record) => record.event)).toEqual([
      'goal_created',
      'goal_budget_set',
      'goal_continued',
      'goal_status_changed',
      'goal_status_changed',
      'goal_status_changed',
      'goal_cleared',
    ]);
    expect(telemetry[0]?.properties).toEqual({ actor: 'user', replace: true });
    expect(telemetry[1]?.properties).toMatchObject({ actor: 'model', has_token_budget: true });
    expect(telemetry[3]?.properties).toMatchObject({ status: 'paused', actor: 'user' });
    expect(JSON.stringify(telemetry)).not.toContain('private objective');
    expect(JSON.stringify(telemetry)).not.toContain('private pause reason');
    expect(JSON.stringify(telemetry)).not.toContain('private completion reason');
  });
});

describe('GoalMode records', () => {
  it('returns check_unstable for contradictory results on the same workspace snapshot', async () => {
    const { goals } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Detect unstable checks',
      completionCriterion: 'The exact frozen check is stable',
      explicitChecks: ['node -e "process.exit(0)"'],
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
        objective: finishLine.proposal.objective,
        completionCriterion: finishLine.proposal.completionCriterion,
        constraints: finishLine.proposal.constraints,
        finishLineReview: finishLine.proposal.finishLineReview,
        workspaceIdentity: finishLine.proposal.workspaceIdentity,
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        reviewSettings: makeReviewSettings(
          finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
        ),
        source: 'user',
      },
    });
    const first = await recordBrokeredGate(goals, {
      workspaceFingerprint: 'same-snapshot',
      status: 'PASS',
      reasonCode: 'passed',
      checkStatus: 'passed',
    });
    const second = await recordBrokeredGate(goals, {
      workspaceFingerprint: 'same-snapshot',
      status: 'NEEDS_WORK',
      reasonCode: 'check_failed',
      checkStatus: 'failed',
    });

    expect(first).toMatchObject({ status: 'PASS' });
    expect(second).toMatchObject({ status: 'ERROR', reasonCode: 'check_unstable' });
  });

  it('persists a V2 contract, run, complete Gate attempt, and terminal result', async () => {
    const { goals, records } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Ship an explicit Finish Line',
      completionCriterion: 'The frozen gate and reviewer both pass',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;

    const created = await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
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
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        reviewSettings: makeReviewSettings(
          finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
        ),
        source: 'user',
      },
    });
    expect(created.loopContract?.schemaVersion).toBe(2);
    expect(created.loopRunId).toBeTruthy();

    const secret = 'sk_live_goalGatePrivacySentinel123456789';
    const attempt = await recordBrokeredGate(goals, {
      workspaceFingerprint: 'workspace-fingerprint',
      status: 'PASS',
      reasonCode: 'passed',
      findingDiagnostics: {
        message: `Authorization: Bearer ${secret}`,
        nextAction:
          `retry https://alice:${secret}@example.test/v1?token=${secret}`,
      },
    });
    const terminal = goals.recordLoopTerminal({
      status: 'PASS',
      reasonCode: 'passed',
      attempt,
    });

    expect(attempt).toMatchObject({ status: 'PASS', reasonCode: 'passed' });
    expect(terminal).toMatchObject({
      status: 'PASS',
      continuationPolicy: { mode: 'blocked', automaticRetry: false },
    });
    expect(records.map((record) => record.type)).toEqual(expect.arrayContaining([
      'goal.contract.create',
      'loop.run.create',
      'loop.gate-attempt.create',
      'loop.builtin-risk-scan-result.create',
      'loop.review-subject-manifest.create',
      'loop.fresh-criteria-verdict.create',
      'loop.proof-aggregate.create',
      'loop.evidence-snapshot.create',
      'loop.gate-attempt.complete',
      'loop.run.terminal',
    ]));
    const serializedRecords = JSON.stringify(records);
    expect(serializedRecords).not.toContain(secret);
    expect(serializedRecords).not.toContain('alice');
    expect(serializedRecords).toContain('[REDACTED]');

    const replayed = makeGoalMode().goals;
    for (const record of records) {
      replayGoalRecord(replayed, record);
    }
    expect(replayed.getGoal().goal).toMatchObject({
      loopRunId: created.loopRunId,
      loopTerminal: { status: 'PASS', reasonCode: 'passed' },
    });

    const proofRecord = records.find((record) => record.type === 'loop.proof-aggregate.create');
    if (proofRecord?.type !== 'loop.proof-aggregate.create') throw new Error('proof record missing');
    const tampered = {
      ...proofRecord,
      result: { ...proofRecord.result, reasonCode: 'tampered' },
    };
    const partial = makeGoalMode().goals;
    const createRecord = records.find((record) => record.type === 'goal.create');
    const contractRecord = records.find((record) => record.type === 'goal.contract.create');
    const runRecord = records.find((record) => record.type === 'loop.run.create');
    const attemptRecord = records.find((record) => record.type === 'loop.gate-attempt.create');
    if (
      createRecord?.type !== 'goal.create'
      || contractRecord?.type !== 'goal.contract.create'
      || runRecord?.type !== 'loop.run.create'
      || attemptRecord?.type !== 'loop.gate-attempt.create'
    ) throw new Error('replay fixture records missing');
    partial.restoreCreate(createRecord);
    partial.restoreContractCreate(contractRecord);
    partial.restoreLoopRunCreate(runRecord);
    partial.restoreLoopAuditRecord(attemptRecord);
    expect(() => {
      partial.restoreLoopAuditRecord(tampered);
    }).toThrow('proof aggregate mismatch');

    const manifestIndex = records.findIndex(
      (record) => record.type === 'loop.review-subject-manifest.create',
    );
    const verdictIndex = records.findIndex(
      (record) => record.type === 'loop.fresh-criteria-verdict.create',
    );
    const verdictRecord = records[verdictIndex];
    if (
      manifestIndex < 0
      || verdictIndex < 0
      || verdictRecord?.type !== 'loop.fresh-criteria-verdict.create'
    ) {
      throw new Error('broker verdict fixture records missing');
    }

    const missingManifest = makeGoalMode().goals;
    for (const record of records.slice(0, manifestIndex)) {
      replayGoalRecord(missingManifest, record);
    }
    expect(() => {
      missingManifest.restoreLoopAuditRecord(verdictRecord);
    }).toThrow('fresh verdict mismatch');

    const tamperedVerdict = {
      ...verdictRecord,
      result: {
        ...verdictRecord.result,
        verdict: {
          ...verdictRecord.result.verdict,
          reviewerInputDigest: 'sha256:tampered-reviewer-input',
        },
      },
    };
    const verdictReplay = makeGoalMode().goals;
    for (const record of records.slice(0, verdictIndex)) {
      replayGoalRecord(verdictReplay, record);
    }
    expect(() => {
      verdictReplay.restoreLoopAuditRecord(tamperedVerdict);
    }).toThrow('verdict');
  });

  it('rebinds a complete Goal Gate audit to the exact post-Apply target state', async () => {
    const { goals, records } = makeGoalMode();
    const finishLine = await buildFinishLine({
      cwd: process.cwd(),
      objective: 'Prove the promoted target',
      completionCriterion: 'The target Final Gate passes',
      includeDiscoveredChecks: false,
    });
    expect(finishLine.ok).toBe(true);
    if (!finishLine.ok) return;
    await goals.createGoal({
      objective: finishLine.proposal.objective,
      completionCriterion:
        finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      loopContract: {
        schemaVersion: 2,
        objective: finishLine.proposal.objective,
        completionCriterion:
          finishLine.proposal.completionCriterion,
        constraints: finishLine.proposal.constraints,
        finishLineReview: {
          ...finishLine.proposal.finishLineReview,
          acknowledgedWarningIds:
            finishLine.proposal.finishLineReview.warnings.map(
              (warning) => warning.id,
            ),
        },
        workspaceIdentity: finishLine.proposal.workspaceIdentity,
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        reviewSettings: makeReviewSettings(
          finishLine.proposal.workspaceIdentity
            .workspaceIdentityDigest,
        ),
        source: 'user',
      },
    });
    const contractRecord = records.find(
      (record) => record.type === 'goal.contract.create',
    );
    const runRecord = records.find(
      (record) => record.type === 'loop.run.create',
    );
    if (contractRecord?.type !== 'goal.contract.create'
      || contractRecord.contract.schemaVersion === 1
      || runRecord?.type !== 'loop.run.create') {
      throw new Error('Target Final Gate Goal fixture is incomplete.');
    }
    const contract = contractRecord.contract;
    const targetAfterFingerprintDigest =
      canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'target-after',
      );
    const completed = await recordBrokeredGate(goals, {
      workspaceFingerprint: canonicalDigest(
        'wukong/test/target-final-gate-goal-workspace-snapshot/v1',
        'target-after',
      ),
      status: 'PASS',
      reasonCode: 'passed',
    });
    if (completed === null) {
      throw new Error('Goal Gate completion is missing.');
    }
    const root = await mkdtemp(
      join(tmpdir(), 'wukong-goal-target-gate-'),
    );
    temporaryRoots.push(root);
    const sourceSnapshotDigest = canonicalDigest(
      'wukong/test/target-final-gate-goal/v1',
      'source',
    );
    const targetFingerprint = createTargetStateFingerprint({
      targetWorkspaceIdentity: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'workspace',
      ),
      targetGitCommonDirIdentity: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'git',
      ),
      headOid: 'a'.repeat(40),
      branchRef: 'refs/heads/main',
      branchRefDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'branch',
      ),
      indexDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'index',
      ),
      trackedWorkingDeltaDigest: null,
      untrackedProjectionDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'untracked',
      ),
      protectedRefsDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'refs',
      ),
      sourceSnapshotDigest,
      promotableContentDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'content',
      ),
    });
    const promotion = createPromotionConsentProposal({
      promotionId: '019f8d50-0000-7abc-8def-0123456789ab',
      candidateId: '019f8d50-0001-7abc-8def-0123456789ab',
      candidateDeltaDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'delta',
      ),
      candidateGateResultDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'candidate-gate',
      ),
      sourceSnapshotDigest,
      targetFingerprint,
      permissionDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'permission',
      ),
    });
    const targetStore = new TargetPromotionLeaseStore({
      registryRootDirectory: join(root, 'registry'),
    });
    const acquired = await targetStore.acquire({
      consent: acknowledgePromotionConsent(
        promotion,
        promotion.proposalDigest,
        '2026-07-29T16:29:00.000Z',
      ),
      targetFingerprint,
      ownerRunId: runRecord.run.runId,
      ownerProcessIdentityDigest: canonicalDigest(
        'wukong/test/target-final-gate-goal/v1',
        'process',
      ),
    });
    const applying = await targetStore.transition(
      acquired.binding,
      'applying',
    );
    const finalVerifying = await targetStore.transition(
      applying.binding,
      'final_verifying',
    );
    const attemptStore = new TargetFinalGateAttemptStore();
    await targetStore.withExclusiveLease(
      finalVerifying.binding,
      'final_verifying',
      async (view) => {
        const prepared = await attemptStore.initialize(view, {
          finalGateAttemptId: completed.attemptId,
          runId: completed.runId,
          contractId: completed.contractId,
          acceptanceContractDigest: acceptanceContractDigest(
            contract,
          ),
          gatePlanDigest: completed.planDigest,
          criteriaSelectionDigest: criteriaSelectionDigest(
            contract,
          ),
          sourceSnapshotDigest,
          promotionJournalId:
            '019f8d50-0002-7abc-8def-0123456789ab',
          promotionJournalHeadDigest: canonicalDigest(
            'wukong/test/target-final-gate-goal/v1',
            'journal',
          ),
          targetAfterFingerprintDigest,
        });
        const evidence = goals.buildTargetFinalGateEvidence({
          targetAttempt: prepared,
          evidenceSnapshotId:
            '019f8d50-0003-7abc-8def-0123456789ab',
        });
        expect(evidence).toMatchObject({
          finalGateAttemptId: completed.attemptId,
          runId: completed.runId,
          contractId: completed.contractId,
          targetAfterFingerprintDigest,
          builtinRiskScanStatus: 'clean',
          criteriaStatus: 'satisfied',
          freshReviewerStatus: 'PASS',
        });
        expect(evidence.evidenceDigest)
          .toMatch(/^sha256:[a-f0-9]{64}$/u);
      },
    );
  });

  it('creates one immutable Loop contract and restores convergence records', async () => {
    const { goals, records } = makeGoalMode();
    const created = await goals.createGoal({
      objective: 'ship the loop',
      completionCriterion: 'all acceptance checks pass',
      stopCondition: 'proof-pass',
    });

    const first = goals.ensureLoopContract();
    const second = goals.ensureLoopContract();
    expect(second).toBe(first);
    expect(first).toMatchObject({
      goalId: created.goalId,
      objective: 'ship the loop',
      source: 'user',
      acceptanceCriteria: [
        { id: 'objective', source: 'objective' },
        { id: 'completion-criterion', source: 'completion_criterion' },
      ],
    });
    expect(records.filter((record) => record.type === 'goal.contract.create')).toHaveLength(1);

    goals.recordReviewAttempt({
      schemaVersion: 1,
      iteration: 1,
      status: 'NEEDS_WORK',
      blockers: [{
        key: 'review:objective:correctness:src/loop.ts',
        findingId: 'loop-bug',
        category: 'correctness',
        file: 'src/loop.ts',
        summary: 'Loop exits early.',
        nextAction: 'Keep iterating until the gate passes.',
      }],
      blockerKeys: ['review:objective:correctness:src/loop.ts'],
      blockerFingerprint: 'same-blocker',
      model: 'reviewer',
      usedModelFallback: false,
      priorBlockerDispositions: [],
    });
    goals.recordStrategyAttempt({
      schemaVersion: 1,
      triggeredAtIteration: 1,
      blockerFingerprint: 'same-blocker',
      model: 'writer',
      status: 'advised',
      diagnosis: 'The retry condition never changes.',
      recommendedApproach: 'Replace the retry condition instead of adding another guard.',
      risks: ['Preserve the retry limit.'],
      usedModelFallback: false,
    });

    const restored = makeGoalMode().goals;
    restored.restoreCreate({
      type: 'goal.create',
      goalId: created.goalId,
      objective: 'ship the loop',
      completionCriterion: 'all acceptance checks pass',
      stopCondition: 'proof-pass',
    });
    const contractRecord = records.find((record) => record.type === 'goal.contract.create');
    const reviewRecord = records.find((record) => record.type === 'goal.review.record');
    const strategyRecord = records.find((record) => record.type === 'goal.strategy.record');
    if (contractRecord?.type !== 'goal.contract.create') throw new Error('contract record missing');
    if (reviewRecord?.type !== 'goal.review.record') throw new Error('review record missing');
    if (strategyRecord?.type !== 'goal.strategy.record') throw new Error('strategy record missing');
    restored.restoreContractCreate(contractRecord);
    restored.restoreReviewRecord(reviewRecord);
    restored.restoreStrategyRecord(strategyRecord);

    expect(restored.getGoal().goal).toMatchObject({
      loopContract: { objective: 'ship the loop' },
      convergence: {
        reviewAttempts: 1,
        lastBlockerFingerprint: 'same-blocker',
        strategyAttempts: 1,
      },
    });
  });

  it('creates a fallback contract for a legacy Goal without changing its objective', () => {
    const { goals, records } = makeGoalMode();
    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'legacy-goal',
      objective: 'preserve this exact objective',
      stopCondition: 'proof-pass',
    });

    const contract = goals.ensureLoopContract();

    expect(contract).toMatchObject({
      goalId: 'legacy-goal',
      objective: 'preserve this exact objective',
      source: 'fallback',
    });
    expect(goals.getGoal().goal?.objective).toBe('preserve this exact objective');
    expect(records).toEqual([
      expect.objectContaining({ type: 'goal.contract.create', goalId: 'legacy-goal' }),
    ]);
  });

  it('restores legacy strategy records into the 0.0.16 strategy contract', () => {
    const { goals } = makeGoalMode();
    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'legacy-goal',
      objective: 'finish the loop',
      stopCondition: 'proof-pass',
    });
    goals.restoreStrategyRecord({
      type: 'goal.strategy.record',
      goalId: 'legacy-goal',
      attempt: {
        schemaVersion: 1,
        afterIteration: 2,
        blockerFingerprint: 'legacy-blocker',
        model: 'writer',
        outcome: 'advice',
        advice: 'Inspect the first failing assertion.',
      },
    } as never);

    expect(goals.getStrategyHistory()).toEqual([expect.objectContaining({
      triggeredAtIteration: 2,
      blockerFingerprint: 'legacy-blocker',
      status: 'advised',
      recommendedApproach: 'Inspect the first failing assertion.',
      usedModelFallback: false,
    })]);
  });

  it('records only replay-relevant create/update/clear fields', async () => {
    const { goals, records } = makeGoalMode();

    await goals.createGoal({ objective: 'work', completionCriterion: 'tests pass' });
    await goals.recordTokenUsage(5);
    await goals.incrementTurn();
    await goals.setBudgetLimits({ budgetLimits: { turnBudget: 2 } }, 'model');
    await goals.markBlocked({ reason: 'stuck' });
    await goals.cancelGoal();

    expect(records).toEqual([
      expect.objectContaining({
        type: 'goal.create',
        goalId: expect.any(String),
        objective: 'work',
        completionCriterion: 'tests pass',
      }),
      expect.objectContaining({ type: 'goal.update', tokensUsed: 5 }),
      expect.objectContaining({ type: 'goal.update', turnsUsed: 1 }),
      expect.objectContaining({
        type: 'goal.update',
        budgetLimits: { turnBudget: 2 },
      }),
      expect.objectContaining({
        type: 'goal.update',
        status: 'blocked',
        reason: 'stuck',
        actor: 'runtime',
      }),
      expect.objectContaining({ type: 'goal.clear' }),
    ]);
    expect(records[0]).not.toHaveProperty('actor');
    expect(records[0]).not.toHaveProperty('budgetLimits');
    expect(records[1]).not.toHaveProperty('goalId');
    expect(records[1]).not.toHaveProperty('status');
    expect(records.at(-1)).not.toHaveProperty('goalId');
    expect(records.at(-1)).not.toHaveProperty('reason');
  });

  it('restores state from patch records', () => {
    const { goals } = makeGoalMode();

    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      completionCriterion: 'tests pass',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    goals.restoreUpdate({ type: 'goal.update', tokensUsed: 5 });
    goals.restoreUpdate({ type: 'goal.update', turnsUsed: 1 });
    goals.restoreUpdate({ type: 'goal.update', budgetLimits: { turnBudget: 2 } });
    goals.restoreUpdate({ type: 'goal.update', status: 'blocked', reason: 'stuck' });

    expect(goals.getGoal().goal).toMatchObject({
      objective: 'work',
      completionCriterion: 'tests pass',
      status: 'blocked',
      terminalReason: 'stuck',
      tokensUsed: 5,
      turnsUsed: 1,
    });
    expect(goals.getGoal().goal?.budget.turnBudget).toBe(2);
  });

  it.each(['verify-pass', 'scan-clean', 'judge-pass'] as const)(
    'migrates legacy %s Goal records to the proof gate',
    (stopCondition) => {
      const { goals } = makeGoalMode();

      goals.restoreCreate({
        type: 'goal.create',
        goalId: `legacy-${stopCondition}`,
        objective: 'finish the old goal',
        stopCondition,
        maxIterations: 3,
        time: Date.parse('2026-01-01T00:00:00.000Z'),
      });

      expect(goals.getGoal().goal).toMatchObject({
        stopCondition: 'proof-pass',
        maxIterations: 3,
        iteration: 0,
      });
    },
  );

  it.each([0, -1, 0.5, 3.9, Number.POSITIVE_INFINITY])(
    'rejects invalid maxIterations %s at the core boundary',
    async (maxIterations) => {
      const { goals } = makeGoalMode();

      await expect(goals.createGoal({
        objective: 'bounded loop',
        stopCondition: 'proof-pass',
        maxIterations,
      })).rejects.toThrow('maxIterations must be a positive safe integer');
      expect(goals.getGoal().goal).toBeNull();
    },
  );

  it('records and restores the durable Loop result', async () => {
    const { goals, records } = makeGoalMode();

    await goals.createGoal({ objective: 'make the gate pass' });
    await goals.incrementIteration();
    const result = goals.recordLoopResult({
      schemaVersion: 2,
      status: 'NEEDS_WORK',
      reasonCode: 'check_failed',
      summary: 'Tests are still failing.',
      checks: [{ command: 'npm test', status: 'failed', exitCode: 1, durationMs: 50 }],
      blockers: [{ id: 'test', kind: 'check', summary: 'Fix the failing test.', nextAction: 'Run npm test.' }],
    });

    expect(result).toMatchObject({ iterations: 1, status: 'NEEDS_WORK' });
    const update = records.at(-1);
    expect(update).toMatchObject({ type: 'goal.update', loopResult: result });

    const restored = makeGoalMode().goals;
    restored.restoreCreate({
      type: 'goal.create',
      goalId: 'g-loop',
      objective: 'make the gate pass',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    restored.restoreUpdate({ type: 'goal.update', iteration: 1 });
    if (update?.type !== 'goal.update') throw new Error('expected goal.update record');
    restored.restoreUpdate(update);

    expect(restored.getGoal().goal?.loopResult).toEqual(result);
  });

  it('redacts synthetic secrets before durable Loop records are emitted', async () => {
    const { goals, records } = makeGoalMode();
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const url =
      `https://alice:${secret}@example.test/v1?token=${secret}`;

    await goals.createGoal({ objective: 'keep diagnostics private' });
    const result = goals.recordLoopResult({
      schemaVersion: 2,
      status: 'ERROR',
      reasonCode: secret,
      summary: `exception from ${url}`,
      checks: [{
        command: `OPENAI_API_KEY=${secret} npm test`,
        status: 'failed',
        exitCode: 1,
        durationMs: 10,
      }],
      blockers: [{
        id: secret,
        kind: 'check',
        summary: `Authorization: Bearer ${secret}`,
        evidence: `stderr=${secret}`,
        nextAction: `retry ${url}`,
      }],
    });
    await goals.markBlocked({
      reason: `runtime failed with OPENAI_API_KEY=${secret}`,
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('alice');
    expect(serialized).toContain('[REDACTED]');
    expect(result).toMatchObject({ reasonCode: 'runtime_error' });
    expect(goals.getGoal().goal?.terminalReason)
      .toContain('OPENAI_API_KEY=[REDACTED]');
  });

  it('projects restored goal status changes into replay records', () => {
    const { goals, replay } = makeGoalMode();

    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      completionCriterion: 'tests pass',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    goals.restoreUpdate({ type: 'goal.update', tokensUsed: 5 });
    goals.restoreUpdate({ type: 'goal.update', turnsUsed: 1 });
    goals.restoreUpdate({
      type: 'goal.update',
      status: 'paused',
      reason: 'break',
      actor: 'runtime',
    });
    goals.restoreUpdate({ type: 'goal.update', status: 'active', actor: 'user' });
    goals.restoreUpdate({
      type: 'goal.update',
      status: 'complete',
      reason: 'done',
      actor: 'model',
    });

    expect(replay).toEqual([
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ objective: 'work', status: 'active' }),
        change: { kind: 'created' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ status: 'paused', terminalReason: 'break' }),
        change: { kind: 'lifecycle', status: 'paused', reason: 'break', actor: 'runtime' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ status: 'active' }),
        change: { kind: 'lifecycle', status: 'active', reason: undefined, actor: 'user' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          status: 'complete',
          terminalReason: 'done',
          turnsUsed: 1,
          tokensUsed: 5,
        }),
        change: {
          kind: 'completion',
          status: 'complete',
          reason: 'done',
          stats: { turnsUsed: 1, tokensUsed: 5, wallClockMs: 0 },
          actor: 'model',
        },
      }),
    ]);
  });

  it('keeps resume-normalization pauses in core replay records', () => {
    const { goals, replay } = makeGoalMode();

    goals.restoreCreate({
      type: 'goal.create',
      goalId: 'g1',
      objective: 'work',
      time: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    goals.restoreUpdate({
      type: 'goal.update',
      status: 'paused',
      reason: 'Paused after agent resume',
    });

    expect(replay.at(-1)).toMatchObject({
      type: 'goal_updated',
      snapshot: { status: 'paused', terminalReason: 'Paused after agent resume' },
      change: {
        kind: 'lifecycle',
        status: 'paused',
        reason: 'Paused after agent resume',
        actor: undefined,
      },
    });
  });

  it('normalizes active replayed goals to paused', async () => {
    const { goals, records } = makeGoalMode();

    await goals.createGoal({ objective: 'resume me' });
    records.length = 0;
    goals.normalizeAfterReplay();

    expect(goals.getGoal().goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after agent resume',
    });
    expect(records).toEqual([
      expect.objectContaining({
        type: 'goal.update',
        status: 'paused',
        reason: 'Paused after agent resume',
      }),
    ]);
  });
});
