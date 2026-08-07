import { ErrorCodes, WukongError } from '@wukong/wukong-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchInput,
  goalArgumentCompletions,
  handleGoalCommand,
  handleLoopSlashCommand,
  parseGoalCommand,
  parseLoopCommand,
  setExperimentalFeatures,
} from '#/tui/commands/index';
import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  updateGoalQueueItem,
} from '#/tui/goal-queue-store';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { getBuiltInPalette } from '#/tui/theme';
import { clearSessionWorkspaceTrustForTests } from '#/cli/lib/workspace-trust';

const loopLifecycleMocks = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ runId: 'run123' })),
  register: vi.fn(async () => {}),
  complete: vi.fn(async () => {}),
  completeRun: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  stopRun: vi.fn(async () => {}),
}));

const loopPreflightMocks = vi.hoisted(() => ({
  run: vi.fn(async () => ({
    ready: true as const,
    model: 'wukong-model',
    workspace: '/workspace',
    checks: ['pnpm test'],
  })),
}));

vi.mock('#/cli/lib/loop-lifecycle', () => ({
  beginLoopRun: loopLifecycleMocks.begin,
  registerTuiLoop: loopLifecycleMocks.register,
  completeTuiLoop: loopLifecycleMocks.complete,
  completeLoopRun: loopLifecycleMocks.completeRun,
  stopTuiLoop: loopLifecycleMocks.stop,
  stopLoopRun: loopLifecycleMocks.stopRun,
}));

vi.mock('#/cli/lib/workspace-trust', () => ({
  clearSessionWorkspaceTrustForTests: vi.fn(),
  findBrokerReviewTrust: vi.fn(async () => undefined),
  findWorkspaceTrust: vi.fn(async () => undefined),
  grantBrokerReviewTrustLocally: vi.fn(async (proposal: {
    workspaceIdentityDigest: string;
    trustProposalDigest: string;
    reviewSubjectPolicyVersion: string;
  }) => ({
    schemaVersion: 1,
    trustGrantId: 'broker-grant',
    workspaceIdentityDigest: proposal.workspaceIdentityDigest,
    scope: 'brokered-review-subject',
    trustProposalDigest: proposal.trustProposalDigest,
    reviewSubjectPolicyVersion: proposal.reviewSubjectPolicyVersion,
    persistence: 'session',
    createdAt: 1,
  })),
  brokerReviewTrustBinding: (grant: {
    trustGrantId: string;
    workspaceIdentityDigest: string;
    scope: 'brokered-review-subject';
    trustProposalDigest: string;
  }) => ({
    trustGrantId: grant.trustGrantId,
    workspaceIdentityDigest: grant.workspaceIdentityDigest,
    scope: grant.scope,
    trustProposalDigest: grant.trustProposalDigest,
  }),
  grantWorkspaceTrust: vi.fn(async (identity: {
    canonicalRealpath: string;
    workspaceIdentityDigest: string;
  }) => ({
    schemaVersion: 1,
    trustGrantId: 'workspace-grant',
    canonicalRealpath: identity.canonicalRealpath,
    workspaceIdentityDigest: identity.workspaceIdentityDigest,
    scope: 'loop-project-checks',
    persistence: 'session',
    createdAt: 1,
  })),
}));

vi.mock('#/cli/lib/loop-preflight', () => ({
  runLoopPreflight: loopPreflightMocks.run,
  createLoopReviewSettingsProposal: () => ({
    brokerTrustProposal: {
      schemaVersion: 1,
      workspaceIdentityDigest: 'sha256:workspace',
      scope: 'brokered-review-subject',
      reviewSubjectPolicyVersion: 'review-subject/1',
      intent: 'once',
      trustProposalDigest: 'sha256:broker',
    },
    reviewSubjectConsentProposal: {
      schemaVersion: 1,
      workspaceIdentityDigest: 'sha256:workspace',
      reviewSubjectPolicyVersion: 'review-subject/1',
      hardExclusionPolicyVersion: 'review-subject-hard-exclusion/1',
      allowedOrigins: ['changed-tracked'],
      limits: {
        maxFiles: 200,
        maxTotalBytes: 2_097_152,
        maxFileBytes: 262_144,
        maxGateEvidenceTotalBytes: 524_288,
        maxGateEvidenceBytes: 131_072,
      },
      provider: {
        providerId: 'openai',
        endpointOrigin: { scheme: 'https', host: 'api.openai.com', port: 443 },
        endpointOriginDigest: 'sha256:origin',
      },
      consentProposalDigest: 'sha256:consent',
    },
  }),
  confirmLoopReviewSettings: () => ({
    brokerReviewTrust: {
      workspaceIdentityDigest: 'sha256:workspace',
      scope: 'brokered-review-subject',
      trustProposalDigest: 'sha256:broker',
      trustGrantId: 'broker-grant',
    },
    reviewSubjectConsent: {
      schemaVersion: 1,
      workspaceIdentityDigest: 'sha256:workspace',
      reviewSubjectPolicyVersion: 'review-subject/1',
      hardExclusionPolicyVersion: 'review-subject-hard-exclusion/1',
      allowedOrigins: ['changed-tracked'],
      limits: {
        maxFiles: 200,
        maxTotalBytes: 2_097_152,
        maxFileBytes: 262_144,
        maxGateEvidenceTotalBytes: 524_288,
        maxGateEvidenceBytes: 131_072,
      },
      provider: {
        providerId: 'openai',
        endpointOriginDigest: 'sha256:origin',
      },
      consentProposalDigest: 'sha256:consent',
      acknowledgedAt: 1,
      consentDigest: 'sha256:consent-binding',
    },
  }),
  resolveLoopReviewProvider: () => ({
    providerId: 'openai',
    endpoint: 'https://api.openai.com/v1',
  }),
  formatLoopPreflightBlocked: (result: { reason: string; next: string }) =>
    `Loop not started\nReason   ${result.reason}\nNext     ${result.next}`,
  formatLoopPreflightReady: (_result: unknown, maxIterations: number) =>
    `Ready to start Loop\nLimit    up to ${String(maxIterations)} iterations`,
}));

vi.mock('#/tui/goal-queue-store', () => ({
  appendGoalQueueItem: vi.fn(async () => ({
    goals: [{ id: 'q1', objective: 'obj', createdAt: '', updatedAt: '' }],
  })),
  readGoalQueue: vi.fn(async () => ({
    goals: [
      { id: 'q1', objective: 'First queued goal', createdAt: '', updatedAt: '' },
      { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
    ],
  })),
  moveGoalQueueItem: vi.fn(async () => ({
    goals: [
      { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
      { id: 'q1', objective: 'First queued goal', createdAt: '', updatedAt: '' },
    ],
  })),
  removeGoalQueueItem: vi.fn(async () => ({
    goals: [{ id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' }],
  })),
  updateGoalQueueItem: vi.fn(async () => ({
    goals: [
      { id: 'q1', objective: 'First queued goal updated', createdAt: '', updatedAt: '' },
      { id: 'q2', objective: 'Second queued goal', createdAt: '', updatedAt: '' },
    ],
  })),
}));

const ENTER = '\r';
const ESCAPE = '\u001B';
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';

function fakeSnapshot() {
  return {
    goalId: 'g1',
    objective: 'obj',
    loopRunId: 'core-run-1',
    status: 'active' as const,
    iteration: 0,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: 20,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: 20,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

function finishLineProposal(objective: string) {
  return {
    schemaVersion: 1,
    objective,
    constraints: [],
    finishLineReview: {
      schemaVersion: 1,
      warningPolicyVersion: 'finish-line-warnings/1',
      finishLineDigest: 'sha256:finish',
      warnings: [],
      warningSetDigest: 'sha256:warnings',
      acknowledgedWarningIds: [],
    },
    workspaceIdentity: {
      canonicalRealpath: '/workspace',
      filesystemIdentity: '1:1',
      workspaceIdentityDigest: 'sha256:workspace',
    },
    gateApproval: {
      schemaVersion: 1,
      gatePlanDigest: 'sha256:plan',
      warningSetDigest: 'sha256:warnings',
      guardPolicyVersion: 'gate-guard/1',
      orderedChecks: [],
      noExecutableChecksDecisionDigest: 'sha256:no-check',
      approvalSetDigest: 'sha256:approval',
      hasExecutableChecks: false,
    },
    gatePlan: {
      schemaVersion: 1,
      stopCondition: 'proof-pass',
      requiredChecks: [],
      excludedChecks: [],
      builtinRiskScanPolicyVersion: 'builtin-risk-scan/1',
      planDigest: 'sha256:plan',
    },
    noExecutableChecksDecision: {
      schemaVersion: 1,
      policyVersion: 'no-executable-checks/1',
      decisionDigest: 'sha256:no-check',
      status: 'acknowledged',
      acknowledgedAt: 1,
    },
    reviewPolicy: { mode: 'advisory-live' },
  } as const;
}

function loopPreflightReady(objective: string) {
  return {
    ready: true as const,
    model: 'wukong-model',
    workspace: '/workspace',
    checks: [],
    proposal: finishLineProposal(objective),
    trustChallenge: 'challenge.signature',
    brokerTrustChallenge: 'broker.challenge',
    contractSchemaVersion: 2 as const,
    verificationCatalog: {
      schemaVersion: 1 as const,
      policyVersion: 'verification-catalog/1',
      entries: [],
      failures: [],
      suggestions: [],
      catalogDigest: 'sha256:catalog',
    },
    selectedRecipes: [],
    brokerTrustProposal: {
      schemaVersion: 1 as const,
      workspaceIdentityDigest: 'sha256:workspace',
      scope: 'brokered-review-subject' as const,
      reviewSubjectPolicyVersion: 'review-subject/1',
      intent: 'once' as const,
      trustProposalDigest: 'sha256:broker',
    },
    brokerReviewTrust: {
      trustGrantId: 'broker-grant',
      workspaceIdentityDigest: 'sha256:workspace',
      scope: 'brokered-review-subject' as const,
      trustProposalDigest: 'sha256:broker',
    },
    reviewSubjectConsentProposal: {
      schemaVersion: 1 as const,
      workspaceIdentityDigest: 'sha256:workspace',
      reviewSubjectPolicyVersion: 'review-subject/1',
      hardExclusionPolicyVersion: 'review-subject-hard-exclusion/1',
      allowedOrigins: ['changed-tracked'] as const,
      limits: {
        maxFiles: 200,
        maxTotalBytes: 2_097_152,
        maxFileBytes: 262_144,
        maxGateEvidenceTotalBytes: 524_288,
        maxGateEvidenceBytes: 131_072,
      },
      provider: {
        providerId: 'openai',
        endpointOrigin: { scheme: 'https' as const, host: 'api.openai.com', port: 443 },
        endpointOriginDigest: 'sha256:origin',
      },
      consentProposalDigest: 'sha256:consent',
    },
    reviewSubjectConsent: {
      schemaVersion: 1 as const,
      workspaceIdentityDigest: 'sha256:workspace',
      reviewSubjectPolicyVersion: 'review-subject/1',
      hardExclusionPolicyVersion: 'review-subject-hard-exclusion/1',
      allowedOrigins: ['changed-tracked'] as const,
      limits: {
        maxFiles: 200,
        maxTotalBytes: 2_097_152,
        maxFileBytes: 262_144,
        maxGateEvidenceTotalBytes: 524_288,
        maxGateEvidenceBytes: 131_072,
      },
      provider: {
        providerId: 'openai',
        endpointOriginDigest: 'sha256:origin',
      },
      consentProposalDigest: 'sha256:consent',
      acknowledgedAt: 1,
      consentDigest: 'sha256:consent-binding',
    },
  };
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeHost(
  overrides: {
    model?: string;
    hasSession?: boolean;
    streaming?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
  } = {},
) {
  const session = {
    id: 'session-1',
    setPermission: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    createGoal: vi.fn(async () => fakeSnapshot()),
    getGoal: vi.fn(async (): Promise<{ goal: ReturnType<typeof fakeSnapshot> | null }> => ({
      goal: null,
    })),
    pauseGoal: vi.fn(async () => fakeSnapshot()),
    resumeGoal: vi.fn(async () => fakeSnapshot()),
    cancelGoal: vi.fn(async () => fakeSnapshot()),
    cancel: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const transcriptContainer = { addChild: vi.fn() };
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'wukong-model',
        availableModels: {
          'wukong-model': { provider: 'openai', model: 'test' },
          'writer-model': { provider: 'openai', model: 'writer-test' },
        },
        permissionMode: overrides.permissionMode ?? 'auto',
        streamingPhase: overrides.streaming ? 'streaming' : 'idle',
        isCompacting: false,
      },
      transcriptContainer,
      ui: { requestRender: vi.fn() },
      theme: { palette: getBuiltInPalette('dark') },
    },
    session: hasSession ? session : undefined,
    skillCommandMap: new Map<string, string>(),
    harness: {
      getConfig: vi.fn(async () => ({
        defaultModel: 'wukong-model',
        models: {
          'wukong-model': { provider: 'openai', model: 'test' },
          'writer-model': { provider: 'openai', model: 'writer-test' },
        },
        providers: {
          openai: { type: 'openai', apiKey: 'test' },
        },
      })),
    },
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
    requestQueuedGoalPromotion: vi.fn(),
    cancelInFlight: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

function latestMountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls.at(-1)?.[0] as TestPicker;
}

async function confirmLoopStart(host: SlashCommandHost): Promise<void> {
  continueLoopPreflight(host);
  await vi.waitFor(() => {
    expect((host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(1);
  });
  latestMountedPicker(host).handleInput(ENTER);
}

function continueLoopPreflight(host: SlashCommandHost): void {
  const preflight = mountedPicker(host);
  preflight.handleInput(DOWN);
  preflight.handleInput(DOWN);
  preflight.handleInput(DOWN);
  preflight.handleInput(ENTER);
}

describe('parseGoalCommand', () => {
  it('treats empty and status as status', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('status')).toEqual({ kind: 'status' });
  });

  it('parses control subcommands', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('cancel')).toEqual({ kind: 'cancel' });
  });

  it('treats `clear` as an objective, not a subcommand (cancel is the remove action)', () => {
    expect(parseGoalCommand('clear')).toMatchObject({ kind: 'create', objective: 'clear' });
  });

  it('parses a plain objective', () => {
    expect(parseGoalCommand('Ship feature X')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature X',
      replace: false,
    });
  });

  it('keeps option-looking tokens as part of the objective (no goal flags)', () => {
    // Goal command flags are not parsed after `/goal`; stop conditions go in the
    // objective as natural language, so option-looking text stays objective text.
    expect(parseGoalCommand('--retry-strategy Ship feature X')).toMatchObject({
      kind: 'create',
      objective: '--retry-strategy Ship feature X',
    });
  });

  it('treats text after -- as the objective', () => {
    expect(parseGoalCommand('-- --leading-option is part of the goal')).toMatchObject({
      kind: 'create',
      objective: '--leading-option is part of the goal',
    });
    expect(parseGoalCommand('-- cancel')).toMatchObject({ kind: 'create', objective: 'cancel' });
  });

  it('parses replace as the first argument', () => {
    expect(parseGoalCommand('replace Ship feature Y')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature Y',
      replace: true,
    });
  });

  it('parses next as an upcoming-goal command', () => {
    expect(parseGoalCommand('next Ship release notes')).toEqual({
      kind: 'next-add',
      objective: 'Ship release notes',
    });
    expect(parseGoalCommand('next manage')).toEqual({ kind: 'next-manage' });
    expect(parseGoalCommand('next -- manage release notes')).toEqual({
      kind: 'next-add',
      objective: 'manage release notes',
    });
  });

  it('shows a hint for /goal next without an objective', () => {
    expect(parseGoalCommand('next')).toEqual({
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    });
  });

  it('parses --until stop conditions', () => {
    expect(parseGoalCommand('--until verify-pass fix tests')).toMatchObject({
      kind: 'create',
      objective: 'fix tests',
      stopCondition: 'proof-pass',
    });
    expect(parseGoalCommand('--until scan-clean clean up risks')).toMatchObject({
      kind: 'create',
      objective: 'clean up risks',
      stopCondition: 'proof-pass',
    });
    expect(parseGoalCommand('--until judge-pass make it mergeable')).toMatchObject({
      kind: 'create',
      objective: 'make it mergeable',
      stopCondition: 'proof-pass',
    });
  });

  it('ignores unknown --until values and keeps them in the objective', () => {
    expect(parseGoalCommand('--until unknown fix tests')).toMatchObject({
      kind: 'create',
      objective: '--until unknown fix tests',
    });
  });

  it('parses replace with --until', () => {
    expect(parseGoalCommand('replace --until verify-pass fix tests')).toMatchObject({
      kind: 'create',
      objective: 'fix tests',
      replace: true,
      stopCondition: 'proof-pass',
    });
  });

  it('rejects objectives longer than 4000 characters', () => {
    expect(parseGoalCommand('x'.repeat(4001))).toMatchObject({ kind: 'error' });
  });
});

describe('parseLoopCommand', () => {
  it('defaults to proof-pass without --until', () => {
    expect(parseLoopCommand('fix tests')).toEqual({
      kind: 'create',
      objective: 'fix tests',
      stopCondition: 'proof-pass',
      maxIterations: 10,
    });
  });

  it('allows an objective beginning with an option-like token after --', () => {
    expect(parseLoopCommand('--max-iterations 2 -- --fix-all now')).toEqual({
      kind: 'create',
      objective: '--fix-all now',
      stopCondition: 'proof-pass',
      maxIterations: 2,
    });
  });

  it('parses --until verify-pass with default max iterations', () => {
    expect(parseLoopCommand('--until verify-pass fix tests')).toEqual({
      kind: 'create',
      objective: 'fix tests',
      stopCondition: 'proof-pass',
      maxIterations: 10,
    });
  });

  it('parses --until scan-clean with custom max iterations', () => {
    expect(parseLoopCommand('--until scan-clean --max-iterations 5 clean risks')).toEqual({
      kind: 'create',
      objective: 'clean risks',
      stopCondition: 'proof-pass',
      maxIterations: 5,
    });
  });

  it('parses --every duration as minIntervalMs', () => {
    expect(parseLoopCommand('--until verify-pass --every 5m fix tests')).toEqual({
      kind: 'create',
      objective: 'fix tests',
      stopCondition: 'proof-pass',
      maxIterations: 10,
      minIntervalMs: 300_000,
    });
    expect(parseLoopCommand('--until verify-pass --every 1h --max-iterations 3 fix tests')).toEqual({
      kind: 'create',
      objective: 'fix tests',
      stopCondition: 'proof-pass',
      maxIterations: 3,
      minIntervalMs: 3_600_000,
    });
  });

  it('parses separate provider-call ceilings and token budget', () => {
    expect(parseLoopCommand(
      '--writer-call-limit 12 --reviewer-call-limit 4 --token-budget 50000 fix tests',
    )).toEqual({
      kind: 'create',
      objective: 'fix tests',
      stopCondition: 'proof-pass',
      maxIterations: 10,
      writerProviderCallLimit: 12,
      reviewerProviderCallLimit: 4,
      tokenBudget: 50000,
    });
  });

  it.each([
    '--writer-call-limit 0 fix',
    '--reviewer-call-limit 2oops fix',
    '--token-budget 1.5 fix',
  ])('rejects invalid Loop usage ceiling: %s', (args) => {
    expect(parseLoopCommand(args)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('positive integer'),
    });
  });

  it('rejects invalid --every values', () => {
    expect(parseLoopCommand('--until verify-pass --every fix tests')).toMatchObject({
      kind: 'error',
    });
    expect(parseLoopCommand('--until verify-pass --every 5x fix tests')).toMatchObject({
      kind: 'error',
    });
  });

  it('parses --until judge-pass', () => {
    expect(parseLoopCommand('--until judge-pass make mergeable')).toEqual({
      kind: 'create',
      objective: 'make mergeable',
      stopCondition: 'proof-pass',
      maxIterations: 10,
    });
  });

  it('returns status and stop subcommands', () => {
    expect(parseLoopCommand('status')).toEqual({ kind: 'status' });
    expect(parseLoopCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseLoopCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseLoopCommand('stop')).toEqual({ kind: 'stop' });
    expect(parseLoopCommand('--help')).toEqual({ kind: 'help' });
  });

  it('rejects invalid --max-iterations', () => {
    for (const value of ['abc', '0', '-1', '0.5', '3.9', '1e3', '3x']) {
      expect(parseLoopCommand(`--max-iterations ${value} fix`)).toMatchObject({ kind: 'error' });
    }
  });

  it('rejects unknown and malformed Loop options instead of treating them as objectives', () => {
    expect(parseLoopCommand('--wat fix tests')).toMatchObject({ kind: 'error' });
    expect(parseLoopCommand('--until nope fix tests')).toMatchObject({ kind: 'error' });
    expect(parseLoopCommand('--review-model')).toMatchObject({ kind: 'error' });
  });
});

describe('handleGoalCommand', () => {
  let host: SlashCommandHost;
  let session: ReturnType<typeof makeHost>['session'];

  beforeEach(() => {
    clearSessionWorkspaceTrustForTests();
    const made = makeHost();
    host = made.host;
    session = made.session;
    vi.mocked(appendGoalQueueItem).mockClear();
    vi.mocked(readGoalQueue).mockClear();
    vi.mocked(moveGoalQueueItem).mockClear();
    vi.mocked(removeGoalQueueItem).mockClear();
    vi.mocked(updateGoalQueueItem).mockClear();
  });

  it('/goal calls getGoal and does not send input', async () => {
    await handleGoalCommand(host, '');
    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith('goal_status', { status: 'none' });
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal status calls getGoal and does not send input', async () => {
    await handleGoalCommand(host, 'status');
    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal <objective> creates a goal and sends the objective as input', async () => {
    await handleGoalCommand(host, 'Ship feature X');
    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature X', replace: false }),
    );
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    expect(host.sendNormalUserInput).not.toHaveBeenCalledWith('/goal Ship feature X');
  });

  it('/goal <objective> keeps the sendNormalUserInput host receiver', async () => {
    const calls: Array<{ receiver: unknown; text: string }> = [];
    host.sendNormalUserInput = function (this: unknown, text: string): void {
      calls.push({ receiver: this, text });
    };

    await handleGoalCommand(host, 'Ship feature X');

    expect(calls).toEqual([{ receiver: host, text: 'Ship feature X' }]);
  });

  it('asks before starting a goal in Manual mode', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');

    expect(manualHost.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(s.createGoal).not.toHaveBeenCalled();
    expect(manualHost.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(manualHost).render(80).join('\n'));
    expect(text).toContain('Current mode: Manual');
    expect(text).toContain('None of these modes creates a shell or filesystem sandbox');
  });

  it('defaults to the current Manual mode when confirming a goal start', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    mountedPicker(manualHost).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(s.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(s.setPermission).not.toHaveBeenCalled();
    expect(manualHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('can start a Manual-mode goal without changing permission', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    const picker = mountedPicker(manualHost);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(s.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(s.setPermission).not.toHaveBeenCalled();
    expect(manualHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('can switch to YOLO when starting a Manual-mode goal', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    const picker = mountedPicker(manualHost);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(s.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(s.setPermission).toHaveBeenCalledWith('yolo');
    expect(manualHost.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('returns the command to the input box when a Manual-mode goal start is cancelled', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'Ship feature X');
    mountedPicker(manualHost).handleInput(ESCAPE);

    expect(manualHost.restoreInputText).toHaveBeenCalledWith('/goal Ship feature X');
    expect(manualHost.showStatus).toHaveBeenCalledWith('Goal not started.');
    expect(s.createGoal).not.toHaveBeenCalled();
  });

  it('returns the command to the input box when Do not start is selected', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'replace Ship feature Y');
    const picker = mountedPicker(manualHost);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    expect(manualHost.restoreInputText).toHaveBeenCalledWith('/goal replace Ship feature Y');
    expect(s.createGoal).not.toHaveBeenCalled();
  });

  it('asks before starting a goal in YOLO mode', async () => {
    const { host: yoloHost, session: s } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'Ship feature X');

    expect(yoloHost.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(s.createGoal).not.toHaveBeenCalled();
    expect(yoloHost.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(yoloHost).render(80).join('\n'));
    expect(text).toContain('Current mode: YOLO');
    expect(text).toContain('Keep YOLO and start');
    expect(text).toContain('Switch to safer Auto and start');
  });

  it('defaults to the current YOLO mode instead of silently changing it', async () => {
    const { host: yoloHost, session: s } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'Ship feature X');
    mountedPicker(yoloHost).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(s.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(s.setPermission).not.toHaveBeenCalled();
    expect(yoloHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('can keep YOLO when starting a YOLO-mode goal', async () => {
    const { host: yoloHost, session: s } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'Ship feature X');
    const picker = mountedPicker(yoloHost);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(s.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(s.setPermission).not.toHaveBeenCalled();
    expect(yoloHost.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('returns the command to the input box when a YOLO-mode goal start is cancelled', async () => {
    const { host: yoloHost, session: s } = makeHost({ permissionMode: 'yolo' });

    await handleGoalCommand(yoloHost, 'replace Ship feature Y');
    const picker = mountedPicker(yoloHost);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    expect(yoloHost.restoreInputText).toHaveBeenCalledWith('/goal replace Ship feature Y');
    expect(s.createGoal).not.toHaveBeenCalled();
  });

  it('does not pass budget limits (flags were removed)', async () => {
    await handleGoalCommand(host, 'Ship feature X');
    const arg = (session.createGoal as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg).not.toHaveProperty('budgetLimits');
  });

  it('rejects too-long objectives before any SDK call', async () => {
    await handleGoalCommand(host, 'x'.repeat(4001));
    expect(host.showError).toHaveBeenCalled();
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('/goal replace passes replace: true', async () => {
    await handleGoalCommand(host, 'replace Ship feature Y');
    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature Y', replace: true }),
    );
  });

  it('/goal next queues an upcoming goal and does not send it to the agent', async () => {
    session.getGoal.mockResolvedValueOnce({ goal: fakeSnapshot() });

    await handleGoalCommand(host, 'next Ship release notes');

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(appendGoalQueueItem).toHaveBeenCalledWith(session, {
      objective: 'Ship release notes',
    });
    expect(host.track).toHaveBeenCalledWith('goal_queue_append');
    expect(host.showStatus).not.toHaveBeenCalledWith(
      'Upcoming goal added. It will start after the current goal is complete.',
    );
    const addChild = host.state.transcriptContainer.addChild as ReturnType<typeof vi.fn>;
    const message = addChild.mock.calls[0]?.[0] as { render(width: number): string[] };
    expect(stripAnsi(message.render(80).join('\n'))).toBe(
      '\n● Upcoming goal added. It will start after the current goal is complete.',
    );
    expect(host.state.ui.requestRender).toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('/goal next starts immediately when there is no current goal', async () => {
    await handleGoalCommand(host, 'next Ship release notes');

    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(appendGoalQueueItem).not.toHaveBeenCalled();
    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship release notes', replace: false }),
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      'No active goal. Starting this goal now.',
    );
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship release notes');
  });

  it('/goal next queues instead of starting immediately while streaming with no current goal', async () => {
    const { host: streamingHost, session: s } = makeHost({ streaming: true });

    await handleGoalCommand(streamingHost, 'next Ship release notes');

    expect(s.getGoal).toHaveBeenCalledOnce();
    expect(appendGoalQueueItem).toHaveBeenCalledWith(s, {
      objective: 'Ship release notes',
    });
    expect(streamingHost.requestQueuedGoalPromotion).toHaveBeenCalledOnce();
    expect(s.createGoal).not.toHaveBeenCalled();
    expect(streamingHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal next follows the normal goal-start prompt when there is no current goal', async () => {
    const { host: manualHost, session: s } = makeHost({ permissionMode: 'manual' });

    await handleGoalCommand(manualHost, 'next Ship release notes');

    expect(s.getGoal).toHaveBeenCalledOnce();
    expect(appendGoalQueueItem).not.toHaveBeenCalled();
    expect(manualHost.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(s.createGoal).not.toHaveBeenCalled();

    mountedPicker(manualHost).handleInput(ESCAPE);
    expect(manualHost.restoreInputText).toHaveBeenCalledWith('/goal next Ship release notes');
  });

  it('/goal next does not require a configured model when queueing after a current goal', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });
    s.getGoal.mockResolvedValueOnce({ goal: fakeSnapshot() });

    await handleGoalCommand(noModelHost, 'next Ship release notes');

    expect(appendGoalQueueItem).toHaveBeenCalledWith(s, {
      objective: 'Ship release notes',
    });
    expect(noModelHost.showError).not.toHaveBeenCalled();
  });

  it('/goal next requires a configured model when it starts immediately', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });

    await handleGoalCommand(noModelHost, 'next Ship release notes');

    expect(s.getGoal).toHaveBeenCalledOnce();
    expect(appendGoalQueueItem).not.toHaveBeenCalled();
    expect(s.createGoal).not.toHaveBeenCalled();
    expect(noModelHost.showError).toHaveBeenCalled();
  });

  it('/goal next manage opens the upcoming goal manager without sending input', async () => {
    await handleGoalCommand(host, 'next manage');

    expect(readGoalQueue).toHaveBeenCalledWith(session);
    expect(host.track).toHaveBeenCalledWith('goal_queue_manage');
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const text = stripAnsi(mountedPicker(host).render(100).join('\n'));
    expect(text).toContain('Upcoming goals');
    expect(text).toContain('First queued goal');
    expect(text).toContain('Second queued goal');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('/goal next manage reorders goals through the queue store', async () => {
    await handleGoalCommand(host, 'next manage');
    const manager = mountedPicker(host);

    manager.handleInput(DOWN);
    manager.handleInput(' ');
    manager.handleInput(UP);

    await vi.waitFor(() => {
      expect(moveGoalQueueItem).toHaveBeenCalledWith(session, {
        goalId: 'q2',
        direction: 'up',
      });
    });
  });

  it('/goal next manage removes goals through the queue store', async () => {
    await handleGoalCommand(host, 'next manage');

    mountedPicker(host).handleInput('d');

    await vi.waitFor(() => {
      expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
    });
  });

  it('/goal next manage edits goals through the queue store', async () => {
    await handleGoalCommand(host, 'next manage');

    mountedPicker(host).handleInput('e');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    });
    const editDialog = latestMountedPicker(host);
    editDialog.handleInput(' updated');
    editDialog.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(updateGoalQueueItem).toHaveBeenCalledWith(session, {
        goalId: 'q1',
        objective: 'First queued goal updated',
      });
    });
  });

  it('surfaces duplicate-goal errors with replace guidance', async () => {
    session.createGoal.mockRejectedValueOnce(
      new WukongError(ErrorCodes.GOAL_ALREADY_EXISTS, 'exists'),
    );
    await handleGoalCommand(host, 'Ship feature X');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('/goal replace'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal pause calls pauseGoal and does not send input', async () => {
    await handleGoalCommand(host, 'pause');
    expect(session.pauseGoal).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith('goal_pause');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal pause cancels an active stream', async () => {
    const { host: streamingHost, session: s } = makeHost({ streaming: true });
    await handleGoalCommand(streamingHost, 'pause');
    expect(s.pauseGoal).toHaveBeenCalledOnce();
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  it('/goal resume calls resumeGoal and sends a resume input', async () => {
    await handleGoalCommand(host, 'resume');
    expect(session.resumeGoal).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith('goal_resume');
    expect(host.showStatus).not.toHaveBeenCalledWith('Goal resumed.');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Resume the active goal.');
  });

  it('/goal resume reconfirms exact broker and provider consent for a Loop', async () => {
    session.getGoal.mockResolvedValueOnce({
      goal: {
        ...fakeSnapshot(),
        status: 'blocked',
        reviewModel: 'wukong-model',
        loopContract: {
          schemaVersion: 2,
          workspaceIdentity: {
            canonicalRealpath: '/workspace',
            workspaceIdentityDigest: 'sha256:workspace',
          },
        },
      },
    } as never);

    const running = handleGoalCommand(host, 'resume');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    });
    mountedPicker(host).handleInput(ENTER);
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    });
    latestMountedPicker(host).handleInput(ENTER);
    await running;

    expect(session.resumeGoal).toHaveBeenCalledWith({
      reviewSettings: expect.objectContaining({
        brokerReviewTrust: expect.objectContaining({
          trustGrantId: expect.any(String),
        }),
        reviewSubjectConsent: expect.objectContaining({
          consentDigest: 'sha256:consent-binding',
        }),
      }),
    });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Resume the active goal.');
  });

  it('/goal resume consent cancellation keeps the Loop stopped', async () => {
    session.getGoal.mockResolvedValueOnce({
      goal: {
        ...fakeSnapshot(),
        status: 'blocked',
        loopContract: {
          schemaVersion: 2,
          workspaceIdentity: {
            canonicalRealpath: '/workspace',
            workspaceIdentityDigest: 'sha256:workspace',
          },
        },
      },
    } as never);

    const running = handleGoalCommand(host, 'resume');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    });
    mountedPicker(host).handleInput(ENTER);
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    });
    latestMountedPicker(host).handleInput(DOWN);
    latestMountedPicker(host).handleInput(ENTER);
    await running;

    expect(session.resumeGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Loop remains stopped. No review input was sent.',
    );
  });

  it('/goal cancel calls cancelGoal and does not send input', async () => {
    await handleGoalCommand(host, 'cancel');
    expect(session.cancelGoal).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith('goal_cancel');
    expect(host.showNotice).toHaveBeenCalledWith('Goal cancelled.');
    expect(host.showStatus).not.toHaveBeenCalledWith('Goal cancelled.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal cancel cancels an active stream', async () => {
    const { host: streamingHost, session: s } = makeHost({ streaming: true });
    await handleGoalCommand(streamingHost, 'cancel');
    expect(s.cancelGoal).toHaveBeenCalledOnce();
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  // No-goal control commands all read as calm status messages, never red errors.
  it('pausing with no goal shows a friendly status, not an error', async () => {
    session.pauseGoal.mockRejectedValueOnce(new WukongError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal'));
    await handleGoalCommand(host, 'pause');
    expect(host.showStatus).toHaveBeenCalledWith('No goal to pause.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('resuming with no goal shows a friendly status, not an error', async () => {
    session.resumeGoal.mockRejectedValueOnce(new WukongError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal'));
    await handleGoalCommand(host, 'resume');
    expect(host.showStatus).toHaveBeenCalledWith('No goal to resume.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('`replace` with no objective is a hint (status), not an error', async () => {
    await handleGoalCommand(host, 'replace');
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('Provide a goal objective'));
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('status/pause/cancel work without a configured model', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'status');
    await handleGoalCommand(noModelHost, 'pause');
    await handleGoalCommand(noModelHost, 'cancel');
    expect(s.getGoal).toHaveBeenCalled();
    expect(s.pauseGoal).toHaveBeenCalled();
    expect(s.cancelGoal).toHaveBeenCalled();
    expect(noModelHost.showError).not.toHaveBeenCalled();
  });

  it('resume without a configured model does not activate the goal', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'resume');
    expect(noModelHost.showError).toHaveBeenCalled();
    expect(s.resumeGoal).not.toHaveBeenCalled();
    expect(noModelHost.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('creation without a configured model shows LLM_NOT_SET_MESSAGE', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'Ship feature X');
    expect(noModelHost.showError).toHaveBeenCalled();
    expect(s.createGoal).not.toHaveBeenCalled();
  });

  it('creation without an active session shows LLM_NOT_SET_MESSAGE', async () => {
    const { host: noSessionHost, session: s } = makeHost({ hasSession: false });
    await handleGoalCommand(noSessionHost, 'Ship feature X');
    expect(noSessionHost.showError).toHaveBeenCalled();
    expect(s.createGoal).not.toHaveBeenCalled();
  });
});

describe('dispatchInput /goal integration', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('routes /goal through the real resolver, creates the goal, and sends the objective', async () => {
    const { host, session } = makeHost();

    dispatchInput(host, '/goal Ship feature X');

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    expect(host.sendNormalUserInput).not.toHaveBeenCalledWith('/goal Ship feature X');
  });
});

describe('handleLoopSlashCommand', () => {
  beforeEach(() => {
    clearSessionWorkspaceTrustForTests();
    vi.clearAllMocks();
    loopLifecycleMocks.begin.mockResolvedValue({ runId: 'run123' });
    loopPreflightMocks.run.mockImplementation(
      async (input?: { objective: string }) => loopPreflightReady(input?.objective ?? ''),
    );
  });

  it('creates a loop goal with stop condition, max iterations, and min interval', async () => {
    const { host, session } = makeHost();

    await handleLoopSlashCommand(host, '--until verify-pass --every 5m --max-iterations 3 fix tests');
    await confirmLoopStart(host);
    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalled();
    });

    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: 'fix tests',
        stopCondition: 'proof-pass',
        maxIterations: 3,
        minIntervalMs: 300_000,
      }),
    );
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('fix tests');
    expect(loopLifecycleMocks.register).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ runId: 'run123' }),
      expect.any(String),
      '/workspace',
    );
  });

  it('does not cap an interactive BYOK Loop below the requested local limit', async () => {
    const { host, session } = makeHost();

    await handleLoopSlashCommand(host, '--max-iterations 12 fix tests');
    await confirmLoopStart(host);
    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalled();
    });

    expect(session.createGoal).toHaveBeenCalledWith(expect.objectContaining({
      maxIterations: 12,
    }));
  });

  it('edits the writer model in Preflight but switches only after final approval', async () => {
    const { host, session } = makeHost();

    await handleLoopSlashCommand(host, 'fix tests');
    const preflight = mountedPicker(host);
    preflight.handleInput(DOWN);
    preflight.handleInput(ENTER);

    const editor = latestMountedPicker(host);
    editor.handleInput('\t');
    for (let index = 0; index < 'wukong-model'.length; index += 1) {
      editor.handleInput(RIGHT);
    }
    for (let index = 0; index < 'wukong-model'.length; index += 1) {
      editor.handleInput('\u007F');
    }
    for (const character of 'writer-model') editor.handleInput(character);
    for (let index = 0; index < 5; index += 1) editor.handleInput('\t');
    editor.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(loopPreflightMocks.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: 'writer-model' }),
      );
    });
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.createGoal).not.toHaveBeenCalled();

    const revisedPreflight = latestMountedPicker(host);
    revisedPreflight.handleInput(DOWN);
    revisedPreflight.handleInput(DOWN);
    revisedPreflight.handleInput(DOWN);
    revisedPreflight.handleInput(ENTER);
    await vi.waitFor(() => {
      expect((host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(3);
    });
    latestMountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalled();
    });
    expect(session.setModel).toHaveBeenCalledWith('writer-model');
    expect(host.setAppState).toHaveBeenCalledWith({ model: 'writer-model' });
    expect(session.setModel.mock.invocationCallOrder[0])
      .toBeLessThan(session.createGoal.mock.invocationCallOrder[0]!);
  });

  it('does not create a local lifecycle record when Loop preflight is blocked', async () => {
    loopPreflightMocks.run.mockResolvedValueOnce({
      ready: false,
      reason: 'Another Goal is already active.',
      next: 'Resume or cancel it.',
    } as never);
    const { host, session } = makeHost();

    await handleLoopSlashCommand(host, 'fix tests');

    expect(loopLifecycleMocks.begin).not.toHaveBeenCalled();
    expect(session.createGoal).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Another Goal'));
  });

  it('reviews bounded pre-existing workspace paths and returns to consolidated preflight', async () => {
    loopPreflightMocks.run.mockResolvedValue({
      ...loopPreflightReady('fix tests'),
      workspaceGit: {
        isRepo: true,
        changedFileCount: 7,
        changedFiles: [
          { status: 'M', path: 'src/one.ts' },
          { status: 'A', path: 'src/two.ts' },
          { status: '??', path: 'test/three.test.ts' },
          { status: 'D', path: 'docs/four.md' },
          { status: 'M', path: 'packages/five.ts' },
        ],
      },
    } as never);
    const { host, session } = makeHost();

    await handleLoopSlashCommand(host, 'fix tests');
    const preflight = mountedPicker(host);
    expect(stripAnsi(preflight.render(80).join('\n')))
      .toContain('Review pre-existing workspace changes');
    preflight.handleInput(DOWN);
    preflight.handleInput(ENTER);

    const workspace = latestMountedPicker(host);
    const text = stripAnsi(workspace.render(80).join('\n'));
    expect(text).toContain('Pre-existing workspace changes');
    expect(text).toContain('M src/one.ts');
    expect(text).toContain('2 additional paths');
    workspace.handleInput(ESCAPE);
    expect(stripAnsi(latestMountedPicker(host).render(80).join('\n'))).toContain('Loop preflight');
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('does not create an orphan local lifecycle record when goal creation fails', async () => {
    const { host, session } = makeHost();
    session.createGoal.mockRejectedValueOnce(new Error('goal store unavailable'));

    await handleLoopSlashCommand(host, 'fix tests');
    await confirmLoopStart(host);
    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });

    expect(loopLifecycleMocks.begin).not.toHaveBeenCalled();
    expect(loopLifecycleMocks.completeRun).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('rejects an invalid --every duration', async () => {
    const { host, session } = makeHost();

    await handleLoopSlashCommand(host, '--until verify-pass --every 5x fix tests');

    expect(session.createGoal).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalled();
  });

  it('does not let /loop stop cancel an ordinary Goal', async () => {
    const { host, session } = makeHost();
    session.getGoal.mockResolvedValueOnce({ goal: fakeSnapshot() });

    await handleLoopSlashCommand(host, 'stop');

    expect(session.cancelGoal).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'No Loop is active. The current Goal was left unchanged.',
    );
  });

  it('uses Loop-specific resume guidance after /loop pause', async () => {
    const { host, session } = makeHost();
    session.getGoal.mockResolvedValue({
      goal: { ...fakeSnapshot(), stopCondition: 'proof-pass' } as never,
    });

    await handleLoopSlashCommand(host, 'pause');

    expect(session.pauseGoal).toHaveBeenCalledOnce();
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('/loop resume'));
  });

  it('cancels only an actual Loop', async () => {
    const { host, session } = makeHost();
    session.getGoal.mockResolvedValue({
      goal: { ...fakeSnapshot(), stopCondition: 'proof-pass' } as never,
    });

    await handleLoopSlashCommand(host, 'stop');

    expect(session.cancelGoal).toHaveBeenCalledOnce();
    expect(loopLifecycleMocks.stop).toHaveBeenCalledWith('g1', 0);
    expect(host.showNotice).toHaveBeenCalledWith(expect.stringContaining('STOPPED_BY_USER'));
    expect(host.showNotice).toHaveBeenCalledWith(expect.stringContaining('start a new /loop'));
  });

  it('restores the original /loop command when permission confirmation is cancelled', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleLoopSlashCommand(host, '--max-iterations 3 fix tests');
    continueLoopPreflight(host);
    latestMountedPicker(host).handleInput(ENTER);
    latestMountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/loop --max-iterations 3 fix tests');
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('rolls permission mode back when Loop creation fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });
    session.createGoal.mockRejectedValueOnce(new Error('goal store unavailable'));

    await handleLoopSlashCommand(host, 'fix tests');
    continueLoopPreflight(host);
    await vi.waitFor(() => {
      expect((host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(1);
    });
    latestMountedPicker(host).handleInput(ENTER);
    await vi.waitFor(() => {
      expect((host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(2);
    });
    latestMountedPicker(host).handleInput(DOWN);
    latestMountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.setPermission).toHaveBeenNthCalledWith(1, 'auto');
      expect(session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
    });
    expect(host.state.appState.permissionMode).toBe('manual');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});

describe('goalArgumentCompletions', () => {
  function values(prefix: string): string[] | null {
    const items = goalArgumentCompletions(prefix);
    return items === null ? null : items.map((i) => i.value);
  }

  function labels(prefix: string): string[] | null {
    const items = goalArgumentCompletions(prefix);
    return items === null ? null : items.map((i) => i.label);
  }

  it('offers every subcommand for an empty prefix', () => {
    expect(values('')).toEqual(['status', 'pause', 'resume', 'cancel', 'replace', 'next']);
  });

  it('prefix-filters subcommands case-insensitively', () => {
    expect(values('pa')).toEqual(['pause']);
    expect(values('RE')).toEqual(['resume', 'replace']);
  });

  it('returns items whose value/label are the token itself', () => {
    const items = goalArgumentCompletions('paus');
    expect(items).toEqual([
      { value: 'pause', label: 'pause', description: 'Pause the active goal' },
    ]);
  });

  it('suppresses the menu once a token is fully typed and unambiguous', () => {
    // `status` is the sole match and equals the prefix exactly, so there is
    // nothing left to complete: the menu hides and Enter submits `/goal status`
    // instead of confirming a no-op completion.
    expect(values('status')).toBeNull();
    expect(values('pause')).toBeNull();
    // `re` still has two completions, so the menu stays open.
    expect(values('re')).toEqual(['resume', 'replace']);
  });

  it('stops completing once past the first token (space typed)', () => {
    expect(values('pause ')).toBeNull();
    expect(values('replace Ship feature')).toBeNull();
    expect(values('next Ship feature')).toBeNull();
  });

  it('completes /goal next manage as the second token', () => {
    expect(values('next ')).toEqual(['next manage']);
    expect(values('next m')).toEqual(['next manage']);
    expect(values('next MA')).toEqual(['next manage']);
    expect(labels('next m')).toEqual(['manage']);
    expect(values('next manage')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(values('zzz')).toBeNull();
    expect(values('next ship')).toBeNull();
  });
});
