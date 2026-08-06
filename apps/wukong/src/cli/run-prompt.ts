import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@wukong/wukong-telemetry';
import chalk from 'chalk';
import {
  createWukongHarness,
  log,
  type Event,
  type GoalSnapshot,
  type HookResultEvent,
  type WukongHarness,
  type Session,
  type SessionStatus,
  type SessionUsage,
  type TelemetryClient,
  type WukongConfig,
} from '@wukong/wukong-sdk';
import { inspectGit, type GitInspection } from '@wukong/verification';
import { resolve } from 'pathe';

import { CLI_SHUTDOWN_TIMEOUT_MS } from '#/constant/app';
import { durableLoopResultFromGoal } from '#/utils/loop-result';

import type { CLIOptions, PromptOutputFormat } from './options';
import {
  formatGoalSummaryText,
  formatLoopResultText,
  formatLoopSummaryText,
  goalExitCode,
  GOAL_EXIT_CODES,
  goalSummaryJson,
  loopExitCode,
  loopRuntimeErrorSummary,
  loopSummaryJson,
  LOOP_EXIT_CODES,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from './goal-prompt';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { createWukongCodeHostIdentity } from './version';
import {
  beginLoopRun,
  completeLoopRun,
  registerTuiLoop,
  stopLoopRun,
  type LocalLoopRun,
} from './lib/loop-lifecycle';
import {
  formatLoopPreflightBlocked,
  formatLoopPreflightReady,
  resolveLoopReviewProvider,
  runLoopPreflight,
  type LoopPreflightReady,
} from './lib/loop-preflight';

interface PromptOutput {
  readonly columns?: number | undefined;
  write(chunk: string): boolean;
}

interface PromptRunIO {
  readonly stdout?: PromptOutput;
  readonly stderr?: PromptOutput;
  readonly process?: PromptProcess;
}

interface PromptProcess {
  once(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  exit(code?: number): never | void;
}

const PROMPT_UI_MODE = 'print';
const PROMPT_MAIN_AGENT_ID = 'main';
const PROMPT_BLOCK_BULLET = '• ';
const PROMPT_BLOCK_INDENT = '  ';

export async function runPrompt(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const workDir = process.cwd();
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = createWukongHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createWukongCodeHostIdentity(version),
    uiMode: PROMPT_UI_MODE,
    skillDirs: opts.skillsDirs,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { outcome: 'success' });
        return;
      }
      track('oauth_refresh', { outcome: 'error', reason: outcome.reason });
    },
    sessionStartedProperties: { yolo: opts.yolo, plan: false, afk: true },
  });
  log.info('wukong starting', {
    version,
    uiMode: PROMPT_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });
  let restorePromptSessionPermission = async (): Promise<void> => {};
  let handlePromptTermination: ((signal: NodeJS.Signals) => Promise<void>) | undefined;
  let requestedTerminationSignal: NodeJS.Signals | undefined;
  let removeTerminationCleanup: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanupPromptRun = async (): Promise<void> => {
    cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      setCrashPhase('shutdown');
      try {
        await restorePromptSessionPermission();
      } finally {
        await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
        await harness.close();
      }
    })();
    await cleanupPromise;
  };
  removeTerminationCleanup = installPromptTerminationCleanup(
    promptProcess,
    cleanupPromptRun,
    async (signal) => {
      requestedTerminationSignal ??= signal;
      await handlePromptTermination?.(signal);
    },
  );

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    for (const warning of (await harness.getConfigDiagnostics()).warnings) {
      stderr.write(`Warning: ${warning}\n`);
    }
    const goalCreate = opts.headlessGoal ?? parseHeadlessGoalCreate(opts.prompt!);
    if (
      goalCreate?.kind === 'loop'
      && opts.session === undefined
      && !opts.continue
      && configuredModel(opts.model, config.defaultModel) === undefined
    ) {
      const preflight = await runLoopPreflight({
        objective: goalCreate.objective,
        model: undefined,
        workspace: workDir,
        reviewProvider: resolveLoopReviewProvider(config, opts.model),
        getActiveGoal: async () => null,
      });
      if (!preflight.ready) {
        stderr.write(`${formatLoopPreflightBlocked(preflight)}\n`);
        process.exitCode = 2;
        return;
      }
    }
    const { session, restorePermission, telemetryModel, goalModel, goalPermission } =
      await resolvePromptSession(
        harness,
        opts,
        workDir,
        config.defaultModel,
        stderr,
        (restorePermission) => {
          restorePromptSessionPermission = restorePermission;
        },
      );
    restorePromptSessionPermission = restorePermission;
    if (requestedTerminationSignal !== undefined) return;

    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config,
      version,
      uiMode: PROMPT_UI_MODE,
      model: telemetryModel,
    });
    setCrashPhase('runtime');

    const outputFormat = opts.outputFormat ?? 'text';
    let resumeHintWritten = false;
    let runSummaryWritten = false;
    let terminationSignal: NodeJS.Signals | undefined;
    let terminationProviderOutcomeUnknown: StoppedProviderOutcomeUnknown | undefined;
    let activeRunSettled: Promise<void> = Promise.resolve();
    let terminationSummaryPromise: Promise<void> | undefined;
    handlePromptTermination = async (signal) => {
      requestedTerminationSignal ??= signal;
      terminationSignal ??= signal;
      terminationSummaryPromise ??= (async () => {
        await Promise.resolve(session.cancel()).catch(() => {});
        // `session.cancel()` only requests cancellation. Wait until the active
        // TurnFlow has emitted its terminal turn/goal events before deciding
        // whether the provider outcome is unknown or the run is resumable.
        await activeRunSettled;
        if (runSummaryWritten) return;
        const [stoppedGoal, workspace] = await Promise.all([
          session.getGoal().then((result) => result.goal).catch(() => null),
          inspectGit(workDir).catch(() => undefined),
        ]);
        writeStoppedRunSummary({
          signal: terminationSignal ?? signal,
          sessionId: session.id,
          outputFormat,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          providerOutcomeUnknown:
            stoppedGoal?.providerOutcomeUnknown ?? terminationProviderOutcomeUnknown,
          workspace,
        });
        runSummaryWritten = true;
        resumeHintWritten = true;
      })();
      await terminationSummaryPromise;
    };
    // Headless goal mode: `wukong -p "/goal <objective>"`. The goal driver keeps
    // the turn-run alive across continuation turns, so the normal prompt-turn
    // waiter blocks until the goal is terminal; we then emit a summary and set a
    // distinct exit code.
    if (goalCreate !== undefined) {
      const goalRun = runHeadlessGoal(
        session,
        goalCreate,
        goalModel,
        goalPermission,
        config,
        outputFormat,
        stdout,
        stderr,
        () => terminationSignal !== undefined,
      );
      activeRunSettled = goalRun.then(() => {}, () => {});
      await goalRun;
      if (terminationSignal !== undefined) {
        await terminationSummaryPromise;
        return;
      }
      if (terminationSignal === undefined) {
        runSummaryWritten = true;
        resumeHintWritten = true;
      }
    } else {
      const status = await session.getStatus();
      const workspaceBefore = await inspectGit(workDir);
      writePromptPreflight({
        prompt: opts.prompt!,
        model: status.model ?? telemetryModel,
        permission: status.permission,
        workspace: workDir,
        outputFormat,
        stdout,
        stderr,
      });
      const turnStartedAt = Date.now();
      const turnRun = runPromptTurn(session, opts.prompt!, outputFormat, stdout, stderr);
      activeRunSettled = turnRun.then(
        (facts) => {
          terminationProviderOutcomeUnknown ??= facts.providerOutcomeUnknown;
        },
        (error: unknown) => {
          terminationProviderOutcomeUnknown ??=
            promptTurnFactsFromError(error).providerOutcomeUnknown;
        },
      );
      try {
        const facts = await turnRun;
        if (terminationSignal !== undefined) {
          await terminationSummaryPromise;
          return;
        }
        const [usage, workspaceAfter] = await Promise.all([
          session.getUsage().catch(() => ({})),
          inspectGit(workDir),
        ]);
        if (terminationSignal !== undefined) {
          await terminationSummaryPromise;
          return;
        }
        writePromptRunSummary({
          outcome: 'COMPLETED',
          exitCode: 0,
          exitMeaning: 'The model turn completed; this does not imply the work was verified.',
          sessionId: session.id,
          outputFormat,
          stdout,
          stderr,
          durationMs: Date.now() - turnStartedAt,
          usage,
          workspaceBefore,
          workspaceAfter,
          facts,
        });
      } catch (error) {
        if (terminationSignal !== undefined) {
          await terminationSummaryPromise;
          return;
        }
        const [usage, workspaceAfter] = await Promise.all([
          session.getUsage().catch(() => ({})),
          inspectGit(workDir),
        ]);
        writePromptRunSummary({
          outcome: 'ERROR',
          exitCode: 1,
          exitMeaning: error instanceof Error ? error.message : String(error),
          sessionId: session.id,
          outputFormat,
          stdout,
          stderr,
          durationMs: Date.now() - turnStartedAt,
          usage,
          workspaceBefore,
          workspaceAfter,
          facts: promptTurnFactsFromError(error),
        });
        process.exitCode = 1;
        runSummaryWritten = true;
        resumeHintWritten = true;
        return;
      }
      runSummaryWritten = true;
      resumeHintWritten = true;
    }
    if (!resumeHintWritten && terminationSignal === undefined) {
      writeResumeHint(session.id, outputFormat, stdout, stderr);
    }

    withTelemetryContext({ sessionId: session.id }).track('exit', {
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    await cleanupPromptRun();
  }
}

async function runHeadlessGoal(
  session: Session,
  goal: HeadlessGoalCreate,
  model: string | undefined,
  permission: SessionStatus['permission'],
  config: WukongConfig,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
  isTerminating: () => boolean,
): Promise<void> {
  const resolvedModel = goal.kind === 'loop' ? configuredModel(model) : requireConfiguredModel(model);
  let loopRun: LocalLoopRun | undefined;
  let loopPreflight: LoopPreflightReady | undefined;
  if (goal.kind === 'loop') {
    const preflight = await runLoopPreflight({
      objective: goal.objective,
      completionCriterion: goal.completionCriterion,
      constraints: goal.constraints,
      explicitChecks: goal.checks,
      discoveredCheckDecision: goal.discoveredCheckDecision,
      model: resolvedModel,
      workspace: process.cwd(),
      mode: 'headless',
      approveGatePlanDigest: goal.approveGatePlanDigest,
      acknowledgeWarningSetDigest: goal.acknowledgeWarningSetDigest,
      trustWorkspaceChallenge: goal.trustWorkspaceChallenge,
      verificationCatalogDigest: goal.verificationCatalogDigest,
      verificationSkills: goal.verificationSkills,
      trustReviewSubjectChallenge: goal.trustReviewSubjectChallenge,
      acknowledgeReviewSubjectConsentDigest:
        goal.acknowledgeReviewSubjectConsentDigest,
      reviewProvider: resolveLoopReviewProvider(
        config,
        goal.reviewModel ?? resolvedModel,
      ),
      getActiveGoal: async () => (await session.getGoal()).goal,
    });
    if (!preflight.ready) {
      stderr.write(`${formatLoopPreflightBlocked(preflight)}\n`);
      process.exitCode = 2;
      return;
    }
    loopPreflight = preflight;
    stderr.write(`${formatLoopPreflightReady(
      preflight,
      goal.maxIterations ?? 10,
      {
        writerModel: preflight.model,
        reviewerModel: goal.reviewModel ?? preflight.model,
        permission,
      },
    )}\n`);
  }
  const maxIterations = goal.kind === 'loop' ? goal.maxIterations ?? 10 : goal.maxIterations;
  let createdGoal: GoalSnapshot;
  try {
    const reviewSettings = loopPreflight?.brokerReviewTrust === undefined
      || loopPreflight.reviewSubjectConsent === undefined
      ? undefined
      : {
          brokerReviewTrust: loopPreflight.brokerReviewTrust,
          reviewSubjectConsent: loopPreflight.reviewSubjectConsent,
        };
    if (loopPreflight !== undefined && reviewSettings === undefined) {
      throw new Error('Loop preflight did not freeze exact broker trust and provider consent.');
    }
    createdGoal = await session.createGoal({
      objective: goal.objective,
      completionCriterion: goal.completionCriterion,
      replace: goal.replace,
      ...(goal.stopCondition === undefined ? {} : { stopCondition: goal.stopCondition }),
      reviewModel: goal.reviewModel,
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(goal.minIntervalMs === undefined ? {} : { minIntervalMs: goal.minIntervalMs }),
      ...(loopPreflight !== undefined
        ? {
            loopContract: loopPreflight.contractSchemaVersion === 3
              ? {
                  schemaVersion: 3 as const,
                  objective: loopPreflight.proposal.objective,
                  completionCriterion: loopPreflight.proposal.completionCriterion,
                  constraints: loopPreflight.proposal.constraints,
                  finishLineReview: loopPreflight.proposal.finishLineReview,
                  workspaceIdentity: loopPreflight.proposal.workspaceIdentity,
                  workspaceTrust: loopPreflight.proposal.gateApproval.hasExecutableChecks
                    ? {
                        schemaVersion: 2 as const,
                        workspaceIdentityDigest:
                          loopPreflight.proposal.workspaceIdentity.workspaceIdentityDigest,
                        reviewSubjectPolicyVersion:
                          loopPreflight.reviewSubjectConsentProposal
                            .reviewSubjectPolicyVersion,
                        hasExecutableChecks: true as const,
                        scopes: [
                          'loop-project-checks',
                          'brokered-review-subject',
                        ] as const,
                      }
                    : {
                        schemaVersion: 2 as const,
                        workspaceIdentityDigest:
                          loopPreflight.proposal.workspaceIdentity.workspaceIdentityDigest,
                        reviewSubjectPolicyVersion:
                          loopPreflight.reviewSubjectConsentProposal
                            .reviewSubjectPolicyVersion,
                        hasExecutableChecks: false as const,
                        scopes: ['brokered-review-subject'] as const,
                      },
                  gateApproval: loopPreflight.proposal.gateApproval,
                  legacyGatePlan: loopPreflight.proposal.gatePlan,
                  reviewPolicy: loopPreflight.proposal.reviewPolicy,
                  verificationCriteria: loopPreflight.verificationSelection!,
                  selectedRecipes: loopPreflight.selectedRecipes,
                  reviewSettings: reviewSettings!,
                  source: 'user' as const,
                }
              : {
                  schemaVersion: 2 as const,
                  objective: loopPreflight.proposal.objective,
                  completionCriterion: loopPreflight.proposal.completionCriterion,
                  constraints: loopPreflight.proposal.constraints,
                  finishLineReview: loopPreflight.proposal.finishLineReview,
                  workspaceIdentity: loopPreflight.proposal.workspaceIdentity,
                  workspaceTrust: loopPreflight.proposal.workspaceTrust,
                  gateApproval: loopPreflight.proposal.gateApproval,
                  gatePlan: loopPreflight.proposal.gatePlan,
                  reviewPolicy: loopPreflight.proposal.reviewPolicy,
                  reviewSettings: reviewSettings!,
                  source: 'user' as const,
                },
          }
        : {}),
    });
  } catch (error) {
    if (loopRun !== undefined) await stopLoopRun(loopRun, 0);
    throw error;
  }
  if (goal.kind === 'loop') {
    if (createdGoal.loopRunId === undefined) {
      throw new Error('Loop contract was created without an authoritative run id.');
    }
    loopRun = await beginLoopRun(createdGoal.loopRunId);
    await registerTuiLoop(createdGoal.goalId, loopRun, session.id, process.cwd());
    track('loop_started');
    if (loopRun.repeatedWithin7d === true) track('loop_repeat_started_7d');
  }
  let completedSnapshot: GoalSnapshot | null = null;
  let firstIterationTracked = false;
  const unsubscribeGoalEvents = session.onEvent((event) => {
    if (
      loopRun !== undefined
      && !firstIterationTracked
      && event.type === 'goal.updated'
      && event.agentId === 'main'
      && event.snapshot?.iteration !== undefined
      && event.snapshot.iteration >= 1
    ) {
      firstIterationTracked = true;
      track('loop_first_iteration');
    }
    if (
      event.type === 'goal.updated' &&
      event.agentId === 'main' &&
      event.change?.kind === 'completion' &&
      event.snapshot !== null
    ) {
      completedSnapshot = event.snapshot;
    }
  });
  let promptFailed = false;
  try {
    // The objective is sent as the normal prompt; goal continuation keeps the
    // turn alive until a terminal state is reached.
    await runPromptTurn(session, goal.objective, outputFormat, stdout, stderr, createdGoal.goalId);
  } catch (error) {
    promptFailed = true;
    if (isTerminating()) {
      if (loopRun !== undefined) {
        const stoppedSnapshot = completedSnapshot
          ?? (await session.getGoal().catch(() => ({ goal: null }))).goal;
        await stopLoopRun(loopRun, stoppedSnapshot?.iteration ?? 0);
      }
      return;
    }
    if (loopRun !== undefined) {
      const failedSnapshot = completedSnapshot
        ?? (await session.getGoal().catch(() => ({ goal: null }))).goal;
      const result = durableLoopResultFromGoal(failedSnapshot) !== undefined
        || failedSnapshot?.providerOutcomeUnknown !== undefined
        ? loopSummaryJson(failedSnapshot)
        : loopRuntimeErrorSummary(
            failedSnapshot,
            error instanceof Error ? error.message : String(error),
          );
      await completeLoopRun(loopRun, result.status, result.iterations);
      track('loop_terminal', {
        outcome: result.status,
        iterations: result.iterations,
        reason_code: result.reasonCode,
      });
      if (outputFormat === 'stream-json') {
        stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        stderr.write(`${formatLoopResultText(result)}\n`);
      }
      process.exitCode = LOOP_EXIT_CODES[result.status];
      return;
    }
    throw error;
  } finally {
    unsubscribeGoalEvents();
    if (!promptFailed) {
      const snapshot = completedSnapshot ?? (await session.getGoal()).goal;
      if (outputFormat === 'stream-json') {
        const summary = goal.kind === 'loop' ? loopSummaryJson(snapshot) : goalSummaryJson(snapshot);
        stdout.write(`${JSON.stringify(summary)}\n`);
      } else {
        const summary = goal.kind === 'loop' ? formatLoopSummaryText(snapshot) : formatGoalSummaryText(snapshot);
        stderr.write(`${summary}\n`);
      }
      // Map the terminal goal status to a distinct, non-fatal exit code. A turn
      // that threw (error / cancellation) already propagates its own exit path.
      if (goal.kind === 'loop') {
        if (loopRun !== undefined) {
          const result = loopSummaryJson(snapshot);
          const completion = await completeLoopRun(loopRun, result.status, result.iterations);
          if (completion?.repeatedCompletedWithin7d) track('loop_repeat_completed_7d');
          track('loop_terminal', {
            outcome: result.status,
            iterations: result.iterations,
            reason_code: result.reasonCode,
          });
        }
        process.exitCode = loopExitCode(snapshot);
      } else {
        const exitCode = goalExitCode(snapshot?.status);
        if (exitCode !== GOAL_EXIT_CODES.complete) process.exitCode = exitCode;
      }
    }
  }
}

interface ResolvedPromptSession {
  readonly session: Session;
  readonly resumed: boolean;
  readonly restorePermission: () => Promise<void>;
  readonly telemetryModel?: string;
  readonly goalModel?: string;
  readonly goalPermission: SessionStatus['permission'];
}

async function resolvePromptSession(
  harness: WukongHarness,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<ResolvedPromptSession> {
  if (opts.session !== undefined) {
    const sessions = await harness.listSessions({ sessionId: opts.session, workDir });
    const target = sessions[0];
    if (target === undefined) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    if (resolve(target.workDir) !== resolve(workDir)) {
      stderr.write(
        `${chalk.hex('#E8A838')(
          `Session "${opts.session}" was created under a different directory.\n` +
            `  cd "${target.workDir}" && wukong -r ${opts.session}`,
        )}\n\n`,
      );
      throw new Error(
        `Session "${opts.session}" was created under a different directory.`,
      );
    }
    const session = await harness.resumeSession({
      id: opts.session,
      additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    });
    const status = await session.getStatus();
    const restorePermission = await forcePromptPermission(
      session,
      status.permission,
      opts.yolo ? 'yolo' : 'auto',
      setRestorePermission,
    );
    if (opts.model !== undefined) {
      await session.setModel(opts.model);
    }
    installHeadlessHandlers(session);
    return {
      session,
      resumed: true,
      restorePermission,
      telemetryModel: configuredModel(opts.model, status.model, defaultModel),
      goalModel: configuredModel(opts.model, status.model),
      goalPermission: opts.yolo ? 'yolo' : 'auto',
    };
  }

  if (opts.continue) {
    const sessions = await harness.listSessions({ workDir });
    const previous = sessions[0];
    if (previous !== undefined) {
      const session = await harness.resumeSession({
        id: previous.id,
        additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
      });
      const status = await session.getStatus();
      const restorePermission = await forcePromptPermission(
        session,
        status.permission,
        opts.yolo ? 'yolo' : 'auto',
        setRestorePermission,
      );
      if (opts.model !== undefined) {
        await session.setModel(opts.model);
      }
      installHeadlessHandlers(session);
      return {
        session,
        resumed: true,
        restorePermission,
        telemetryModel: configuredModel(opts.model, status.model, defaultModel),
        goalModel: configuredModel(opts.model, status.model),
        goalPermission: opts.yolo ? 'yolo' : 'auto',
      };
    }
    stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const session = await harness.createSession({
    workDir,
    model,
    // Persist the safe baseline. Headless elevation is process-scoped below so
    // a crash or later `-r` can never inherit Auto/YOLO.
    permission: 'manual',
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
  });
  installHeadlessHandlers(session);
  const restorePermission = await forcePromptPermission(
    session,
    'manual',
    opts.yolo ? 'yolo' : 'auto',
    setRestorePermission,
  );
  return {
    session,
    resumed: false,
    restorePermission,
    telemetryModel: model,
    goalModel: model,
    goalPermission: opts.yolo ? 'yolo' : 'auto',
  };
}

async function forcePromptPermission(
  session: Session,
  previousPermission: SessionStatus['permission'],
  desiredPermission: SessionStatus['permission'],
  setRestorePermission: (restorePermission: () => Promise<void>) => void,
): Promise<() => Promise<void>> {
  let overridePermission: Promise<void> | undefined;
  const restorePermission = async () => {
    await overridePermission?.catch(() => {});
    if (previousPermission !== desiredPermission) {
      await session.setPermission(previousPermission, { transient: true });
    }
  };
  setRestorePermission(restorePermission);
  if (previousPermission !== desiredPermission) {
    overridePermission = session.setPermission(desiredPermission, { transient: true });
    await overridePermission;
  }
  return restorePermission;
}

function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `wukong` and use /provider to add your model API key, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

function installHeadlessHandlers(session: Session): void {
  session.setApprovalHandler(() => ({ decision: 'approved' }));
  session.setQuestionHandler(() => null);
}

function installPromptTerminationCleanup(
  promptProcess: PromptProcess,
  cleanup: () => Promise<void>,
  beforeCleanup?: (signal: NodeJS.Signals) => Promise<void>,
): () => void {
  let terminating = false;
  const exitAfterCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await beforeCleanup?.(signal);
      await cleanup();
    } finally {
      promptProcess.exit(signalExitCode(signal));
    }
  };
  const onSigint = () => exitAfterCleanup('SIGINT');
  const onSigterm = () => exitAfterCleanup('SIGTERM');
  const onSighup = () => exitAfterCleanup('SIGHUP');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  promptProcess.once('SIGHUP', onSighup);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
    promptProcess.off('SIGHUP', onSighup);
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}

interface PromptTurnFacts {
  readonly steps: number;
  readonly toolNames: readonly string[];
  readonly commands: readonly string[];
  readonly providerOutcomeUnknown?: PromptProviderOutcomeUnknown;
}

interface PromptProviderOutcomeUnknown {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly state: 'started' | 'outcome_unknown';
  readonly outputObserved: boolean;
}

type StoppedProviderOutcomeUnknown = Pick<
  PromptProviderOutcomeUnknown,
  'requestId' | 'idempotencyKey'
>;

class PromptTurnFailure extends Error {
  readonly facts: PromptTurnFacts;

  constructor(error: Error, facts: PromptTurnFacts) {
    super(error.message, { cause: error });
    this.name = 'PromptTurnFailure';
    this.facts = facts;
  }
}

function promptTurnFactsFromError(error: unknown): PromptTurnFacts {
  return error instanceof PromptTurnFailure
    ? error.facts
    : { steps: 0, toolNames: [], commands: [] };
}

function providerOutcomeUnknownFromDetails(
  details: Record<string, unknown> | undefined,
): PromptProviderOutcomeUnknown | undefined {
  const value = details?.['providerOutcomeUnknown'];
  if (typeof value !== 'object' || value === null) return undefined;
  const requestId = Reflect.get(value, 'requestId');
  const idempotencyKey = Reflect.get(value, 'idempotencyKey');
  const state = Reflect.get(value, 'state');
  const outputObserved = Reflect.get(value, 'outputObserved');
  if (
    typeof requestId !== 'string'
    || typeof idempotencyKey !== 'string'
    || (state !== 'started' && state !== 'outcome_unknown')
  ) return undefined;
  return {
    requestId,
    idempotencyKey,
    state,
    outputObserved: outputObserved === true,
  };
}

function runPromptTurn(
  session: Session,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
  goalId?: string,
): Promise<PromptTurnFacts> {
  let activeTurnId: number | undefined;
  const openTurnIds = new Set<number>();
  let goalTerminalObserved = false;
  let pendingGoalError: Error | undefined;
  let steps = 0;
  let providerOutcomeUnknown: PromptProviderOutcomeUnknown | undefined;
  let lastGoalIteration = 0;
  const toolNames = new Set<string>();
  const commands = new Set<string>();
  const turnStartedAt = Date.now();
  const outputWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  return new Promise<PromptTurnFacts>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      outputWriter.finish();
      if (error !== undefined) {
        reject(new PromptTurnFailure(error, {
          steps,
          toolNames: [...toolNames],
          commands: [...commands],
          ...(providerOutcomeUnknown === undefined ? {} : { providerOutcomeUnknown }),
        }));
        return;
      }
      resolve({
        steps,
        toolNames: [...toolNames],
        commands: [...commands],
        ...(providerOutcomeUnknown === undefined ? {} : { providerOutcomeUnknown }),
      });
    };

    unsubscribe = session.onEvent((event) => {
      if (event.type === 'error') {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        providerOutcomeUnknown ??= providerOutcomeUnknownFromDetails(event.details);
        const error = new Error(`${event.code}: ${event.message}`);
        pendingGoalError ??= error;
        if (goalId !== undefined && goalTerminalObserved && openTurnIds.size === 0) {
          finish(pendingGoalError);
        }
        return;
      }
      if (event.type === 'goal.updated' && goalId !== undefined && event.agentId === PROMPT_MAIN_AGENT_ID) {
        const iteration = event.snapshot?.iteration ?? 0;
        if (iteration > lastGoalIteration) {
          lastGoalIteration = iteration;
          outputWriter.writeProgress(
            `${formatElapsed(Date.now() - turnStartedAt)} Writer iteration ${String(iteration)}`,
          );
        }
        if (
          (event.snapshot !== null && event.snapshot.goalId === goalId && event.snapshot.status !== 'active')
          || (event.snapshot === null && event.change?.kind === 'completion')
        ) {
          goalTerminalObserved = true;
          if (openTurnIds.size === 0) finish(pendingGoalError);
        }
        return;
      }
      if (event.type === 'turn.started') {
        if (event.agentId !== PROMPT_MAIN_AGENT_ID) {
          return;
        }
        if (goalId === undefined && activeTurnId !== undefined) return;
        activeTurnId ??= event.turnId;
        openTurnIds.add(event.turnId);
        return;
      }
      if (
        activeTurnId === undefined ||
        !hasTurnId(event) ||
        event.agentId !== PROMPT_MAIN_AGENT_ID ||
        (goalId === undefined ? event.turnId !== activeTurnId : !openTurnIds.has(event.turnId))
      ) {
        return;
      }
      switch (event.type) {
        case 'turn.step.started':
          steps += 1;
          return;
        case 'turn.step.interrupted':
          outputWriter.flushAssistant();
          return;
        case 'turn.step.retrying':
          outputWriter.discardAssistant();
          return;
        case 'assistant.delta':
          outputWriter.writeAssistantDelta(event.delta);
          return;
        case 'hook.result':
          outputWriter.writeHookResult(event);
          return;
        case 'thinking.delta':
          outputWriter.writeThinkingDelta(event.delta);
          return;
        case 'tool.call.started':
          toolNames.add(event.name);
          {
            const command = commandFromToolArgs(event.args);
            if (command !== undefined) commands.add(command);
            outputWriter.writeProgress(
              `${formatElapsed(Date.now() - turnStartedAt)} Running ${event.name}${command === undefined ? '' : `: ${command}`}`,
            );
          }
          outputWriter.writeToolCall(event.toolCallId, event.name, event.args);
          return;
        case 'tool.call.delta':
          outputWriter.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
          return;
        case 'tool.result':
          outputWriter.writeToolResult(event.toolCallId, event.output);
          return;
        case 'tool.progress':
          // Provider/tool progress can contain large raw logs. The stable
          // phase/tool line emitted at tool.call.started is the headless UI;
          // detailed output remains in the durable session transcript.
          return;
        case 'turn.ended':
          openTurnIds.delete(event.turnId);
          providerOutcomeUnknown ??= providerOutcomeUnknownFromDetails(event.error?.details);
          if (event.reason === 'completed') {
            if (pendingGoalError !== undefined) {
              if (goalId === undefined || goalTerminalObserved) finish(pendingGoalError);
              return;
            }
            if (goalId === undefined || goalTerminalObserved) finish();
            return;
          }
          {
            const error = new Error(formatTurnEndedFailure(event));
            if (goalId !== undefined) {
              pendingGoalError ??= error;
              if (goalTerminalObserved) finish(pendingGoalError);
              return;
            }
            finish(error);
          }
          return;
        case 'agent.status.updated':
        case 'background.task.started':
        case 'background.task.terminated':
        case 'compaction.blocked':
        case 'compaction.cancelled':
        case 'compaction.completed':
        case 'compaction.started':
        case 'cron.fired':
        case 'goal.updated':
        case 'mcp.server.status':
        case 'session.meta.updated':
        case 'skill.activated':
        case 'subagent.completed':
        case 'subagent.failed':
        case 'subagent.spawned':
        case 'subagent.started':
        case 'subagent.suspended':
        case 'tool.list.updated':
        case 'turn.step.completed':
        case 'warning':
          return;
        case "event.config.changed":
        case "event.model_catalog.changed":
        case "event.session.created":
        case "event.session.status_changed":
        case "event.workspace.created":
        case "event.workspace.deleted":
        case "event.workspace.updated":
        case "prompt.submitted":
        case "shell.output":
        case "shell.started":
          return;
      }
    });

    session.prompt(prompt).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

interface PromptTurnWriter {
  writeAssistantDelta(delta: string): void;
  writeHookResult(event: HookResultEvent): void;
  writeThinkingDelta(delta: string): void;
  writeToolCall(toolCallId: string, name: string, args: unknown): void;
  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void;
  writeToolResult(toolCallId: string, output: unknown): void;
  writeProgress(message: string): void;
  flushAssistant(): void;
  discardAssistant(): void;
  finish(): void;
}

class PromptTranscriptWriter implements PromptTurnWriter {
  private readonly assistantWriter: PromptBlockWriter;
  private readonly thinkingWriter: PromptBlockWriter;

  constructor(stdout: PromptOutput, stderr: PromptOutput) {
    this.assistantWriter = new PromptBlockWriter(stdout);
    this.thinkingWriter = new PromptBlockWriter(stderr);
  }

  writeAssistantDelta(delta: string): void {
    this.thinkingWriter.finish();
    this.assistantWriter.write(delta);
  }

  writeHookResult(event: HookResultEvent): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
    this.assistantWriter.write(formatHookResultPlain(event));
    this.assistantWriter.finish();
  }

  writeThinkingDelta(delta: string): void {
    this.thinkingWriter.write(delta);
  }

  writeToolCall(): void {}

  writeToolCallDelta(): void {}

  writeToolResult(): void {}

  writeProgress(message: string): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
    this.thinkingWriter.write(`[run] ${message}`);
    this.thinkingWriter.finish();
  }

  flushAssistant(): void {}

  discardAssistant(): void {}

  finish(): void {
    this.thinkingWriter.finish();
    this.assistantWriter.finish();
  }
}

interface PromptJsonToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface PromptJsonAssistantMessage {
  role: 'assistant';
  content?: string;
  tool_calls?: PromptJsonToolCall[];
}

interface PromptJsonToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

interface PromptJsonResumeMetaMessage {
  role: 'meta';
  type: 'session.resume_hint';
  session_id: string;
  command: string;
  content: string;
}

interface PromptJsonProgressMetaMessage {
  role: 'meta';
  type: 'run.progress';
  content: string;
}

function writeResumeHint(
  sessionId: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): void {
  const command = `wukong -r ${sessionId}`;
  const content = `To resume this session: ${command}`;
  if (outputFormat === 'stream-json') {
    const message: PromptJsonResumeMetaMessage = {
      role: 'meta',
      type: 'session.resume_hint',
      session_id: sessionId,
      command,
      content,
    };
    stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  stderr.write(`${content}\n`);
}

class PromptJsonWriter implements PromptTurnWriter {
  private assistantText = '';
  private readonly toolCalls: PromptJsonToolCall[] = [];

  constructor(private readonly stdout: PromptOutput) {}

  writeAssistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  writeHookResult(event: HookResultEvent): void {
    this.flushAssistant();
    this.writeJsonLine({
      role: 'assistant',
      content: formatHookResultPlain(event),
    });
  }

  writeThinkingDelta(): void {}

  writeToolCall(toolCallId: string, name: string, args: unknown): void {
    const existing = this.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    if (existing !== undefined) {
      existing.function.name = name;
      existing.function.arguments = stringifyJsonValue(args);
      return;
    }
    this.toolCalls.push({
      type: 'function',
      id: toolCallId,
      function: {
        name,
        arguments: stringifyJsonValue(args),
      },
    });
  }

  writeToolCallDelta(
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void {
    const toolCall = this.findOrCreateToolCall(toolCallId, name ?? '');
    if (name !== undefined) {
      toolCall.function.name = name;
    }
    if (argumentsPart !== undefined) {
      toolCall.function.arguments += argumentsPart;
    }
  }

  writeToolResult(toolCallId: string, output: unknown): void {
    this.flushAssistant();
    this.writeJsonLine({
      role: 'tool',
      tool_call_id: toolCallId,
      content: stringifyToolOutput(output),
    });
  }

  writeProgress(message: string): void {
    this.flushAssistant();
    this.writeJsonLine({ role: 'meta', type: 'run.progress', content: message });
  }

  flushAssistant(): void {
    if (this.assistantText.length === 0 && this.toolCalls.length === 0) return;
    const message: PromptJsonAssistantMessage = {
      role: 'assistant',
      content: this.assistantText.length > 0 ? this.assistantText : undefined,
      tool_calls: this.toolCalls.length > 0 ? [...this.toolCalls] : undefined,
    };
    this.writeJsonLine(message);
    this.discardAssistant();
  }

  discardAssistant(): void {
    this.assistantText = '';
    this.toolCalls.length = 0;
  }

  finish(): void {
    this.flushAssistant();
  }

  private findOrCreateToolCall(toolCallId: string, name: string): PromptJsonToolCall {
    const existing = this.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    if (existing !== undefined) return existing;
    const toolCall: PromptJsonToolCall = {
      type: 'function',
      id: toolCallId,
      function: {
        name,
        arguments: '',
      },
    };
    this.toolCalls.push(toolCall);
    return toolCall;
  }

  private writeJsonLine(
    message: PromptJsonAssistantMessage | PromptJsonToolMessage | PromptJsonProgressMetaMessage,
  ): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

class PromptBlockWriter {
  private started = false;
  private atLineStart = false;
  private lineWidth = 0;
  private readonly wrapWidth: number | undefined;

  constructor(private readonly output: PromptOutput) {
    this.wrapWidth =
      typeof output.columns === 'number' && output.columns > PROMPT_BLOCK_INDENT.length + 1
        ? output.columns
        : undefined;
  }

  write(chunk: string): void {
    if (chunk.length === 0) return;
    let rendered = this.start();
    for (const char of chunk) {
      if (this.atLineStart && char !== '\n') {
        rendered += PROMPT_BLOCK_INDENT;
        this.atLineStart = false;
        this.lineWidth = PROMPT_BLOCK_INDENT.length;
      }
      const charWidth = visibleCharWidth(char);
      if (
        this.wrapWidth !== undefined &&
        !this.atLineStart &&
        char !== '\n' &&
        this.lineWidth + charWidth > this.wrapWidth
      ) {
        rendered += `\n${PROMPT_BLOCK_INDENT}`;
        this.lineWidth = PROMPT_BLOCK_INDENT.length;
      }
      rendered += char;
      if (char === '\n') {
        this.atLineStart = true;
        this.lineWidth = 0;
      } else {
        this.lineWidth += charWidth;
      }
    }
    this.output.write(rendered);
  }

  finish(): void {
    if (!this.started) return;
    this.output.write(this.atLineStart ? '\n' : '\n\n');
    this.started = false;
    this.atLineStart = false;
    this.lineWidth = 0;
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    this.atLineStart = false;
    this.lineWidth = PROMPT_BLOCK_BULLET.length;
    return PROMPT_BLOCK_BULLET;
  }
}

function visibleCharWidth(char: string): number {
  return char === '\t' ? 4 : 1;
}

function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return `${event.hookEvent} hook${event.blocked === true ? ' blocked' : ''}`;
}

function formatHookResultBody(event: HookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? '(empty)' : content;
}

function stringifyJsonValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json ?? '';
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const json = JSON.stringify(output);
  return json ?? String(output);
}

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function formatTurnEndedFailure(event: Extract<Event, { type: 'turn.ended' }>): string {
  if (event.error !== undefined) return `${event.error.code}: ${event.error.message}`;
  if (event.reason === 'filtered') {
    return 'Provider safety policy blocked the response.';
  }
  return `Prompt turn ended with reason: ${event.reason}`;
}

interface PromptPreflightReportInput {
  readonly prompt: string;
  readonly model?: string;
  readonly permission: SessionStatus['permission'];
  readonly workspace: string;
  readonly outputFormat: PromptOutputFormat;
  readonly stdout: PromptOutput;
  readonly stderr: PromptOutput;
}

function writePromptPreflight(input: PromptPreflightReportInput): void {
  const goal = oneLine(input.prompt, 160);
  const permissionPolicy = input.permission === 'auto'
    ? 'Routine actions are automatic; approval and high-risk boundaries stop the run.'
    : input.permission === 'yolo'
      ? 'Explicit YOLO mode is active for this process only.'
      : 'Manual approval is required for guarded actions.';
  const report = {
    role: 'meta' as const,
    type: 'run.preflight' as const,
    schema_version: 1,
    goal,
    finish_line: 'Single model turn; completion is not verification.',
    model: input.model ?? null,
    permission: input.permission,
    permission_policy: permissionPolicy,
    workspace: input.workspace,
    cancellation: 'Ctrl-C',
  };
  if (input.outputFormat === 'stream-json') {
    input.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  input.stderr.write([
    'Run preflight',
    `  Goal       ${goal}`,
    '  Finish     Single model turn; completion is not verification.',
    `  Model      ${input.model ?? 'not configured'}`,
    `  Permission ${input.permission} — ${permissionPolicy}`,
    `  Workspace  ${input.workspace}`,
    '  Cancel     Ctrl-C',
    '',
  ].join('\n'));
}

interface PromptRunSummaryInput {
  readonly outcome: 'COMPLETED' | 'ERROR';
  readonly exitCode: number;
  readonly exitMeaning: string;
  readonly sessionId: string;
  readonly outputFormat: PromptOutputFormat;
  readonly stdout: PromptOutput;
  readonly stderr: PromptOutput;
  readonly durationMs: number;
  readonly usage: SessionUsage;
  readonly workspaceBefore: GitInspection;
  readonly workspaceAfter: GitInspection;
  readonly facts: PromptTurnFacts;
}

function writePromptRunSummary(input: PromptRunSummaryInput): void {
  const tokenCount = totalTokens(input.usage);
  const verificationTools = input.facts.toolNames.filter((name) => (
    /(?:verify|proof|scan|test)/i.test(name)
  ));
  const checks = verificationTools.length === 0
    ? 'not run or not recorded'
    : `invoked via ${verificationTools.join(', ')}; no terminal PASS was bound`;
  const changedFiles = input.workspaceAfter.changedFiles;
  const attributable = input.workspaceBefore.changedFiles.length === 0
    ? changedFiles
    : undefined;
  const resumeCommand = `wukong -r ${input.sessionId}`;
  const unknown = input.facts.providerOutcomeUnknown;
  const nextActions = unknown === undefined
    ? [
        changedFiles.length > 0 ? 'Review `git diff`.' : 'No workspace changes are currently recorded.',
        checks.startsWith('not run') ? 'Run the relevant checks before keeping the result.' : 'Review the recorded check output.',
        'Explicitly keep or revert changes after review.',
        `Export evidence with \`wukong export ${input.sessionId}\`.`,
      ]
    : [
        `Check provider logs or billing for request ${unknown.requestId} using idempotency key ${unknown.idempotencyKey}.`,
        'Do not resume or retry blindly; start a new request only after confirming it is safe.',
        'Review and explicitly keep or revert workspace changes.',
      ];
  const report = {
    role: 'meta' as const,
    type: 'run.summary' as const,
    schema_version: 1,
    outcome: input.outcome,
    exit_code: input.exitCode,
    exit_meaning: input.exitMeaning,
    duration_ms: input.durationMs,
    usage_tokens: tokenCount,
    cost: null,
    workspace: {
      dirty_before: input.workspaceBefore.changedFiles.length > 0,
      changed_files: changedFiles,
      introduced_by_run: attributable ?? null,
      attribution: attributable === undefined
        ? 'unknown_preexisting_changes'
        : 'workspace_was_clean_before_run',
    },
    activity: {
      steps: input.facts.steps,
      tools: input.facts.toolNames,
      commands: input.facts.commands,
    },
    checks,
    evidence: 'No durable Goal/Loop PASS evidence is attached to a normal prompt turn.',
    session_id: input.sessionId,
    resume_command: unknown === undefined ? resumeCommand : null,
    provider_outcome_unknown: unknown ?? null,
    next_actions: nextActions,
  };
  if (input.outputFormat === 'stream-json') {
    input.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const changedSummary = changedFiles.length === 0
    ? 'clean'
    : `${String(changedFiles.length)} changed file(s)`;
  const attribution = attributable === undefined
    ? 'run attribution unknown because the workspace was already dirty'
    : `${String(attributable.length)} introduced while this run was active`;
  input.stderr.write([
    '',
    `Outcome    ${input.outcome}`,
    `Exit       ${String(input.exitCode)} — ${input.exitMeaning}`,
    `Activity   ${String(input.facts.steps)} step(s) · ${String(input.facts.toolNames.length)} tool(s) · ${String(input.facts.commands.length)} command(s)`,
    `Time       ${formatElapsed(input.durationMs)} · Tokens ${tokenCount === null ? 'unknown' : String(tokenCount)} · Cost unavailable`,
    `Workspace  ${changedSummary}; ${attribution}`,
    `Checks     ${checks}`,
    'Evidence   no durable Goal/Loop PASS evidence',
    ...(unknown === undefined ? [] : [
      `Provider   UNKNOWN · request ${unknown.requestId}`,
      `Idempotency ${unknown.idempotencyKey}`,
      'Cost       request may already have been accepted or billed',
    ]),
    `Session    ${input.sessionId}`,
    ...(unknown === undefined ? [`Resume     ${resumeCommand}`] : []),
    `Export     wukong export ${input.sessionId}`,
    `Next       ${unknown === undefined
      ? `${changedFiles.length > 0 ? 'Review `git diff`; ' : ''}${checks.startsWith('not run') ? 'run checks; ' : ''}explicitly keep or revert changes.`
      : 'Reconcile provider logs/billing; do not resume or retry blindly; then explicitly decide whether a new request is safe.'}`,
    '',
  ].join('\n'));
}

interface StoppedRunSummaryInput {
  readonly signal: NodeJS.Signals;
  readonly sessionId: string;
  readonly outputFormat: PromptOutputFormat;
  readonly stdout: PromptOutput;
  readonly stderr: PromptOutput;
  readonly durationMs: number;
  readonly providerOutcomeUnknown?: StoppedProviderOutcomeUnknown;
  readonly workspace?: GitInspection;
}

function writeStoppedRunSummary(input: StoppedRunSummaryInput): void {
  const exitCode = signalExitCode(input.signal);
  const resumeCommand = `wukong -r ${input.sessionId}`;
  const unknown = input.providerOutcomeUnknown;
  const changedFiles = input.workspace?.changedFiles ?? [];
  const nextActions = unknown === undefined
    ? [
        'Review the workspace diff.',
        `Resume with \`${resumeCommand}\`.`,
        'Keep or revert changes explicitly.',
      ]
    : [
        `Check provider logs or billing for request ${unknown.requestId} using idempotency key ${unknown.idempotencyKey}.`,
        'Do not resume blindly; cancel and explicitly start a new attempt only after confirming it is safe.',
        'Review and explicitly keep or revert workspace changes.',
      ];
  const report = {
    role: 'meta' as const,
    type: 'run.summary' as const,
    schema_version: 1,
    outcome: 'STOPPED_BY_USER' as const,
    signal: input.signal,
    exit_code: exitCode,
    duration_ms: input.durationMs,
    session_id: input.sessionId,
    resume_command: unknown === undefined ? resumeCommand : null,
    provider_outcome_unknown: unknown ?? null,
    workspace: {
      changed_files: changedFiles,
      attribution: 'unknown_at_interruption',
    },
    evidence: 'The interrupted run is not verified.',
    next_actions: nextActions,
  };
  if (input.outputFormat === 'stream-json') {
    input.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  input.stderr.write([
    '',
    'Outcome    STOPPED_BY_USER',
    `Exit       ${String(exitCode)} — ${input.signal}`,
    `Time       ${formatElapsed(input.durationMs)} · Cost unavailable`,
    'Evidence   interrupted; not verified',
    `Workspace  ${changedFiles.length === 0 ? 'no changes recorded' : `${String(changedFiles.length)} changed file(s); attribution unknown`}`,
    ...(unknown === undefined ? [] : [
      `Provider   UNKNOWN · request ${unknown.requestId}`,
      `Idempotency ${unknown.idempotencyKey}`,
    ]),
    `Session    ${input.sessionId}`,
    ...(unknown === undefined ? [`Resume     ${resumeCommand}`] : []),
    `Next       ${unknown === undefined
      ? 'Review the diff, then resume or explicitly keep/revert changes.'
      : 'Reconcile provider logs/billing; do not resume blindly; then explicitly cancel/start a new attempt if safe.'}`,
    '',
  ].join('\n'));
}

function commandFromToolArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('command' in args)) return undefined;
  const command = args.command;
  return typeof command === 'string' && command.trim().length > 0
    ? oneLine(command, 160)
    : undefined;
}

function totalTokens(usage: SessionUsage): number | null {
  const total = usage.total;
  if (total === undefined) return null;
  return total.inputOther + total.output + total.inputCacheRead + total.inputCacheCreation;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatElapsed(durationMs: number): string {
  if (durationMs < 1000) return `${String(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
