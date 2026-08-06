import type { createWukongDeviceId as createWukongDeviceIdFn } from '@wukong/wukong-oauth';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { runPrompt } from '#/cli/run-prompt';
import type { HeadlessGoalCreate } from '#/cli/goal-prompt';
import type { LoopPreflightResult } from '#/cli/lib/loop-preflight';

type CreateWukongDeviceId = typeof createWukongDeviceIdFn;

const mocks = vi.hoisted(() => {
  const eventHandlers = new Set<(event: any) => void>();
  const agentEvent = (agentId: string, event: Record<string, unknown>) => ({
    sessionId: 'ses_prompt',
    agentId,
    ...event,
  });
  const mainEvent = (event: Record<string, unknown>) => agentEvent('main', event);
  const session = {
    id: 'ses_prompt',
    setModel: vi.fn(),
    setPermission: vi.fn(),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    cancel: vi.fn(),
    createGoal: vi.fn(),
    getGoal: vi.fn(async (): Promise<{ goal: any }> => ({ goal: null })),
    getStatus: vi.fn(
      async (): Promise<{ readonly permission: string; readonly model?: string }> => ({
        permission: 'manual',
      }),
    ),
    getUsage: vi.fn(async () => ({
      total: {
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    })),
    onEvent: vi.fn((handler: (event: any) => void) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    }),
    prompt: vi.fn(async () => {
      for (const handler of eventHandlers) {
        handler(
          mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }),
        );
        handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'hello' }));
        handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: ' world' }));
        handler(mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    }),
  };
  const finishLineProposal = {
    schemaVersion: 1 as const,
    objective: 'fix tests',
    constraints: [],
    finishLineReview: {
      schemaVersion: 1 as const,
      warningPolicyVersion: 'test',
      finishLineDigest: 'sha256:finish',
      warnings: [],
      warningSetDigest: 'sha256:warnings',
      acknowledgedWarningIds: [],
    },
    workspaceIdentity: {
      canonicalRealpath: process.cwd(),
      filesystemIdentity: 'test',
      workspaceIdentityDigest: 'sha256:workspace',
    },
    gateApproval: {
      schemaVersion: 1 as const,
      gatePlanDigest: 'sha256:plan',
      warningSetDigest: 'sha256:warnings',
      guardPolicyVersion: 'test',
      orderedChecks: [],
      approvalSetDigest: 'sha256:approval',
      hasExecutableChecks: false as const,
    },
    gatePlan: {
      schemaVersion: 1 as const,
      stopCondition: 'proof-pass' as const,
      requiredChecks: [],
      excludedChecks: [],
      builtinRiskScanPolicyVersion: 'test',
      planDigest: 'sha256:plan',
    },
    reviewPolicy: { mode: 'advisory-live' as const },
  };
  const preflightReady = {
    ready: true as const,
    model: 'k2',
    workspace: process.cwd(),
    checks: ['pnpm test'],
    proposal: finishLineProposal,
    trustChallenge: 'challenge',
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
      trustProposalDigest: 'sha256:broker-trust',
    },
    brokerReviewTrust: {
      trustGrantId: 'broker-grant',
      workspaceIdentityDigest: 'sha256:workspace',
      scope: 'brokered-review-subject' as const,
      trustProposalDigest: 'sha256:broker-trust',
    },
    reviewSubjectConsentProposal: {
      schemaVersion: 1 as const,
      workspaceIdentityDigest: 'sha256:workspace',
      reviewSubjectPolicyVersion: 'review-subject/1',
      hardExclusionPolicyVersion: 'review-subject-hard-exclusion/1',
      allowedOrigins: ['changed-tracked'] as const,
      limits: {
        maxFiles: 500,
        maxTotalBytes: 4_194_304,
        maxFileBytes: 262_144,
        maxGateEvidenceTotalBytes: 1_048_576,
        maxGateEvidenceBytes: 131_072,
      },
      provider: {
        providerId: 'example',
        endpointOrigin: { scheme: 'https' as const, host: 'example.test', port: 443 },
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
        maxFiles: 500,
        maxTotalBytes: 4_194_304,
        maxFileBytes: 262_144,
        maxGateEvidenceTotalBytes: 1_048_576,
        maxGateEvidenceBytes: 131_072,
      },
      provider: {
        providerId: 'example',
        endpointOriginDigest: 'sha256:origin',
      },
      consentProposalDigest: 'sha256:consent',
      acknowledgedAt: 1,
      consentDigest: 'sha256:consent-binding',
    },
  } satisfies Extract<LoopPreflightResult, { ready: true }>;

  return {
    session,
    finishLineProposal,
    preflightReady,
    eventHandlers,
    agentEvent,
    mainEvent,
    wukongHarnessConstructor: vi.fn(),
    harnessEnsureConfigFile: vi.fn(),
    harnessGetConfig: vi.fn(
      async (): Promise<{ providers: {}; defaultModel?: string; telemetry: boolean }> => ({
        providers: {},
        defaultModel: 'k2',
        telemetry: true,
      }),
    ),
    harnessGetConfigDiagnostics: vi.fn(async () => ({ warnings: [] as readonly string[] })),
    harnessGetExperimentalFeatures: vi.fn(async () => []),
    harnessCreateSession: vi.fn(async () => session),
    harnessResumeSession: vi.fn(async () => session),
    harnessListSessions: vi.fn(async () => [{ id: 'ses_previous', workDir: process.cwd() }]),
    harnessClose: vi.fn(),
    harnessTrack: vi.fn(),
    harnessGetCachedAccessToken: vi.fn(),
    initializeTelemetry: vi.fn(),
    setCrashPhase: vi.fn(),
    shutdownTelemetry: vi.fn(),
    telemetryTrack: vi.fn(),
    setTelemetryContext: vi.fn(),
    lifecycleTrack: vi.fn(),
    withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
    createWukongDeviceId: vi.fn<CreateWukongDeviceId>(() => 'device-1'),
    resolveWukongHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/wukong-test-home'),
    harnessCreatesDeviceIdOnConstruction: false,
    createCliTelemetryBootstrap: vi.fn(() => ({
      homeDir: '/tmp/wukong-test-home',
      deviceId: 'device-1',
      firstLaunch: false,
    })),
    initializeCliTelemetry: vi.fn(),
    createWukongCodeHostIdentity: vi.fn((version: string) => ({
      userAgentProduct: 'wukong-code',
      version,
    })),
    parseHeadlessGoalCreate: vi.fn(() => undefined) as Mock<
      (prompt: string) => HeadlessGoalCreate | undefined
    >,
    goalSummaryJson: vi.fn((snapshot: any) => snapshot),
    formatGoalSummaryText: vi.fn((snapshot: any) => `Goal [${snapshot?.status ?? 'none'}]`),
    goalExitCode: vi.fn(() => 0),
    beginLoopRun: vi.fn(async () => ({ runId: 'run123' })),
    completeLoopRun: vi.fn(async () => ({ repeatedCompletedWithin7d: false })),
    stopLoopRun: vi.fn(async () => {}),
    registerTuiLoop: vi.fn(async () => {}),
    runLoopPreflight: vi.fn<() => Promise<LoopPreflightResult>>(
      async () => preflightReady,
    ),
    inspectGit: vi.fn(async () => ({
      cwd: process.cwd(),
      isRepo: true,
      root: process.cwd(),
      statusText: '',
      diffText: '',
      diffStat: '',
      changedFiles: [],
    })),
  };
});

vi.mock('@wukong/verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wukong/verification')>();
  return { ...actual, inspectGit: mocks.inspectGit };
});

vi.mock('@wukong/wukong-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wukong/wukong-sdk')>();
  return {
    ...actual,
    resolveWukongHome: mocks.resolveWukongHome,
    createWukongHarness: (...args: unknown[]) => {
      const options = args[0] as { readonly homeDir?: string } | undefined;
      const homeDir = options?.homeDir ?? '/tmp/wukong-test-home';
      if (mocks.harnessCreatesDeviceIdOnConstruction) {
        mocks.createWukongDeviceId(homeDir);
      }
      mocks.wukongHarnessConstructor(...args);
      return {
        homeDir,
        auth: { getCachedAccessToken: mocks.harnessGetCachedAccessToken },
        ensureConfigFile: mocks.harnessEnsureConfigFile,
        getConfig: mocks.harnessGetConfig,
        getConfigDiagnostics: mocks.harnessGetConfigDiagnostics,
        getExperimentalFeatures: mocks.harnessGetExperimentalFeatures,
        createSession: mocks.harnessCreateSession,
        resumeSession: mocks.harnessResumeSession,
        listSessions: mocks.harnessListSessions,
        close: mocks.harnessClose,
        track: mocks.harnessTrack,
      };
    },
  };
});

vi.mock('@wukong/wukong-oauth', async () => {
  const actual = await vi.importActual<typeof import('@wukong/wukong-oauth')>(
    '@wukong/wukong-oauth',
  );
  return {
    ...actual,
    createWukongDeviceId: mocks.createWukongDeviceId,
    WUKONG_CODE_PROVIDER_NAME: 'wukong',
  };
});

vi.mock('@wukong/wukong-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setCrashPhase: mocks.setCrashPhase,
  shutdownTelemetry: mocks.shutdownTelemetry,
  track: mocks.telemetryTrack,
  setTelemetryContext: mocks.setTelemetryContext,
  withTelemetryContext: mocks.withTelemetryContext,
}));

vi.mock('#/cli/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/telemetry')>();
  mocks.createCliTelemetryBootstrap.mockImplementation(() => actual.createCliTelemetryBootstrap());
  mocks.initializeCliTelemetry.mockImplementation((options) => {
    actual.initializeCliTelemetry(options);
  });
  return {
    ...actual,
    createCliTelemetryBootstrap: mocks.createCliTelemetryBootstrap,
    initializeCliTelemetry: mocks.initializeCliTelemetry,
  };
});

vi.mock('#/cli/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/version')>();
  return {
    ...actual,
    createWukongCodeHostIdentity: mocks.createWukongCodeHostIdentity,
  };
});

vi.mock('#/cli/goal-prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/goal-prompt')>();
  return {
    ...actual,
    parseHeadlessGoalCreate: mocks.parseHeadlessGoalCreate,
    goalSummaryJson: mocks.goalSummaryJson,
    formatGoalSummaryText: mocks.formatGoalSummaryText,
    goalExitCode: mocks.goalExitCode,
  };
});

vi.mock('#/cli/lib/loop-lifecycle', () => ({
  beginLoopRun: mocks.beginLoopRun,
  completeLoopRun: mocks.completeLoopRun,
  registerTuiLoop: mocks.registerTuiLoop,
  stopLoopRun: mocks.stopLoopRun,
}));

vi.mock('#/cli/lib/loop-preflight', () => ({
  runLoopPreflight: mocks.runLoopPreflight,
  resolveLoopReviewProvider: () => ({
    providerId: 'example',
    endpoint: 'https://example.test',
  }),
  formatLoopPreflightBlocked: (result: { reason: string; next: string }) =>
    `Loop not started\nReason   ${result.reason}\nNext     ${result.next}`,
  formatLoopPreflightReady: (_result: unknown, maxIterations: number) =>
    `Ready to start Loop\nLimit    up to ${String(maxIterations)} iterations`,
}));

function opts(overrides: Partial<Parameters<typeof runPrompt>[0]> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'say hello',
    skillsDirs: [],
    addDirs: [],
    ...overrides,
  };
}

function writer(columns?: number) {
  let text = '';
  return {
    columns,
    write: vi.fn((chunk: string) => {
      text += chunk;
      return true;
    }),
    text: () => text,
  };
}

function fakeProcess() {
  const listeners = new Map<NodeJS.Signals, () => Promise<void> | void>();
  return {
    once: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
      listeners.set(signal, listener);
    }),
    off: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
      if (listeners.get(signal) === listener) {
        listeners.delete(signal);
      }
    }),
    exit: vi.fn(),
    listener: (signal: NodeJS.Signals) => listeners.get(signal),
  };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('runPrompt', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.eventHandlers.clear();
    mocks.createWukongDeviceId.mockImplementation(() => 'device-1');
    mocks.resolveWukongHome.mockImplementation(
      (homeDir?: string) => homeDir ?? '/tmp/wukong-test-home',
    );
    mocks.harnessCreatesDeviceIdOnConstruction = false;
    mocks.parseHeadlessGoalCreate.mockReturnValue(undefined);
    mocks.session.createGoal.mockResolvedValue({
      goalId: 'goal-default',
      loopRunId: 'core-run-default',
    });
    mocks.goalSummaryJson.mockImplementation((snapshot: any) => snapshot);
    mocks.formatGoalSummaryText.mockImplementation(
      (snapshot: any) => `Goal [${snapshot?.status ?? 'none'}]`,
    );
    mocks.goalExitCode.mockReturnValue(0);
    mocks.beginLoopRun.mockResolvedValue({ runId: 'run123' });
    mocks.runLoopPreflight.mockResolvedValue(mocks.preflightReady);
    mocks.createWukongCodeHostIdentity.mockImplementation((version: string) => ({
      userAgentProduct: 'wukong-code',
      version,
    }));
  });

  it('keeps a safe durable permission and elevates only for the headless process', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ skillsDirs: ['/skills'] }), '1.2.3-test', { stdout, stderr });

    expect(mocks.wukongHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ skillDirs: ['/skills'], uiMode: 'print' }),
    );
    expect(mocks.harnessCreateSession).toHaveBeenCalledWith({
      workDir: process.cwd(),
      model: 'k2',
      permission: 'manual',
      additionalDirs: undefined,
    });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto', { transient: true });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
    expect(mocks.session.setApprovalHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.session.setQuestionHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.session.prompt).toHaveBeenCalledWith('say hello');
    expect(stdout.text()).toBe('• hello world\n\n');
    expect(stderr.text()).toContain('Run preflight');
    expect(stderr.text()).toContain('Outcome    COMPLETED');
    expect(stderr.text()).toContain('Resume     wukong -r ses_prompt');
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('stops prompt startup when session creation fails', async () => {
    const stdout = writer();
    const stderr = writer();
    mocks.harnessCreateSession.mockRejectedValueOnce(new Error('Git Bash missing'));

    await expect(runPrompt(opts(), '1.2.3-test', { stdout, stderr })).rejects.toThrow(
      'Git Bash missing',
    );

    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledOnce();
    expect(mocks.harnessGetConfig).toHaveBeenCalledOnce();
    expect(mocks.harnessCreateSession).toHaveBeenCalledOnce();
    expect(mocks.session.prompt).not.toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalledOnce();
  });

  it('uses the CLI model override when creating a fresh prompt session', async () => {
    await runPrompt(opts({ model: 'wukong/k2.5' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessCreateSession).toHaveBeenCalledWith({
      workDir: process.cwd(),
      model: 'wukong/k2.5',
      permission: 'manual',
      additionalDirs: undefined,
    });
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'wukong/k2.5' }),
    );
  });

  it('passes the CLI additional directory when creating a fresh prompt session', async () => {
    await runPrompt(opts({ addDirs: ['../shared', '/tmp/extra'] }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessCreateSession).toHaveBeenCalledWith({
      workDir: process.cwd(),
      model: 'k2',
      permission: 'manual',
      additionalDirs: ['../shared', '/tmp/extra'],
    });
  });

  it('tracks first launch in prompt mode before harness construction can create the device id', async () => {
    mocks.harnessCreatesDeviceIdOnConstruction = true;
    const createdHomes = new Set<string>();
    mocks.createWukongDeviceId.mockImplementation((homeDir, options) => {
      const deviceId = `device-for-${homeDir}`;
      if (!createdHomes.has(homeDir)) {
        createdHomes.add(homeDir);
        options?.onFirstLaunch?.(deviceId);
      }
      return deviceId;
    });

    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.createWukongDeviceId).toHaveBeenNthCalledWith(
      1,
      '/tmp/wukong-test-home',
      expect.objectContaining({ onFirstLaunch: expect.any(Function) }),
    );
    expect(mocks.createWukongDeviceId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wukongHarnessConstructor.mock.invocationCallOrder[0]!,
    );
    expect(mocks.wukongHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/tmp/wukong-test-home' }),
    );
    expect(mocks.harnessTrack).toHaveBeenCalledWith('first_run');
  });

  it('formats thinking and assistant output as transcript blocks', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 3, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'thinking.delta',
            turnId: 3,
            delta: 'The user wants an exact reply.',
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'thinking.delta',
            turnId: 3,
            delta: '\nNo tools are needed.',
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 3, delta: 'prompt-mode-ok' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 3, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain('• The user wants an exact reply.\n  No tools are needed.\n\n');
    expect(stderr.text()).toContain('Outcome    COMPLETED');
    expect(stdout.text()).toBe('• prompt-mode-ok\n\n');
    expect(stderr.write).toHaveBeenCalledWith('• The user wants an exact reply.');
    expect(stderr.write).toHaveBeenCalledWith('\n  No tools are needed.');
    expect(stdout.write).toHaveBeenNthCalledWith(1, '• prompt-mode-ok');
  });

  it('formats hook results as their own transcript block', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 3, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'hook.result',
            turnId: 3,
            hookEvent: 'UserPromptSubmit',
            content: '{}',
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 3, delta: 'answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 3, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• UserPromptSubmit hook\n\n  {}\n\n• answer\n\n');
    expect(stderr.text()).toContain('Outcome    COMPLETED');
    expect(stderr.text()).toContain('Resume     wukong -r ses_prompt');
  });

  it('wraps transcript blocks with hanging indentation when terminal width is known', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 4, origin: { kind: 'user' } }),
        );
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 4, delta: 'thinking-wrap' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 4, delta: 'answer-wrap' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 4, reason: 'completed' }));
      }
    });
    const stdout = writer(10);
    const stderr = writer(10);

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain('• thinking\n  -wrap\n\n');
    expect(stderr.text()).toContain('Outcome    COMPLETED');
    expect(stdout.text()).toBe('• answer-w\n  rap\n\n');
  });

  it('filters prompt output and completion to the main agent turn', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      const emit = (event: Record<string, unknown>) => {
        for (const handler of Array.from(mocks.eventHandlers)) {
          handler(event);
        }
      };

      emit(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      emit(
        mocks.agentEvent('child-agent', {
          type: 'turn.started',
          turnId: 1,
          origin: { kind: 'user' },
        }),
      );
      emit(
        mocks.agentEvent('child-agent', {
          type: 'assistant.delta',
          turnId: 1,
          delta: 'sub answer',
        }),
      );
      emit(mocks.agentEvent('child-agent', { type: 'turn.ended', turnId: 1, reason: 'completed' }));
      await Promise.resolve();
      emit(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'main answer' }));
      emit(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• main answer\n\n');
    expect(stderr.text()).toContain('Outcome    COMPLETED');
  });

  it('ignores child-agent error events while the main turn continues', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      const emit = (event: Record<string, unknown>) => {
        for (const handler of Array.from(mocks.eventHandlers)) {
          handler(event);
        }
      };

      emit(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      emit(
        mocks.agentEvent('child-agent', {
          type: 'error',
          code: 'subagent.failed',
          message: 'child failed',
        }),
      );
      await Promise.resolve();
      emit(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'main recovered' }));
      emit(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• main recovered\n\n');
    expect(stderr.text()).toContain('Outcome    COMPLETED');
  });

  it('resumes a concrete session and forces auto permission before prompting', async () => {
    await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
    expect(mocks.session.getStatus).toHaveBeenCalled();
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto', { transient: true });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
  });

  it('passes the CLI additional directories when resuming a concrete session', async () => {
    await runPrompt(
      opts({ session: 'ses_existing', addDirs: ['../shared', '/tmp/extra'] }),
      '1.2.3-test',
      {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      },
    );

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({
      id: 'ses_existing',
      additionalDirs: ['../shared', '/tmp/extra'],
    });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
  });

  it('allows resuming a concrete session when Windows workdir uses backslashes', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(String.raw`C:\Users\wukong\project`);
    mocks.harnessListSessions.mockResolvedValueOnce([
      { id: 'ses_existing', workDir: 'C:/Users/wukong/project' },
    ]);

    try {
      await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      });
    } finally {
      cwd.mockRestore();
    }

    expect(mocks.harnessListSessions).toHaveBeenCalledWith({
      sessionId: 'ses_existing',
      workDir: String.raw`C:\Users\wukong\project`,
    });
    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
  });

  it('applies the CLI model override to resumed prompt sessions', async () => {
    await runPrompt(opts({ session: 'ses_existing', model: 'wukong/k2.5' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
    expect(mocks.session.setModel).toHaveBeenCalledWith('wukong/k2.5');
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'wukong/k2.5' }),
    );
  });

  it('writes stream-json output as assistant JSONL with resume meta without transcript bullets', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ role: 'meta', type: 'run.preflight', goal: 'say hello' });
    expect(lines[1]).toEqual({ role: 'assistant', content: 'hello world' });
    expect(lines[2]).toMatchObject({
      role: 'meta',
      type: 'run.summary',
      outcome: 'COMPLETED',
      session_id: 'ses_prompt',
      resume_command: 'wukong -r ses_prompt',
    });
    expect(stderr.text()).toBe('');
  });

  it('writes stream-json tool calls and tool results as JSONL messages', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 8, origin: { kind: 'user' } }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 8, delta: 'checking' }));
        handler(
          mocks.mainEvent({
            type: 'tool.call.started',
            turnId: 8,
            toolCallId: 'tc_1',
            name: 'Shell',
            args: { command: 'ls' },
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'tool.result',
            turnId: 8,
            toolCallId: 'tc_1',
            output: 'file1.py\nfile2.py',
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 8, delta: 'done' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 8, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ role: 'meta', type: 'run.preflight' });
    expect(lines).toContainEqual(expect.objectContaining({
      role: 'meta',
      type: 'run.progress',
      content: expect.stringContaining('Running Shell: ls'),
    }));
    expect(lines).toContainEqual({
      role: 'tool',
      tool_call_id: 'tc_1',
      content: 'file1.py\nfile2.py',
    });
    expect(lines.at(-1)).toMatchObject({
      role: 'meta',
      type: 'run.summary',
      activity: { tools: ['Shell'], commands: ['ls'] },
    });
  });

  it('resumes a concrete session without a configured default model', async () => {
    mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });
    mocks.session.getStatus.mockResolvedValueOnce({ permission: 'manual', model: 'saved-model' });

    await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'saved-model' }),
    );
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto', { transient: true });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
  });

  it('continues the previous workdir session when --continue is used', async () => {
    await runPrompt(opts({ continue: true }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessListSessions).toHaveBeenCalledWith({ workDir: process.cwd() });
    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_previous' });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto', { transient: true });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
  });

  it('passes the CLI additional directories when continuing the previous session', async () => {
    await runPrompt(opts({ continue: true, addDirs: ['../shared', '/tmp/extra'] }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({
      id: 'ses_previous',
      additionalDirs: ['../shared', '/tmp/extra'],
    });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
  });

  it('continues a previous session without a configured default model', async () => {
    mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });
    mocks.session.getStatus.mockResolvedValueOnce({ permission: 'manual', model: 'saved-model' });

    await runPrompt(opts({ continue: true }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessListSessions).toHaveBeenCalledWith({ workDir: process.cwd() });
    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_previous' });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'saved-model' }),
    );
  });

  it('restores resumed session permission even when the turn fails', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 5, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 5,
            reason: 'failed',
            error: { code: 'provider.error', message: 'model failed' },
          }),
        );
      }
    });

    await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto', { transient: true });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
    expect(mocks.session.setPermission.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.harnessClose.mock.invocationCallOrder[0]!,
    );
    process.exitCode = undefined;
  });

  it('waits for an in-flight provider request to settle before writing one non-resumable SIGINT summary', async () => {
    let releasePrompt!: () => void;
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 6, origin: { kind: 'user' } }),
        );
      }
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const processMock = fakeProcess();
    const stdout = writer();
    const run = runPrompt(opts({ session: 'ses_existing', outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr: writer(),
      process: processMock,
    } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

    await waitForAssertion(() => {
      expect(mocks.session.setPermission).toHaveBeenCalledWith('auto', { transient: true });
      expect(processMock.listener('SIGINT')).toBeDefined();
      expect(mocks.session.prompt).toHaveBeenCalled();
    });

    const signalCleanup = processMock.listener('SIGINT')?.();
    await Promise.resolve();

    expect(processMock.exit).not.toHaveBeenCalled();
    expect(stdout.text()).not.toContain('"outcome":"STOPPED_BY_USER"');

    for (const handler of mocks.eventHandlers) {
      handler(mocks.mainEvent({
        type: 'error',
        code: 'provider.connection',
        message: 'socket closed after request start',
        details: {
          providerOutcomeUnknown: {
            requestId: 'req-unknown',
            idempotencyKey: 'idem-unknown',
            state: 'outcome_unknown',
            outputObserved: false,
          },
        },
      }));
      handler(mocks.mainEvent({
        type: 'turn.ended',
        turnId: 6,
        reason: 'cancelled',
      }));
    }
    releasePrompt();
    await signalCleanup;
    await run;

    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
    expect(mocks.session.setPermission.mock.invocationCallOrder[1]).toBeLessThan(
      processMock.exit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
    expect(processMock.exit).toHaveBeenCalledWith(130);
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
    const reports = stdout.text().trim().split('\n').map((line) => JSON.parse(line))
      .filter((record) => record.type === 'run.summary');
    expect(reports).toEqual([
      expect.objectContaining({
        outcome: 'STOPPED_BY_USER',
        exit_code: 130,
        resume_command: null,
        provider_outcome_unknown: {
          requestId: 'req-unknown',
          idempotencyKey: 'idem-unknown',
          state: 'outcome_unknown',
          outputObserved: false,
        },
      }),
    ]);
    expect(reports[0]?.next_actions).toContain(
      'Do not resume blindly; cancel and explicitly start a new attempt only after confirming it is safe.',
    );
  });

  it.each([
    ['SIGTERM' as NodeJS.Signals, 143],
    ['SIGHUP' as NodeJS.Signals, 129],
  ])('cleans up prompt mode before exiting on %s', async (signal, exitCode) => {
    let releasePrompt!: () => void;
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 7, origin: { kind: 'user' } }),
        );
      }
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const processMock = fakeProcess();
    const run = runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      process: processMock,
    } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

    await waitForAssertion(() => {
      expect(processMock.listener(signal)).toBeDefined();
      expect(mocks.session.prompt).toHaveBeenCalled();
    });

    const signalCleanup = processMock.listener(signal)?.();
    await Promise.resolve();

    expect(processMock.exit).not.toHaveBeenCalled();
    for (const handler of mocks.eventHandlers) {
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 7, reason: 'cancelled' }));
    }
    releasePrompt();
    await signalCleanup;

    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
    expect(processMock.exit).toHaveBeenCalledWith(exitCode);

    await run;

    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('waits for the pending auto permission write before signal restore', async () => {
    let releaseAutoPermission!: () => void;
    mocks.session.setPermission.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseAutoPermission = resolve;
      });
    });
    const processMock = fakeProcess();
    const run = runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      process: processMock,
    } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

    await waitForAssertion(() => {
      expect(processMock.listener('SIGINT')).toBeDefined();
      expect(mocks.session.setPermission).toHaveBeenCalledWith('auto', { transient: true });
    });
    expect(processMock.once.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.session.setPermission.mock.invocationCallOrder[0]!,
    );

    const signalCleanup = processMock.listener('SIGINT')?.();
    await Promise.resolve();

    expect(mocks.session.setPermission).toHaveBeenCalledTimes(1);

    releaseAutoPermission();
    await signalCleanup;

    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual', { transient: true });
    expect(processMock.exit).toHaveBeenCalledWith(130);

    await run;
    expect(mocks.session.prompt).not.toHaveBeenCalled();
  });

  it('uses auto permission so headless mode can bypass plan approval and questions', async () => {
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'manual' }),
    );
    expect(mocks.session.setPermission).toHaveBeenCalledWith('auto', { transient: true });
  });

  it('throws when no default model is configured', async () => {
    mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });

    await expect(
      runPrompt(opts(), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      }),
    ).rejects.toThrow(
      'No model configured. Run `wukong` and use /provider to add your model API key, then retry; or set default_model in config.toml.',
    );

    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('reports a failed turn and still closes resources', async () => {
    process.exitCode = undefined;
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }),
        );
        handler(mocks.mainEvent({ type: 'turn.step.started', turnId: 2, step: 1 }));
        handler(mocks.mainEvent({
          type: 'tool.call.started',
          turnId: 2,
          toolCallId: 'tc_failed',
          name: 'Shell',
          args: { command: 'pnpm test' },
        }));
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 2,
            reason: 'failed',
            error: { code: 'provider.error', message: 'model failed' },
          }),
        );
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', {
      stdout,
      stderr,
    });

    expect(stderr.text()).toContain('Outcome    ERROR');
    expect(stderr.text()).toContain('Exit       1 — provider.error: model failed');
    expect(stderr.text()).toContain('Activity   1 step(s) · 1 tool(s) · 1 command(s)');
    expect(process.exitCode).toBe(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
    process.exitCode = undefined;
  });

  it('reports a failed prompt as JSONL with the actual exit code and activity', async () => {
    process.exitCode = undefined;
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 3, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'turn.step.started', turnId: 3, step: 1 }));
        handler(mocks.mainEvent({
          type: 'tool.call.started',
          turnId: 3,
          toolCallId: 'tc_failed_json',
          name: 'Shell',
          args: { command: 'pnpm test' },
        }));
        handler(mocks.mainEvent({
          type: 'turn.ended',
          turnId: 3,
          reason: 'failed',
          error: { code: 'provider.error', message: 'model failed' },
        }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
    });

    const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({
      role: 'meta',
      type: 'run.summary',
      outcome: 'ERROR',
      exit_code: 1,
      activity: {
        steps: 1,
        tools: ['Shell'],
        commands: ['pnpm test'],
      },
    }));
    expect(stderr.text()).toBe('');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('reports a friendly message when the provider filters the response', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 2,
            reason: 'filtered',
          }),
        );
      }
    });

    const stderr = writer();
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr,
    });

    expect(stderr.text()).toContain('Provider safety policy blocked the response.');
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('approval fallback approves if an unexpected approval request reaches SDK', async () => {
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    const handler = mocks.session.setApprovalHandler.mock.calls[0]![0] as () => unknown;
    expect(handler()).toEqual({ decision: 'approved' });
  });

  it('question fallback returns null so prompt mode never opens a question UI', async () => {
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    const handler = mocks.session.setQuestionHandler.mock.calls[0]![0] as () => unknown;
    expect(handler()).toBeNull();
  });

  describe('high-level paths', () => {
    it('completes a successful prompt turn and writes text output', async () => {
      const stdout = writer();
      const stderr = writer();

      await runPrompt(opts({ prompt: 'say hello' }), '1.2.3-test', { stdout, stderr });

      expect(stdout.text()).toBe('• hello world\n\n');
      expect(stderr.text()).toContain('Outcome    COMPLETED');
      expect(stderr.text()).toContain('Resume     wukong -r ses_prompt');
      expect(mocks.shutdownTelemetry).toHaveBeenCalled();
      expect(mocks.harnessClose).toHaveBeenCalled();
    });

    it('runs a headless /goal prompt and emits JSON output', async () => {
      process.exitCode = undefined;
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'goal',
        objective: 'write tests',
        replace: false,
      });
      mocks.goalSummaryJson.mockReturnValue({
        type: 'goal.summary',
        goalId: 'goal-123',
        status: 'complete',
      });
      mocks.session.createGoal.mockResolvedValueOnce({ goalId: 'goal-123' });
      mocks.session.prompt.mockImplementationOnce(async () => {
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
          handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 10, delta: 'ok' }));
          handler(
            mocks.mainEvent({
              type: 'goal.updated',
              change: { kind: 'completion' },
              snapshot: { status: 'complete', goalId: 'goal-123' },
            }),
          );
          handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
        }
      });
      const stdout = writer();
      const stderr = writer();

      await runPrompt(
        opts({ prompt: '/goal write tests', outputFormat: 'stream-json' }),
        '1.2.3-test',
        { stdout, stderr },
      );

      expect(mocks.session.createGoal).toHaveBeenCalledWith({
        objective: 'write tests',
        replace: false,
      });
      expect(mocks.goalSummaryJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'complete', goalId: 'goal-123' }),
      );
      expect(stdout.text()).toBe(
        [
          '{"role":"assistant","content":"ok"}',
          '{"type":"goal.summary","goalId":"goal-123","status":"complete"}',
          '',
        ].join('\n'),
      );
      expect(stderr.text()).toBe('');
      expect(process.exitCode).toBeUndefined();
    });

    it('fails closed when a headless /goal run has no durable goal snapshot', async () => {
      process.exitCode = undefined;
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'goal',
        objective: 'write tests',
        replace: false,
      });
      mocks.session.createGoal.mockResolvedValueOnce({ goalId: 'goal-missing' });
      mocks.session.getGoal.mockResolvedValueOnce({ goal: null });
      mocks.goalExitCode.mockReturnValueOnce(2);
      mocks.session.prompt.mockImplementationOnce(async () => {
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
          handler(mocks.mainEvent({
            type: 'goal.updated',
            change: { kind: 'completion' },
            snapshot: null,
          }));
          handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
        }
      });

      await runPrompt(opts({ prompt: '/goal write tests' }), '1.2.3-test', {
        stdout: writer(),
        stderr: writer(),
      });

      expect(mocks.goalExitCode).toHaveBeenCalledWith(undefined);
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    });

    it('waits for a later Goal turn instead of finishing after the first turn', async () => {
      process.exitCode = undefined;
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'goal',
        objective: 'finish across turns',
        replace: false,
      });
      mocks.session.createGoal.mockResolvedValueOnce({ goalId: 'goal-multi' });
      let releaseSecondTurn!: () => void;
      const continueDrive = new Promise<void>((resolve) => {
        releaseSecondTurn = resolve;
      });
      mocks.session.prompt.mockImplementationOnce(async () => {
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
          handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 10, delta: 'first' }));
          handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
        }
        await continueDrive;
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 11, origin: { kind: 'system_trigger' } }));
          handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 11, delta: 'second' }));
          handler(mocks.mainEvent({
            type: 'goal.updated',
            change: { kind: 'completion' },
            snapshot: { goalId: 'goal-multi', status: 'complete' },
          }));
          handler(mocks.mainEvent({ type: 'turn.ended', turnId: 11, reason: 'completed' }));
        }
      });

      let settled = false;
      const running = runPrompt(opts({ prompt: '/goal finish across turns' }), '1.2.3-test', {
        stdout: writer(),
        stderr: writer(),
      }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => {
        expect(mocks.session.prompt).toHaveBeenCalledOnce();
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseSecondTurn();
      await running;
      expect(settled).toBe(true);
    });

    it('uses the user-selected local iteration limit without a remote quota cap', async () => {
      process.exitCode = undefined;
      mocks.session.createGoal.mockResolvedValueOnce({
        goalId: 'goal-loop-1',
        loopRunId: 'core-run-loop-1',
      });
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'loop',
        objective: 'fix tests',
        replace: false,
        stopCondition: 'proof-pass',
        maxIterations: 10,
      });
      mocks.session.getGoal.mockResolvedValueOnce({
        goal: {
          status: 'blocked',
          iteration: 5,
          terminalReason: 'loop:NEEDS_WORK:max_iterations:Tests still fail.',
        },
      });
      mocks.session.prompt.mockImplementationOnce(async () => {
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
          handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
          handler(mocks.mainEvent({
            type: 'goal.updated',
            change: { kind: 'lifecycle', status: 'blocked' },
            snapshot: {
              goalId: 'goal-loop-1',
              status: 'blocked',
              iteration: 5,
              terminalReason: 'loop:NEEDS_WORK:max_iterations:Tests still fail.',
            },
          }));
        }
      });
      const stderr = writer();

      await runPrompt(opts({ prompt: '/loop fix tests' }), '1.2.3-test', {
        stdout: writer(),
        stderr,
      });

      expect(mocks.session.createGoal).toHaveBeenCalledWith(expect.objectContaining({
        objective: 'fix tests',
        maxIterations: 10,
      }));
      expect(mocks.beginLoopRun).toHaveBeenCalledTimes(1);
      expect(mocks.completeLoopRun).toHaveBeenCalledTimes(1);
    });

    it('records runtime failures as Loop ERROR instead of completed NEEDS_WORK', async () => {
      process.exitCode = undefined;
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'loop',
        objective: 'fix tests',
        replace: false,
        stopCondition: 'proof-pass',
        maxIterations: 3,
      });
      mocks.session.createGoal.mockResolvedValueOnce({
        goalId: 'goal-runtime-error',
        loopRunId: 'core-run-runtime-error',
      });
      mocks.session.getGoal.mockResolvedValueOnce({
        goal: { goalId: 'goal-runtime-error', status: 'paused', iteration: 1 },
      });
      mocks.session.prompt.mockImplementationOnce(async () => {
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
          handler(mocks.mainEvent({
            type: 'turn.ended',
            turnId: 10,
            reason: 'failed',
            error: { message: 'provider unavailable' },
          }));
          handler(mocks.mainEvent({
            type: 'goal.updated',
            change: { kind: 'lifecycle', status: 'paused' },
            snapshot: { goalId: 'goal-runtime-error', status: 'paused', iteration: 1 },
          }));
        }
      });

      const stdout = writer();
      const stderr = writer();

      await runPrompt(opts({ prompt: '/loop fix tests', outputFormat: 'stream-json' }), '1.2.3-test', {
        stdout,
        stderr,
      });

      expect(mocks.completeLoopRun).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run123' }),
        'ERROR',
        1,
      );
      const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toContainEqual(expect.objectContaining({
        type: 'loop.result',
        status: 'ERROR',
        reasonCode: 'runtime_error',
        writerIterations: 1,
        checks: [],
        evidence: { verification: 'not_run', reviewer: 'not_run' },
      }));
      expect(lines).not.toContainEqual(expect.objectContaining({
        type: 'session.resume_hint',
      }));
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    });

    it('routes a missing Loop model through preflight before local lifecycle creation', async () => {
      process.exitCode = undefined;
      mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'loop',
        objective: 'fix tests',
        replace: false,
      });
      mocks.runLoopPreflight.mockResolvedValueOnce({
        ready: false,
        reasonCode: 'model_not_configured',
        reason: 'No model is configured.',
        next: 'Run /provider or /model, then start the Loop again.',
      });
      const stderr = writer();

      await runPrompt(opts({ prompt: '/loop fix tests' }), '1.2.3-test', {
        stdout: writer(),
        stderr,
      });

      expect(mocks.runLoopPreflight).toHaveBeenCalledWith(expect.objectContaining({
        objective: 'fix tests',
        model: undefined,
      }));
      expect(mocks.beginLoopRun).not.toHaveBeenCalled();
      expect(mocks.session.createGoal).not.toHaveBeenCalled();
      expect(stderr.text()).toContain('Reason   No model is configured.');
      expect(stderr.text()).toContain('Next     Run /provider or /model');
      expect(process.exitCode).toBe(2);
    });

    it('does not create an orphan local lifecycle record when goal creation fails', async () => {
      process.exitCode = undefined;
      mocks.parseHeadlessGoalCreate.mockReturnValue({
        kind: 'loop',
        objective: 'fix tests',
        replace: false,
        stopCondition: 'proof-pass',
      });
      mocks.session.createGoal.mockRejectedValueOnce(new Error('goal store unavailable'));

      await expect(runPrompt(opts({ prompt: '/loop fix tests' }), '1.2.3-test', {
        stdout: writer(),
        stderr: writer(),
      })).rejects.toThrow('goal store unavailable');

      expect(mocks.beginLoopRun).not.toHaveBeenCalled();
      expect(mocks.completeLoopRun).not.toHaveBeenCalled();
      expect(mocks.registerTuiLoop).not.toHaveBeenCalled();
    });

    it('throws when no model is configured', async () => {
      mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });

      await expect(
        runPrompt(opts(), '1.2.3-test', {
          stdout: { write: vi.fn(() => true) },
          stderr: { write: vi.fn(() => true) },
        }),
      ).rejects.toThrow(
        'No model configured. Run `wukong` and use /provider to add your model API key, then retry; or set default_model in config.toml.',
      );

      expect(mocks.harnessClose).toHaveBeenCalled();
    });

    it('refuses to resume a session created under a different working directory', async () => {
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/current/project');
      mocks.harnessListSessions.mockResolvedValueOnce([
        { id: 'ses_remote', workDir: '/other/project' },
      ]);
      const stderr = writer();

      try {
        await expect(
          runPrompt(opts({ session: 'ses_remote' }), '1.2.3-test', {
            stdout: { write: vi.fn(() => true) },
            stderr,
          }),
        ).rejects.toThrow('Session "ses_remote" was created under a different directory.');
        expect(stderr.text()).toContain(
          'Session "ses_remote" was created under a different directory.',
        );
      } finally {
        cwd.mockRestore();
      }

      expect(mocks.harnessResumeSession).not.toHaveBeenCalled();
    });

    it('cleans up and exits 130 on SIGINT', async () => {
      let releasePrompt!: () => void;
      mocks.session.prompt.mockImplementationOnce(async () => {
        for (const handler of mocks.eventHandlers) {
          handler(mocks.mainEvent({ type: 'turn.started', turnId: 11, origin: { kind: 'user' } }));
        }
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      });
      const processMock = fakeProcess();
      const run = runPrompt(opts(), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
        process: processMock,
      } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

      await waitForAssertion(() => {
        expect(processMock.listener('SIGINT')).toBeDefined();
        expect(mocks.session.prompt).toHaveBeenCalled();
      });

      const signalCleanup = processMock.listener('SIGINT')?.();
      await Promise.resolve();

      expect(processMock.exit).not.toHaveBeenCalled();
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 11, reason: 'cancelled' }));
      }
      releasePrompt();
      await signalCleanup;

      expect(mocks.shutdownTelemetry).toHaveBeenCalled();
      expect(mocks.harnessClose).toHaveBeenCalled();
      expect(processMock.exit).toHaveBeenCalledWith(130);

      await run;

      expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
    });
  });
});
