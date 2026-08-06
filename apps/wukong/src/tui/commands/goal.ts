import {
  ErrorCodes,
  isWukongError,
  type GoalSnapshot,
  type LoopContractV2Input,
  type LoopContractV3Input,
  type PermissionMode,
} from '@wukong/wukong-sdk';
import {
  createBrokerReviewTrustProposal,
  type BrokerReviewTrustBindingV1,
  type FinishLineProposal,
} from '@wukong/verification';

import { parseLoopDuration } from '#/utils/duration';
import {
  beginLoopRun,
  registerTuiLoop,
  stopLoopRun,
  stopTuiLoop,
} from '#/cli/lib/loop-lifecycle';
import {
  formatLoopPreflightBlocked,
  formatLoopPreflightReady,
  confirmLoopReviewSettings,
  createLoopReviewSettingsProposal,
  resolveLoopReviewProvider,
  runLoopPreflight,
  type LoopPreflightReady,
  type DiscoveredCheckDecision,
} from '#/cli/lib/loop-preflight';
import {
  brokerReviewTrustBinding,
  findBrokerReviewTrust,
  findWorkspaceTrust,
  grantBrokerReviewTrustLocally,
  grantWorkspaceTrust,
  type WorkspaceTrustGrant,
} from '#/cli/lib/workspace-trust';

import {
  FinishLineEditorComponent,
  type FinishLineDraft,
} from '../components/dialogs/finish-line-editor';
import {
  FinishLineReviewComponent,
  type FinishLineReviewChoice,
} from '../components/dialogs/finish-line-review';
import {
  VerificationCriteriaSelectorComponent,
  type VerificationCriteriaChoice,
} from '../components/dialogs/verification-criteria-selector';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  GoalStartPermissionPromptComponent,
  type GoalStartPermissionChoice,
} from '../components/dialogs/goal-start-permission-prompt';
import {
  GoalQueueEditDialogComponent,
  GoalQueueManagerComponent,
  type GoalQueueEditResult,
  type GoalQueueManagerAction,
} from '../components/dialogs/goal-queue-manager';
import {
  GoalSetMessageComponent,
  GoalStatusMessageComponent,
  UpcomingGoalAddedMessageComponent,
} from '../components/messages/goal-panel';
import { LLM_NOT_SET_MESSAGE } from '../constant/wukong-tui';
import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  updateGoalQueueItem,
  type GoalQueueSnapshot,
} from '../goal-queue-store';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const RESUME_GOAL_INPUT = 'Resume the active goal.';
const START_NEXT_GOAL_NOW_MESSAGE = 'No active goal. Starting this goal now.';

type GoalCommandHost = Pick<
  SlashCommandHost,
  | 'state'
  | 'session'
  | 'requireSession'
  | 'setAppState'
  | 'showError'
  | 'showStatus'
  | 'track'
  | 'mountEditorReplacement'
  | 'restoreEditor'
  | 'restoreInputText'
  | 'sendNormalUserInput'
>;

export interface GoalStartOptions {
  readonly commandName?: 'goal' | 'loop';
  readonly prepareCreate?: () => Promise<{
    readonly maxIterations?: number;
    readonly completionCriterion?: string;
    readonly loopContract?: LoopContractV2Input | LoopContractV3Input;
    readonly workspaceChangeBaseline?: {
      readonly files: readonly { readonly path: string; readonly status: string }[];
    };
  } | false>;
  readonly afterCreate?: (snapshot: GoalSnapshot) => void | Promise<void>;
  readonly onCreateError?: () => void | Promise<void>;
  readonly beforeSend?: () => boolean | Promise<boolean>;
  readonly sendInput?: (objective: string) => void;
}

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly replace: boolean;
      readonly stopCondition?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
      readonly maxIterations?: number;
      readonly minIntervalMs?: number;
      readonly reviewModel?: string;
      readonly writerProviderCallLimit?: number;
      readonly reviewerProviderCallLimit?: number;
      readonly tokenBudget?: number;
    }
  | { readonly kind: 'next-add'; readonly objective: string }
  | { readonly kind: 'next-manage' }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'cancel']);

/**
 * Parses the deterministic `/goal` command grammar. Reserved subcommands
 * (`pause`/`resume`/`cancel`/`status`/`replace`) are only honored as the first
 * token; use `/goal -- <objective>` to start a goal whose text begins with one
 * of those words. (`cancel` is the single discard action — it removes the
 * current goal.) Stop conditions are expressed in the objective in natural
 * language (e.g. "…or stop after 20 turns"); the model honors them when it
 * self-audits each turn and reports `complete`/`blocked` via UpdateGoal.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first === 'next') {
    return parseNextGoalCommand(tokens);
  }
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'cancel' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  // (e.g. `/goal -- pause the rollout`).
  if (tokens[index] === '--') {
    index += 1;
  }

  const stopCondition = parseStopCondition(tokens, index);
  if (stopCondition.consumed > 0) {
    index += stopCondition.consumed;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    // A usage hint, not a failure — shown in the same calm style as the other
    // "nothing to act on" messages (no goal to pause/resume/cancel).
    return {
      kind: 'error',
      severity: 'hint',
      message: 'Provide a goal objective, e.g. `/goal Ship feature X`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Reference long details by file path.`,
    };
  }
  return { kind: 'create', objective, replace, stopCondition: stopCondition.condition };
}

function parseStopCondition(
  tokens: readonly string[],
  startIndex: number,
): { readonly condition?: 'proof-pass'; readonly consumed: number } {
  if (tokens[startIndex] !== '--until') return { consumed: 0 };
  const value = tokens[startIndex + 1];
  if (value !== 'proof-pass' && value !== 'verify-pass' && value !== 'scan-clean' && value !== 'judge-pass') {
    return { consumed: 0 };
  }
  return { condition: 'proof-pass', consumed: 2 };
}

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
      return;
    case 'status':
      await showGoalStatus(host);
      return;
    case 'pause':
      await pauseGoal(host);
      return;
    case 'resume':
      await resumeGoal(host);
      return;
    case 'cancel':
      await cancelGoal(host);
      return;
    case 'next-add':
      await queueNextGoal(host, parsed);
      return;
    case 'next-manage':
      await showGoalQueueManager(host);
      return;
    case 'create':
      await createGoal(host, parsed, args);
      return;
  }
}

function parseNextGoalCommand(tokens: readonly string[]): ParsedGoalCommand {
  if (tokens.length === 2 && tokens[1] === 'manage') return { kind: 'next-manage' };
  let index = 1;
  if (tokens[index] === '--') index += 1;
  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Reference long details by file path.`,
    };
  }
  return { kind: 'next-add', objective };
}

async function queueNextGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'next-add' }>,
): Promise<void> {
  const session = host.requireSession();
  let hasCurrentGoal: boolean;
  try {
    const { goal } = await session.getGoal();
    hasCurrentGoal = goal !== null;
  } catch (error) {
    host.showError(`Failed to inspect current goal: ${formatErrorMessage(error)}`);
    return;
  }

  if (!hasCurrentGoal && !isBusy(host)) {
    host.showStatus(START_NEXT_GOAL_NOW_MESSAGE);
    await createGoal(
      host,
      { kind: 'create', objective: parsed.objective, replace: false },
      `next ${parsed.objective}`,
    );
    return;
  }

  try {
    await appendGoalQueueItem(session, { objective: parsed.objective });
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_queue_append');
  if (!hasCurrentGoal) host.requestQueuedGoalPromotion?.();
  host.state.transcriptContainer.addChild(
    new UpcomingGoalAddedMessageComponent(),
  );
  host.state.ui.requestRender();
}

async function showGoalQueueManager(
  host: SlashCommandHost,
  selectedGoalId?: string,
): Promise<void> {
  let snapshot: GoalQueueSnapshot;
  try {
    snapshot = await readGoalQueue(host.requireSession());
  } catch (error) {
    host.showError(`Failed to load upcoming goals: ${formatErrorMessage(error)}`);
    return;
  }

  host.track('goal_queue_manage');
  host.mountEditorReplacement(
    new GoalQueueManagerComponent({
      goals: snapshot.goals,
      selectedGoalId,
      onAction: async (action) => {
        try {
          return await handleGoalQueueManagerAction(host, action);
        } catch (error) {
          host.showError(`Failed to update upcoming goals: ${formatErrorMessage(error)}`);
          return undefined;
        }
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function handleGoalQueueManagerAction(
  host: SlashCommandHost,
  action: GoalQueueManagerAction,
): Promise<GoalQueueSnapshot | void> {
  const session = host.requireSession();
  switch (action.kind) {
    case 'move': {
      const snapshot = await moveGoalQueueItem(session, {
        goalId: action.goalId,
        direction: action.direction,
      });
      host.track('goal_queue_move', { direction: action.direction });
      return snapshot;
    }
    case 'delete': {
      const snapshot = await removeGoalQueueItem(session, { goalId: action.goalId });
      host.track('goal_queue_remove');
      return snapshot;
    }
    case 'edit':
      await showGoalQueueEditDialog(host, action.goalId);
      return;
  }
}

async function showGoalQueueEditDialog(
  host: SlashCommandHost,
  goalId: string,
): Promise<void> {
  let snapshot: GoalQueueSnapshot;
  try {
    snapshot = await readGoalQueue(host.requireSession());
  } catch (error) {
    host.showError(`Failed to load upcoming goals: ${formatErrorMessage(error)}`);
    return;
  }

  const goal = snapshot.goals.find((item) => item.id === goalId);
  if (goal === undefined) {
    host.showStatus('Queued goal no longer exists.');
    await showGoalQueueManager(host);
    return;
  }

  host.mountEditorReplacement(
    new GoalQueueEditDialogComponent({
      goal,
      onDone: (result) => {
        void handleGoalQueueEditResult(host, result).catch((error: unknown) => {
          host.showError(`Failed to update upcoming goal: ${formatErrorMessage(error)}`);
        });
      },
    }),
  );
}

async function handleGoalQueueEditResult(
  host: SlashCommandHost,
  result: GoalQueueEditResult,
): Promise<void> {
  if (result.kind === 'cancel') {
    await showGoalQueueManager(host, result.goalId);
    return;
  }

  await updateGoalQueueItem(host.requireSession(), {
    goalId: result.goalId,
    objective: result.objective,
  });
  host.track('goal_queue_update');
  await showGoalQueueManager(host, result.goalId);
}

export async function createGoal(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  rawArgs?: string,
  options: GoalStartOptions = {},
): Promise<boolean> {
  // A goal must be able to start a model turn; refuse to create one otherwise.
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return false;
  }

  if (
    host.state.appState.permissionMode === 'manual' ||
    host.state.appState.permissionMode === 'yolo'
  ) {
    showGoalStartPermissionPrompt(host, parsed, rawArgs ?? parsed.objective, options);
    return false;
  }

  return startGoal(host, parsed, options);
}

function showGoalStartPermissionPrompt(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  rawArgs: string,
  options: GoalStartOptions,
): void {
  const commandText = `/${options.commandName ?? 'goal'} ${rawArgs.trim()}`;
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus('Goal not started.');
  };
  host.mountEditorReplacement(
    new GoalStartPermissionPromptComponent({
      mode: host.state.appState.permissionMode === 'yolo' ? 'yolo' : 'manual',
      onSelect: (choice) => {
        if (choice === 'cancel') {
          cancelStart();
          return;
        }
        host.restoreEditor();
        void startGoalWithPermission(host, parsed, choice, options);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startGoalWithPermission(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  choice: GoalStartPermissionChoice,
  options: GoalStartOptions,
): Promise<void> {
  const previousPermission = host.state.appState.permissionMode;
  let permissionChanged = false;
  if (choice !== host.state.appState.permissionMode && (choice === 'auto' || choice === 'yolo')) {
    if (!(await setPermissionForGoal(host, choice))) return;
    permissionChanged = true;
  }
  let started = false;
  try {
    started = await startGoal(host, parsed, options);
  } catch (error) {
    host.showError(`Failed to start goal: ${formatErrorMessage(error)}`);
  } finally {
    if (permissionChanged && !started) {
      await setPermissionForGoal(host, previousPermission);
    }
  }
}

async function setPermissionForGoal(host: GoalCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(`Failed to set permission mode: ${formatErrorMessage(error)}`);
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startGoal(
  host: GoalCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  options: GoalStartOptions,
): Promise<boolean> {
  const prepared = await options.prepareCreate?.();
  if (prepared === false) return false;
  const maxIterations = prepared?.maxIterations ?? parsed.maxIterations;
  let snapshot: GoalSnapshot;
  try {
    snapshot = await host.requireSession().createGoal({
      objective: parsed.objective,
      completionCriterion: prepared?.completionCriterion,
      replace: parsed.replace,
      stopCondition: parsed.stopCondition,
      reviewModel: parsed.reviewModel,
      maxIterations,
      minIntervalMs: parsed.minIntervalMs,
      writerProviderCallLimit: parsed.writerProviderCallLimit,
      reviewerProviderCallLimit: parsed.reviewerProviderCallLimit,
      tokenBudget: parsed.tokenBudget,
      workspaceChangeBaseline: prepared?.workspaceChangeBaseline,
      loopContract: prepared?.loopContract,
    });
  } catch (error) {
    await options.onCreateError?.();
    if (isWukongError(error) && error.code === ErrorCodes.GOAL_ALREADY_EXISTS) {
      host.showError(
        'A goal is already active. Use `/goal replace <objective>` to replace it, or `/goal status` to inspect it.',
      );
      return false;
    }
    host.showError(formatErrorMessage(error));
    return false;
  }
  await options.afterCreate?.(snapshot);
  if (options.beforeSend !== undefined && !(await options.beforeSend())) {
    return false;
  }
  host.state.transcriptContainer.addChild(new GoalSetMessageComponent());
  host.state.ui.requestRender();
  if (options.sendInput !== undefined) {
    options.sendInput(parsed.objective);
  } else {
    host.sendNormalUserInput(parsed.objective);
  }
  return true;
}

async function pauseGoal(
  host: SlashCommandHost,
  presentation: 'goal' | 'loop' = 'goal',
): Promise<void> {
  const session = host.requireSession();
  try {
    await session.pauseGoal();
    if (isStreaming(host)) await session.cancel();
  } catch (error) {
    if (isWukongError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus('No goal to pause.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_pause');
  host.showStatus(
    presentation === 'loop'
      ? 'Loop paused. Workspace changes remain on disk. Use `/loop resume` to continue the same Finish Line.'
      : 'Goal paused. Use `/goal resume` to continue.',
  );
}

async function resumeGoal(host: SlashCommandHost): Promise<GoalSnapshot | undefined> {
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return undefined;
  }

  let resumed: GoalSnapshot;
  try {
    const session = host.requireSession();
    const current = (await session.getGoal()).goal;
    if (current?.providerOutcomeUnknown !== undefined) {
      const unknown = current.providerOutcomeUnknown;
      host.showError([
        'Loop cannot resume because a provider request may already have been accepted.',
        `Request      ${unknown.requestId}`,
        `Idempotency  ${unknown.idempotencyKey}`,
        'Next         Check provider logs or billing first. Do not resume blindly; cancel and start a new Loop only after confirming a new request is safe.',
      ].join('\n'));
      return undefined;
    }
    if (!(await ensureLoopWorkspaceTrustForResume(host, current))) return undefined;
    const reviewSettings = await reviewSettingsForResume(host, current);
    if (reviewSettings === false) return undefined;
    resumed = await session.resumeGoal(
      reviewSettings === undefined ? {} : { reviewSettings },
    );
  } catch (error) {
    if (isWukongError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus('No goal to resume.');
      return undefined;
    }
    host.showError(formatErrorMessage(error));
    return undefined;
  }
  host.track('goal_resume');
  host.sendNormalUserInput(RESUME_GOAL_INPUT);
  return resumed;
}

export async function reviewSettingsForResume(
  host: SlashCommandHost,
  goal: GoalSnapshot | null,
): Promise<
  | ReturnType<typeof confirmLoopReviewSettings>
  | undefined
  | false
> {
  const contract = goal?.loopContract;
  if (
    goal?.status !== 'paused'
    && goal?.status !== 'blocked'
  ) {
    return undefined;
  }
  if (contract?.schemaVersion !== 2 && contract?.schemaVersion !== 3) {
    return undefined;
  }
  const config = await host.harness.getConfig();
  const provider = resolveLoopReviewProvider(
    config,
    goal.reviewModel ?? host.state.appState.model,
  );
  if (provider === undefined) {
    host.showError(
      'Cannot resume Loop: the actual reviewer provider endpoint could not be resolved.',
    );
    return false;
  }
  const proposal = createLoopReviewSettingsProposal({
    workspaceIdentityDigest: contract.workspaceIdentity.workspaceIdentityDigest,
    reviewProvider: provider,
  });
  const storedBrokerTrust = await findBrokerReviewTrust(
    contract.workspaceIdentity.workspaceIdentityDigest,
  );
  const brokerReviewTrust = await confirmTuiBrokerReviewTrust(host, {
    canonicalRealpath: contract.workspaceIdentity.canonicalRealpath,
    workspaceIdentityDigest: contract.workspaceIdentity.workspaceIdentityDigest,
    brokerTrustProposal: proposal.brokerTrustProposal,
    existing: storedBrokerTrust === undefined
      ? undefined
      : brokerReviewTrustBinding(storedBrokerTrust),
  });
  if (brokerReviewTrust === false) return false;
  const origin = proposal.reviewSubjectConsentProposal.provider.endpointOrigin;
  const confirmed = await new Promise<boolean>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Allow this Loop continuation to send bounded review input?',
        hint: '↑↓ navigate · Enter select · Esc cancel',
        notice: [
          `Workspace  ${contract.workspaceIdentity.canonicalRealpath}`,
          `Provider   ${origin.scheme}://${origin.host}:${String(origin.port)}`,
          'Input      changed/scope files and redacted Gate evidence within fixed limits',
          'Excluded   credential/session/trust/log, binary, generated and oversized paths',
          'Filtered   recognized secret patterns in otherwise eligible text',
          'Retention  sent to your BYOK provider under that provider\'s policy',
        ].join('\n'),
        noticeTone: 'warning',
        options: [
          {
            value: 'continue',
            label: 'Continue once',
            description: 'Freeze this exact provider/input consent for the resumed run.',
          },
          {
            value: 'cancel',
            label: 'Cancel',
            description: 'Keep the Goal stopped and make no provider call.',
          },
        ],
        onSelect: (value) => {
          host.restoreEditor();
          resolve(value === 'continue');
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(false);
        },
      }),
    );
  });
  if (!confirmed) {
    host.showStatus('Loop remains stopped. No review input was sent.');
    return false;
  }
  return {
    ...confirmLoopReviewSettings(proposal),
    brokerReviewTrust,
  };
}

async function cancelGoal(
  host: SlashCommandHost,
  presentation: 'goal' | 'loop' = 'goal',
): Promise<void> {
  const session = host.requireSession();
  let active: GoalSnapshot | null = null;
  try {
    active = (await session.getGoal()).goal;
    await session.cancelGoal();
    if (active !== null) {
      await stopTuiLoop(active.goalId, active.iteration);
    }
    if (isStreaming(host)) await session.cancel();
  } catch (error) {
    if (isWukongError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus('No goal to cancel.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_cancel');
  host.showNotice(
    presentation === 'loop'
      ? [
          'Outcome    STOPPED_BY_USER',
          'Gate       no PASS / NEEDS_WORK / ERROR verdict was produced',
          `Writer     ${String(active?.iteration ?? 0)} iteration(s) before stop`,
          'Workspace  existing changes remain on disk; Wukong did not revert them',
          'Resume     unavailable because /loop stop discards this Loop contract',
          'Next       inspect `git status --short` and `git diff`, then keep/revert the changes or start a new /loop',
        ].join('\n')
      : 'Goal cancelled.',
  );
}

async function showGoalStatus(host: SlashCommandHost): Promise<void> {
  const { goal } = await host.requireSession().getGoal();
  host.track('goal_status', { status: goal?.status ?? 'none' });
  if (goal === null) {
    host.showStatus('No goal set. Start one with `/goal <objective>`.');
    return;
  }
  host.state.transcriptContainer.addChild(
    new GoalStatusMessageComponent(goal),
  );
  host.state.ui.requestRender();
}

async function getLoopGoal(host: SlashCommandHost): Promise<GoalSnapshot | null> {
  const goal = (await host.requireSession().getGoal()).goal;
  return goal?.stopCondition === undefined ? null : goal;
}

async function showLoopStatus(host: SlashCommandHost): Promise<void> {
  const goal = await getLoopGoal(host);
  host.track('loop_status', { status: goal?.status ?? 'none' });
  if (goal === null) {
    host.showStatus('No Loop is active. Start one with `/loop <objective>`.');
    return;
  }
  host.state.transcriptContainer.addChild(new GoalStatusMessageComponent(goal));
  host.state.ui.requestRender();
}

async function pauseLoop(host: SlashCommandHost): Promise<void> {
  if (await getLoopGoal(host) === null) {
    host.showStatus('No Loop is active.');
    return;
  }
  await pauseGoal(host, 'loop');
}

async function resumeLoop(host: SlashCommandHost): Promise<void> {
  const goal = await getLoopGoal(host);
  if (goal === null) {
    host.showStatus('No Loop is available to resume.');
    return;
  }
  const previousRunId = goal.loopRunId;
  const resumed = await resumeGoal(host);
  if (
    resumed !== undefined
    && resumed.loopRunId !== undefined
    && resumed.loopRunId !== previousRunId
  ) {
    const run = await beginLoopRun(resumed.loopRunId);
    await registerTuiLoop(
      resumed.goalId,
      run,
      host.requireSession().id,
      host.state.appState.workDir ?? process.cwd(),
    );
    host.showStatus('Started a new bounded run under the same frozen Finish Line.');
  }
}

async function cancelLoop(host: SlashCommandHost): Promise<void> {
  if (await getLoopGoal(host) === null) {
    host.showStatus('No Loop is active. The current Goal was left unchanged.');
    return;
  }
  await cancelGoal(host, 'loop');
}

function isStreaming(host: SlashCommandHost): boolean {
  return host.state.appState.streamingPhase !== 'idle';
}

function isBusy(host: SlashCommandHost): boolean {
  return isStreaming(host) || host.state.appState.isCompacting;
}

export type ParsedLoopCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'stop' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly stopCondition: 'proof-pass';
      readonly maxIterations: number;
      readonly minIntervalMs?: number;
      readonly reviewModel?: string;
      readonly writerProviderCallLimit?: number;
      readonly reviewerProviderCallLimit?: number;
      readonly tokenBudget?: number;
      readonly replace?: boolean;
      readonly supersedesGoalId?: string;
      readonly supersedesContractId?: string;
    }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

const DEFAULT_MAX_ITERATIONS = 10;

export function parseLoopCommand(rawArgs: string): ParsedLoopCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };
  if (args === 'help' || args === '--help' || args === '-h') return { kind: 'help' };
  if (args === 'pause') return { kind: 'pause' };
  if (args === 'resume') return { kind: 'resume' };
  if (args === 'stop') return { kind: 'stop' };

  const tokens = args.split(/\s+/);
  let index = 0;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let minIntervalMs: number | undefined;
  let reviewModel: string | undefined;
  let writerProviderCallLimit: number | undefined;
  let reviewerProviderCallLimit: number | undefined;
  let tokenBudget: number | undefined;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--until') {
      const condition = tokens[index + 1];
      if (
        condition !== 'proof-pass'
        && condition !== 'verify-pass'
        && condition !== 'scan-clean'
        && condition !== 'judge-pass'
      ) {
        return { kind: 'error', message: '`--until` must be `proof-pass`.' };
      }
      index += 2;
      continue;
    }
    if (token === '--max-iterations') {
      const rawValue = tokens[index + 1];
      if (rawValue !== undefined && /^[1-9]\d*$/u.test(rawValue)) {
        const value = Number(rawValue);
        if (!Number.isSafeInteger(value)) {
          return { kind: 'error', message: '`--max-iterations` requires a positive safe integer.' };
        }
        maxIterations = value;
        index += 2;
        continue;
      }
      return { kind: 'error', message: '`--max-iterations` requires a positive integer.' };
    }
    if (
      token === '--writer-call-limit'
      || token === '--reviewer-call-limit'
      || token === '--token-budget'
    ) {
      const rawValue = tokens[index + 1];
      if (rawValue === undefined || !/^[1-9]\d*$/u.test(rawValue)) {
        return { kind: 'error', message: `\`${token}\` requires a positive integer.` };
      }
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value)) {
        return { kind: 'error', message: `\`${token}\` requires a positive safe integer.` };
      }
      if (token === '--writer-call-limit') writerProviderCallLimit = value;
      if (token === '--reviewer-call-limit') reviewerProviderCallLimit = value;
      if (token === '--token-budget') tokenBudget = value;
      index += 2;
      continue;
    }
    if (token === '--every') {
      const rawDuration = tokens[index + 1];
      if (rawDuration === undefined) {
        return { kind: 'error', message: '`--every` requires a duration.' };
      }
      const parsed = parseLoopDuration(rawDuration);
      if (parsed.kind === 'error') {
        return { kind: 'error', message: parsed.message };
      }
      minIntervalMs = parsed.ms;
      index += 2;
      continue;
    }
    if (token === '--review-model') {
      const model = tokens[index + 1]?.trim();
      if (!model) {
        return { kind: 'error', message: '`--review-model` requires a model alias.' };
      }
      reviewModel = model;
      index += 2;
      continue;
    }
    if (token === '--') {
      index += 1;
      break;
    }
    if (token?.startsWith('-') === true) {
      return { kind: 'error', message: `Unknown Loop option: ${token}` };
    }
    break;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message: 'Provide a loop objective, e.g. `/loop fix the failing tests`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Loop objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters).`,
    };
  }
  return {
    kind: 'create',
    objective,
    stopCondition: 'proof-pass',
    maxIterations,
    minIntervalMs,
    reviewModel,
    writerProviderCallLimit,
    reviewerProviderCallLimit,
    tokenBudget,
  };
}

export async function handleLoopSlashCommand(host: SlashCommandHost, args: string): Promise<void> {
  const revising = args.trim().startsWith('revise ');
  const parsed = parseLoopCommand(revising ? args.trim().slice('revise '.length) : args);
  switch (parsed.kind) {
    case 'help':
      host.showStatus([
        'Usage: /loop [options] -- <objective>',
        '       /loop revise [options] -- <new objective>',
        '       /loop status|pause|resume|stop',
        'Options: --max-iterations <n> --every <duration> --review-model <alias> --writer-call-limit <n> --reviewer-call-limit <n> --token-budget <n>',
      ].join('\n'));
      return;
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
      return;
    case 'status':
      await showLoopStatus(host);
      return;
    case 'pause':
      await pauseLoop(host);
      return;
    case 'resume':
      await resumeLoop(host);
      return;
    case 'stop':
      await cancelLoop(host);
      return;
    case 'create':
      if (revising) {
        const current = await getLoopGoal(host);
        if (
          current?.loopContract?.schemaVersion !== 2
          && current?.loopContract?.schemaVersion !== 3
        ) {
          host.showStatus('No Loop contract is available to revise.');
          return;
        }
        const revised: Extract<ParsedLoopCommand, { kind: 'create' }> = {
          ...parsed,
          replace: true,
          supersedesGoalId: current.goalId,
          supersedesContractId: current.loopContract.contractId,
        };
        await openFinishLineReview(host, revised, {
          objective: revised.objective,
          constraints: current.loopContract.constraints.map((constraint) => constraint.text),
        }, args);
        return;
      }
      await openFinishLineReview(host, parsed, {
        objective: parsed.objective,
        constraints: [],
      }, args);
      return;
  }
}

async function openFinishLineReview(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  discoveredCheckDecision: DiscoveredCheckDecision = 'tui-default',
  verificationSkills: readonly VerificationCriteriaChoice[] = [],
  verificationCatalogDigest?: string,
): Promise<void> {
  const config = await host.harness.getConfig();
  const reviewProvider = resolveLoopReviewProvider(
    config,
    parsed.reviewModel ?? host.state.appState.model,
  );
  const result = await runLoopPreflight({
    objective: draft.objective,
    completionCriterion: draft.completionCriterion,
    constraints: draft.constraints,
    discoveredCheckDecision,
    model: host.state.appState.model,
    workspace: host.state.appState.workDir ?? process.cwd(),
    mode: 'tui-proposal',
    verificationSkills,
    verificationCatalogDigest,
    reviewProvider,
    getActiveGoal: async () => (await host.requireSession().getGoal()).goal,
  });
  if (!result.ready) {
    host.showError(formatLoopPreflightBlocked(result));
    return;
  }
  showFinishLineReview(host, parsed, draft, rawArgs, result, discoveredCheckDecision);
}

function showFinishLineReview(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  preflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
): void {
  host.mountEditorReplacement(
    new FinishLineReviewComponent({
      proposal: preflight.proposal,
      summary: formatLoopPreflightReady(
        preflight,
        parsed.maxIterations,
        {
          writerModel: host.state.appState.model,
          reviewerModel: parsed.reviewModel ?? host.state.appState.model,
          permission: host.state.appState.permissionMode,
          writerProviderCallLimit: parsed.writerProviderCallLimit,
          reviewerProviderCallLimit: parsed.reviewerProviderCallLimit,
          tokenBudget: parsed.tokenBudget,
        },
        { includeHeading: false },
      ),
      maxIterations: parsed.maxIterations,
      selectedCriteriaCount: preflight.verificationSelection?.selected.length ?? 0,
      suggestedCriteriaCount: preflight.verificationCatalog.suggestions.length,
      permissionMode: host.state.appState.permissionMode,
      missingUsageCaps:
        parsed.writerProviderCallLimit === undefined
        || parsed.reviewerProviderCallLimit === undefined
        || parsed.tokenBudget === undefined,
      workspaceGit: preflight.workspaceGit,
      onSelect: (choice) => {
        void handleFinishLineReviewChoice(
          host,
          parsed,
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
          choice,
        );
      },
      onCancel: () => {
        cancelFinishLine(host, rawArgs);
      },
    }),
  );
}

async function handleFinishLineReviewChoice(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  preflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
  choice: FinishLineReviewChoice,
): Promise<void> {
  switch (choice) {
    case 'cancel':
      cancelFinishLine(host, rawArgs);
      return;
    case 'edit':
      host.mountEditorReplacement(
        new FinishLineEditorComponent(draft, (result) => {
          if (result.kind === 'cancel') {
            showFinishLineReview(
              host,
              parsed,
              draft,
              rawArgs,
              preflight,
              discoveredCheckDecision,
            );
            return;
          }
          void openFinishLineReview(
            host,
            parsed,
            result.draft,
            rawArgs,
            discoveredCheckDecision,
            selectedCriteriaChoices(preflight),
            preflight.verificationCatalog.catalogDigest,
          );
        }),
      );
      return;
    case 'checks':
      showFrozenChecks(
        host,
        parsed,
        draft,
        rawArgs,
        preflight,
        discoveredCheckDecision,
      );
      return;
    case 'workspace':
      showWorkspaceChanges(
        host,
        parsed,
        draft,
        rawArgs,
        preflight,
        discoveredCheckDecision,
      );
      return;
    case 'criteria':
      host.mountEditorReplacement(
        new VerificationCriteriaSelectorComponent({
          catalog: preflight.verificationCatalog,
          selected: selectedCriteriaChoices(preflight),
          onDone: (selected) => {
            void openFinishLineReview(
              host,
              parsed,
              draft,
              rawArgs,
              discoveredCheckDecision,
              selected,
              selected.length === 0
                ? undefined
                : preflight.verificationCatalog.catalogDigest,
            );
          },
          onCancel: () => {
            showFinishLineReview(
              host,
              parsed,
              draft,
              rawArgs,
              preflight,
              discoveredCheckDecision,
            );
          },
        }),
      );
      return;
    case 'advanced':
      showAdvancedLoopSettings(
        host,
        parsed,
        draft,
        rawArgs,
        preflight,
        discoveredCheckDecision,
      );
      return;
    case 'start':
      {
        if (
          preflight.proposal.gatePlan.requiredChecks.length === 0
          && !await confirmTuiNoExecutableChecks(host, preflight)
        ) {
          return;
        }
        const brokerReviewTrust = preflight.brokerReviewTrust
          ?? await ensureTuiBrokerReviewTrust(host, preflight);
        if (brokerReviewTrust === false) return;
      await confirmReviewSubjectAccess(
        host,
        parsed,
        draft,
        rawArgs,
        preflight,
        discoveredCheckDecision,
        brokerReviewTrust,
      );
      }
      return;
  }
}

async function confirmTuiNoExecutableChecks(
  host: SlashCommandHost,
  preflight: LoopPreflightReady,
): Promise<boolean> {
  const decision = preflight.proposal.noExecutableChecksDecision;
  if (decision?.status === 'acknowledged') return true;
  if (decision === undefined) {
    host.showError(
      'Loop not started: applicable project checks were excluded. Revise the Loop and include them.',
    );
    return false;
  }
  return new Promise<boolean>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'No executable checks apply?',
        hint: '↑↓ navigate · Enter select · Esc cancel',
        notice: [
          `Policy      ${decision.policyVersion}`,
          'Project     discovery found no applicable executable project checks',
          'Still runs  builtin risk scan, static evidence, and a fresh reviewer',
          'Will block  source changes without checks as NEEDS_WORK/checks_missing',
          'Terminal    explicitly states that no project command ran',
        ].join('\n'),
        noticeTone: 'warning',
        options: [
          {
            value: 'cancel',
            label: 'Cancel and revise checks',
            description: 'Return without creating a contract, trust grant, or run.',
          },
          {
            value: 'confirm',
            label: 'Confirm no executable checks apply',
            description: 'Bind this exact versioned decision to the Acceptance Contract.',
          },
        ],
        onSelect: (value) => {
          host.restoreEditor();
          if (value !== 'confirm') host.showStatus('Loop not started.');
          resolve(value === 'confirm');
        },
        onCancel: () => {
          host.restoreEditor();
          host.showStatus('Loop not started.');
          resolve(false);
        },
      }),
    );
  });
}

function showAdvancedLoopSettings(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  preflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
): void {
  const limits = [...new Set([parsed.maxIterations, 5, 10, 20])].toSorted((a, b) => a - b);
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Loop run limit',
      hint: '↑↓ navigate · Enter apply · Esc back',
      notice: [
        `Reviewer      ${parsed.reviewModel ?? 'fresh reviewer using the active model'}`,
        `Permission    ${host.state.appState.permissionMode}`,
        `Every         ${parsed.minIntervalMs === undefined ? 'after each writer attempt' : `${String(parsed.minIntervalMs)} ms`}`,
        'Provider calls have no separate cap configured for this run.',
        'Token usage has no separate cap configured for this run.',
        'Cancel the preflight if an iteration limit alone is not acceptable.',
        'Use /loop flags to change reviewer model or interval.',
      ].join('\n'),
      options: limits.map((limit) => ({
        value: String(limit),
        label: `${String(limit)} maximum iterations${limit === parsed.maxIterations ? ' (current)' : ''}`,
        description: 'Per-run limit; continuing a terminal run starts a new bounded run.',
      })),
      onSelect: (value) => {
        const maxIterations = Number.parseInt(value, 10);
        showFinishLineReview(
          host,
          { ...parsed, maxIterations },
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
        );
      },
      onCancel: () => {
        showFinishLineReview(
          host,
          parsed,
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
        );
      },
    }),
  );
}

function showFrozenChecks(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  preflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
): void {
  const required = preflight.proposal.gatePlan.requiredChecks;
  const canExcludeDiscovered = required.some((check) => check.source !== 'explicit');
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Required checks',
      hint: '↑↓ navigate · Enter back · Esc cancel',
      options: required.length === 0
        ? [{
            value: 'back',
            label: 'No resolved project checks',
            description: 'The Finish Line warning remains blocking for deterministic source verification.',
          }]
        : [
            ...required.map((check) => ({
            value: check.id,
            label: check.displayCommand,
            description: [
              check.sourceLocator === undefined ? `Source: ${check.source}` : `Source: ${check.sourceLocator}`,
              `Selected: ${check.selectedBy}`,
              check.resolution,
            ].join(' · '),
          })),
            ...(canExcludeDiscovered ? [{
              value: 'only-explicit',
              label: 'Exclude discovered checks',
              description: 'Keep only explicitly supplied checks and record every exclusion in the Gate Plan.',
            }] : []),
          ],
      onSelect: (value) => {
        if (value === 'only-explicit') {
          void openFinishLineReview(
            host,
            parsed,
            draft,
            rawArgs,
            'only-explicit',
            selectedCriteriaChoices(preflight),
            preflight.verificationSelection === undefined
              ? undefined
              : preflight.verificationCatalog.catalogDigest,
          );
          return;
        }
        showFinishLineReview(
          host,
          parsed,
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
        );
      },
      onCancel: () => {
        showFinishLineReview(
          host,
          parsed,
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
        );
      },
    }),
  );
}

function showWorkspaceChanges(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  preflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
): void {
  const git = preflight.workspaceGit;
  if (git === undefined || git.changedFileCount === 0) {
    showFinishLineReview(
      host,
      parsed,
      draft,
      rawArgs,
      preflight,
      discoveredCheckDecision,
    );
    return;
  }
  const files = git.changedFiles;
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Pre-existing workspace changes',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      notice: [
        `Workspace  ${preflight.workspace}`,
        `Before     ${String(git.changedFileCount)} changed file${git.changedFileCount === 1 ? '' : 's'} already exist before this Loop`,
        ...files.map((file, index) =>
          `File ${String(index + 1).padEnd(6)} ${file.status} ${file.path}`,
        ),
        ...(git.changedFileCount > files.length
          ? [`More       ${String(git.changedFileCount - files.length)} additional path${git.changedFileCount - files.length === 1 ? '' : 's'}; inspect git status for the full list`]
          : []),
        'Handling   Loop changes are not isolated or reverted automatically; review git status and diff after the terminal result',
      ].join('\n'),
      noticeTone: 'warning',
      options: [
        {
          value: 'back',
          label: 'Back to preflight',
          description: 'Keep the current proposal and review the remaining fields.',
        },
        {
          value: 'cancel',
          label: 'Cancel and inspect workspace',
          description: 'Create no trust grant, contract, or run; restore the /loop command for later.',
        },
      ],
      onSelect: (value) => {
        if (value === 'cancel') {
          cancelFinishLine(host, rawArgs);
          return;
        }
        showFinishLineReview(
          host,
          parsed,
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
        );
      },
      onCancel: () => {
        showFinishLineReview(
          host,
          parsed,
          draft,
          rawArgs,
          preflight,
          discoveredCheckDecision,
        );
      },
    }),
  );
}

async function confirmReviewSubjectAccess(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  preflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
  brokerReviewTrust: BrokerReviewTrustBindingV1,
): Promise<void> {
  await new Promise<void>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: `Send bounded review data to ${parsed.reviewModel ?? preflight.model}?`,
        hint: '↑↓ navigate · Enter select · Esc cancel',
        notice: [
          `Reviewer      ${parsed.reviewModel ?? preflight.model}`,
          `Destination   ${formatReviewProviderOrigin(preflight)} (your configured provider)`,
          'May include   changed tracked files, selected untracked/scope-matched files,',
          '              and redacted project-check evidence',
          'Hard exclude  credential/session/trust/log, generated-output, and binary paths',
          'Filtering     recognized secret/private-key patterns in eligible text',
          'Limits        200 files · 2 MiB source · 512 KiB Gate evidence',
          'Retention     the destination provider\'s data and retention policy applies',
        ].join('\n'),
        noticeTone: 'warning',
        options: [
          {
            value: 'allow',
            label: 'Allow this run and start',
            description: 'Authorize this exact provider, policy, workspace, and run only.',
          },
          {
            value: 'cancel',
            label: 'Cancel',
            description: 'Create no trust binding, consent binding, contract, or run.',
          },
        ],
        onSelect: (value) => {
          if (value !== 'allow') {
            showFinishLineReview(
              host,
              parsed,
              draft,
              rawArgs,
              preflight,
              discoveredCheckDecision,
            );
            resolve();
            return;
          }
          host.restoreEditor();
          void startConfirmedLoop(
            host,
            parsed,
            draft,
            rawArgs,
            preflight,
            discoveredCheckDecision,
            brokerReviewTrust,
          ).finally(resolve);
        },
        onCancel: () => {
          showFinishLineReview(
            host,
            parsed,
            draft,
            rawArgs,
            preflight,
            discoveredCheckDecision,
          );
          resolve();
        },
      }),
    );
  });
}

async function startConfirmedLoop(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  initialPreflight: LoopPreflightReady,
  discoveredCheckDecision: DiscoveredCheckDecision,
  brokerReviewTrust: BrokerReviewTrustBindingV1,
): Promise<void> {
  let run: Awaited<ReturnType<typeof beginLoopRun>> | undefined;
  let finalized: LoopPreflightReady | undefined;
  await createGoal(
    host,
    {
      kind: 'create',
      objective: draft.objective,
      replace: parsed.replace ?? false,
      stopCondition: parsed.stopCondition,
      maxIterations: parsed.maxIterations,
      minIntervalMs: parsed.minIntervalMs,
      reviewModel: parsed.reviewModel,
      writerProviderCallLimit: parsed.writerProviderCallLimit,
      reviewerProviderCallLimit: parsed.reviewerProviderCallLimit,
      tokenBudget: parsed.tokenBudget,
    },
    rawArgs,
    {
      commandName: 'loop',
      prepareCreate: async () => {
        const config = await host.harness.getConfig();
        const result = await runLoopPreflight({
          objective: draft.objective,
          completionCriterion: draft.completionCriterion,
          constraints: draft.constraints,
          discoveredCheckDecision,
          model: host.state.appState.model,
          workspace: host.state.appState.workDir ?? process.cwd(),
          mode: 'tui-confirmed',
          acknowledgeWarningSetDigest:
            initialPreflight.proposal.finishLineReview.warningSetDigest,
          acknowledgeNoExecutableChecksDigest:
            initialPreflight.proposal.noExecutableChecksDecision?.decisionDigest,
          verificationSkills:
            selectedCriteriaChoices(initialPreflight),
          verificationCatalogDigest:
            initialPreflight.verificationSelection === undefined
              ? undefined
              : initialPreflight.verificationCatalog.catalogDigest,
          trustReviewSubjectChallenge:
            initialPreflight.brokerTrustChallenge,
          brokerReviewTrust,
          acknowledgeReviewSubjectConsentDigest:
            initialPreflight.reviewSubjectConsentProposal.consentProposalDigest,
          reviewProvider: resolveLoopReviewProvider(
            config,
            parsed.reviewModel ?? host.state.appState.model,
          ),
          getActiveGoal: async () => (await host.requireSession().getGoal()).goal,
        });
        if (!result.ready) {
          host.showError(formatLoopPreflightBlocked(result));
          return false;
        }
        const trustGrant = await ensureTuiWorkspaceTrust(host, result.proposal);
        if (trustGrant === false) return false;
        const trustedProposal = trustGrant === undefined
          || result.proposal.workspaceTrust === undefined
          ? result.proposal
          : {
              ...result.proposal,
              workspaceTrust: {
                ...result.proposal.workspaceTrust,
                trustGrantId: trustGrant.trustGrantId,
              },
            };
        finalized = { ...result, proposal: trustedProposal, trustGrant };
        host.showStatus('Loop approvals confirmed. Starting the bounded run.');
        return {
          maxIterations: parsed.maxIterations,
          completionCriterion: result.proposal.completionCriterion,
          workspaceChangeBaseline: result.workspaceGit === undefined
            ? undefined
            : { files: result.workspaceGit.changedFiles },
          loopContract: loopContractInput(
            finalized,
            parsed.supersedesGoalId,
            parsed.supersedesContractId,
          ),
        };
      },
      afterCreate: async (snapshot) => {
        if (snapshot.loopRunId === undefined) {
          throw new Error('Loop contract was created without an authoritative run id.');
        }
        run = await beginLoopRun(snapshot.loopRunId);
        await registerTuiLoop(
          snapshot.goalId,
          run,
          host.requireSession().id,
          finalized?.workspace,
        );
        host.track('loop_started');
        if (run.repeatedWithin7d === true) host.track('loop_repeat_started_7d');
      },
      onCreateError: async () => {
        if (run !== undefined) await stopLoopRun(run, 0);
      },
      sendInput: () => {
        host.sendNormalUserInput(draft.objective);
      },
    },
  );
}

async function ensureTuiBrokerReviewTrust(
  host: SlashCommandHost,
  preflight: LoopPreflightReady,
): Promise<BrokerReviewTrustBindingV1 | false> {
  return confirmTuiBrokerReviewTrust(host, {
    canonicalRealpath: preflight.proposal.workspaceIdentity.canonicalRealpath,
    workspaceIdentityDigest:
      preflight.proposal.workspaceIdentity.workspaceIdentityDigest,
    brokerTrustProposal: preflight.brokerTrustProposal,
    existing: preflight.brokerReviewTrust,
  });
}

async function confirmTuiBrokerReviewTrust(
  host: SlashCommandHost,
  input: {
    readonly canonicalRealpath: string;
    readonly workspaceIdentityDigest: string;
    readonly brokerTrustProposal: LoopPreflightReady['brokerTrustProposal'];
    readonly existing?: BrokerReviewTrustBindingV1;
  },
): Promise<BrokerReviewTrustBindingV1 | false> {
  if (input.existing !== undefined) return input.existing;
  return new Promise<BrokerReviewTrustBindingV1 | false>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Allow local review access to this workspace?',
        hint: '↑↓ navigate · Enter select · Esc cancel',
        notice: [
          `Workspace   ${input.canonicalRealpath}`,
          `Binding     exact workspace identity ${shortSecurityDigest(input.workspaceIdentityDigest)}`,
          'Allows      reading candidate source/evidence to assemble a bounded review payload',
          'Does not    run commands, edit files, or send data to a provider',
          'Next        provider transmission is confirmed separately for this run',
        ].join('\n'),
        noticeTone: 'warning',
        options: [
          {
            value: 'session',
            label: 'Allow local read once',
            description: 'Keep this exact workspace read grant only for this Wukong process.',
          },
          {
            value: 'remembered-local',
            label: 'Remember local read access',
            description: 'Store this exact workspace/policy grant in the local 0600 trust store.',
          },
          {
            value: 'cancel',
            label: 'Cancel',
            description: 'Create no trust grant, contract, run, or provider connection.',
          },
        ],
        onSelect: (value) => {
          if (value === 'cancel') {
            host.restoreEditor();
            host.showStatus('Loop not started.');
            resolve(false);
            return;
          }
          void grantBrokerReviewTrustLocally(
            value === 'remembered-local'
              ? createBrokerReviewTrustProposal({
                  workspaceIdentityDigest: input.workspaceIdentityDigest,
                  intent: 'remember-locally',
                })
              : input.brokerTrustProposal,
            value === 'remembered-local' ? 'remembered-local' : 'session',
          ).then((grant) => {
            host.restoreEditor();
            resolve(brokerReviewTrustBinding(grant));
          }).catch((error: unknown) => {
            host.restoreEditor();
            host.showError(`Failed to trust review broker: ${formatErrorMessage(error)}`);
            resolve(false);
          });
        },
        onCancel: () => {
          host.restoreEditor();
          host.showStatus('Loop not started.');
          resolve(false);
        },
      }),
    );
  });
}

export async function ensureLoopWorkspaceTrustForResume(
  host: SlashCommandHost,
  goal: GoalSnapshot | null,
): Promise<boolean> {
  const contract = goal?.loopContract;
  if (
    (goal?.status !== 'paused' && goal?.status !== 'blocked')
    || (contract?.schemaVersion !== 2 && contract?.schemaVersion !== 3)
    || !contract.gateApproval?.hasExecutableChecks
  ) {
    return true;
  }
  return (await ensureTuiWorkspaceTrust(host, contract)) !== false;
}

async function ensureTuiWorkspaceTrust(
  host: SlashCommandHost,
  proposal: Pick<FinishLineProposal, 'gateApproval' | 'gatePlan' | 'workspaceIdentity'> | {
    readonly gateApproval: FinishLineProposal['gateApproval'];
    readonly gatePlan: {
      readonly legacySnapshot: FinishLineProposal['gatePlan'];
    };
    readonly workspaceIdentity: FinishLineProposal['workspaceIdentity'];
  },
): Promise<WorkspaceTrustGrant | undefined | false> {
  if (!proposal.gateApproval.hasExecutableChecks) return undefined;
  const existing = await findWorkspaceTrust(proposal.workspaceIdentity.workspaceIdentityDigest);
  if (existing !== undefined) return existing;
  const gatePlan = 'legacySnapshot' in proposal.gatePlan
    ? proposal.gatePlan.legacySnapshot
    : proposal.gatePlan;
  return new Promise<WorkspaceTrustGrant | false>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Allow this workspace to run the selected project checks?',
        hint: '↑↓ navigate · Enter select · Esc cancel',
        notice: [
          `Workspace   ${proposal.workspaceIdentity.canonicalRealpath}`,
          `Binding     exact workspace identity ${shortSecurityDigest(proposal.workspaceIdentity.workspaceIdentityDigest)}`,
          `Checks      ${String(gatePlan.requiredChecks.length)} frozen project command${gatePlan.requiredChecks.length === 1 ? '' : 's'}`,
          'Risk        commands run with your current OS account; this is not a shell sandbox',
        ].join('\n'),
        noticeTone: 'warning',
        options: [
          {
            value: 'session',
            label: 'Allow checks once',
            description: 'Valid only for this Wukong process and exact workspace identity.',
          },
          {
            value: 'remembered-local',
            label: 'Remember locally',
            description: 'Store this exact workspace identity in the local 0600 trust store.',
          },
          {
            value: 'cancel',
            label: 'Cancel',
            description: 'Create no trust grant, contract, or run.',
          },
        ],
        onSelect: (value) => {
          if (value === 'cancel') {
            host.restoreEditor();
            host.showStatus('Loop not started.');
            resolve(false);
            return;
          }
          void grantWorkspaceTrust(
            proposal.workspaceIdentity,
            value === 'remembered-local' ? 'remembered-local' : 'session',
          ).then((grant) => {
            host.restoreEditor();
            resolve(grant);
          }).catch((error: unknown) => {
            host.restoreEditor();
            host.showError(`Failed to trust workspace: ${formatErrorMessage(error)}`);
            resolve(false);
          });
        },
        onCancel: () => {
          host.restoreEditor();
          host.showStatus('Loop not started.');
          resolve(false);
        },
      }),
    );
  });
}

function loopContractInput(
  preflight: LoopPreflightReady,
  supersedesGoalId?: string,
  supersedesContractId?: string,
): LoopContractV2Input | LoopContractV3Input {
  const proposal = preflight.proposal;
  if (
    preflight.brokerReviewTrust === undefined
    || preflight.reviewSubjectConsent === undefined
  ) {
    throw new Error('Loop preflight did not freeze exact broker trust and provider consent.');
  }
  const reviewSettings = {
    brokerReviewTrust: preflight.brokerReviewTrust,
    reviewSubjectConsent: preflight.reviewSubjectConsent,
  };
  if (preflight.contractSchemaVersion === 3) {
    const workspaceTrust = proposal.gateApproval.hasExecutableChecks
      ? {
          schemaVersion: 2 as const,
          workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
          reviewSubjectPolicyVersion:
            preflight.reviewSubjectConsentProposal.reviewSubjectPolicyVersion,
          hasExecutableChecks: true as const,
          scopes: ['loop-project-checks', 'brokered-review-subject'] as const,
        }
      : {
          schemaVersion: 2 as const,
          workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
          reviewSubjectPolicyVersion:
            preflight.reviewSubjectConsentProposal.reviewSubjectPolicyVersion,
          hasExecutableChecks: false as const,
          scopes: ['brokered-review-subject'] as const,
        };
    return {
      schemaVersion: 3,
      objective: proposal.objective,
      completionCriterion: proposal.completionCriterion,
      constraints: proposal.constraints,
      finishLineReview: proposal.finishLineReview,
      workspaceIdentity: proposal.workspaceIdentity,
      workspaceTrust,
      gateApproval: proposal.gateApproval,
      legacyGatePlan: proposal.gatePlan,
      noExecutableChecksDecision: proposal.noExecutableChecksDecision,
      reviewPolicy: proposal.reviewPolicy,
      verificationCriteria: preflight.verificationSelection!,
      selectedRecipes: preflight.selectedRecipes,
      reviewSettings,
      source: 'user',
      supersedesGoalId,
      supersedesContractId,
    };
  }
  return {
    schemaVersion: 2,
    objective: proposal.objective,
    completionCriterion: proposal.completionCriterion,
    constraints: proposal.constraints,
    finishLineReview: proposal.finishLineReview,
    workspaceIdentity: proposal.workspaceIdentity,
    workspaceTrust: proposal.workspaceTrust,
    gateApproval: proposal.gateApproval,
    gatePlan: proposal.gatePlan,
    noExecutableChecksDecision: proposal.noExecutableChecksDecision,
    reviewPolicy: proposal.reviewPolicy,
    reviewSettings,
    source: 'user',
    supersedesGoalId,
    supersedesContractId,
  };
}

function formatReviewProviderOrigin(preflight: LoopPreflightReady): string {
  const origin = preflight.reviewSubjectConsentProposal.provider.endpointOrigin;
  return `${origin.scheme}://${origin.host}:${String(origin.port)}`;
}

function shortSecurityDigest(value: string): string {
  const separator = value.indexOf(':');
  const prefix = separator >= 0 ? value.slice(0, separator + 1) : '';
  const digest = separator >= 0 ? value.slice(separator + 1) : value;
  if (digest.length <= 16) return value;
  return `${prefix}${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

function selectedCriteriaChoices(
  preflight: LoopPreflightReady,
): readonly VerificationCriteriaChoice[] {
  return preflight.verificationSelection?.selected.map(({ ref }) => {
    const entry = preflight.verificationCatalog.entries.find(
      (candidate) => candidate.ref.provenanceDigest === ref.provenanceDigest,
    );
    if (entry === undefined) {
      throw new Error(`Selected verification criteria is absent from the current catalog: ${ref.skillName}`);
    }
    return {
      selectionId: entry.selectionId,
      provenanceDigest: ref.provenanceDigest,
    };
  }) ?? [];
}

function cancelFinishLine(host: SlashCommandHost, rawArgs: string): void {
  host.restoreInputText(`/loop ${rawArgs.trim()}`);
  host.showStatus('Loop not started.');
}
