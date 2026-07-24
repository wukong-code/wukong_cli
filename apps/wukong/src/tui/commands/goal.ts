import {
  ErrorCodes,
  isWukongError,
  type GoalSnapshot,
  type LoopContractV2Input,
  type PermissionMode,
} from '@wukong/wukong-sdk';
import type { FinishLineProposal } from '@wukong/verification';

import { parseLoopDuration } from '#/utils/duration';
import {
  beginLoopRun,
  completeLoopRun,
  completeTuiLoop,
  registerTuiLoop,
} from '#/cli/lib/loop-lifecycle';
import {
  formatLoopPreflightBlocked,
  formatLoopPreflightReady,
  runLoopPreflight,
  type LoopPreflightReady,
  type DiscoveredCheckDecision,
} from '#/cli/lib/loop-preflight';
import {
  findWorkspaceTrust,
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
    readonly loopContract?: LoopContractV2Input;
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

async function pauseGoal(host: SlashCommandHost): Promise<void> {
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
  host.showStatus('Goal paused. Use `/goal resume` to continue.');
}

async function resumeGoal(host: SlashCommandHost): Promise<GoalSnapshot | undefined> {
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return undefined;
  }

  let resumed: GoalSnapshot;
  try {
    resumed = await host.requireSession().resumeGoal();
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

async function cancelGoal(host: SlashCommandHost): Promise<void> {
  const session = host.requireSession();
  try {
    const active = (await session.getGoal()).goal;
    await session.cancelGoal();
    if (active !== null) {
      await completeTuiLoop(active.goalId, 'ERROR', active.iteration, 'cancelled');
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
  host.showNotice('Goal cancelled.');
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
  await pauseGoal(host);
}

async function resumeLoop(host: SlashCommandHost): Promise<void> {
  const goal = await getLoopGoal(host);
  if (goal === null) {
    host.showStatus('No Loop is available to resume.');
    return;
  }
  if (goal.loopContract?.schemaVersion === 2 && goal.loopContract.gateApproval.hasExecutableChecks) {
    const trusted = await ensureTuiWorkspaceTrust(host, goal.loopContract);
    if (trusted === false) return;
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
  await cancelGoal(host);
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
        'Options: --max-iterations <n> --every <duration> --review-model <alias>',
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
        if (current?.loopContract?.schemaVersion !== 2) {
          host.showStatus('No V2 Loop is available to revise.');
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
): Promise<void> {
  const result = await runLoopPreflight({
    objective: draft.objective,
    completionCriterion: draft.completionCriterion,
    constraints: draft.constraints,
    discoveredCheckDecision,
    model: host.state.appState.model,
    workspace: host.state.appState.workDir ?? process.cwd(),
    mode: 'tui-proposal',
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
      maxIterations: parsed.maxIterations,
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
      host.restoreEditor();
      await startConfirmedLoop(
        host,
        parsed,
        draft,
        rawArgs,
        preflight.proposal,
        discoveredCheckDecision,
      );
      return;
  }
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
      title: 'Advanced Loop settings',
      hint: '↑↓ navigate · Enter apply · Esc back',
      notice: [
        `Reviewer      ${parsed.reviewModel ?? 'fresh reviewer using the active model'}`,
        `Permission    ${host.state.appState.permissionMode}`,
        `Every         ${parsed.minIntervalMs === undefined ? 'after each writer attempt' : `${String(parsed.minIntervalMs)} ms`}`,
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
          void openFinishLineReview(host, parsed, draft, rawArgs, 'only-explicit');
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

async function startConfirmedLoop(
  host: SlashCommandHost,
  parsed: Extract<ParsedLoopCommand, { kind: 'create' }>,
  draft: FinishLineDraft,
  rawArgs: string,
  proposal: FinishLineProposal,
  discoveredCheckDecision: DiscoveredCheckDecision,
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
    },
    rawArgs,
    {
      commandName: 'loop',
      prepareCreate: async () => {
        const result = await runLoopPreflight({
          objective: draft.objective,
          completionCriterion: draft.completionCriterion,
          constraints: draft.constraints,
          discoveredCheckDecision,
          model: host.state.appState.model,
          workspace: host.state.appState.workDir ?? process.cwd(),
          mode: 'tui-confirmed',
          acknowledgeWarningSetDigest: proposal.finishLineReview.warningSetDigest,
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
        host.showStatus(formatLoopPreflightReady(result, parsed.maxIterations));
        return {
          maxIterations: parsed.maxIterations,
          completionCriterion: result.proposal.completionCriterion,
          loopContract: loopContractInput(
            trustedProposal,
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
        if (run !== undefined) await completeLoopRun(run, 'ERROR', 0, 'cancelled');
      },
      sendInput: () => {
        host.sendNormalUserInput(draft.objective);
      },
    },
  );
}

async function ensureTuiWorkspaceTrust(
  host: SlashCommandHost,
  proposal: Pick<FinishLineProposal, 'gateApproval' | 'gatePlan' | 'workspaceIdentity'>,
): Promise<WorkspaceTrustGrant | undefined | false> {
  if (!proposal.gateApproval.hasExecutableChecks) return undefined;
  const existing = await findWorkspaceTrust(proposal.workspaceIdentity.workspaceIdentityDigest);
  if (existing !== undefined) return existing;
  return new Promise<WorkspaceTrustGrant | false>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Trust this workspace before running project checks?',
        hint: '↑↓ navigate · Enter select · Esc cancel',
        notice: [
          `Canonical path   ${proposal.workspaceIdentity.canonicalRealpath}`,
          `Identity         ${proposal.workspaceIdentity.workspaceIdentityDigest}`,
          `Selected checks  ${String(proposal.gatePlan.requiredChecks.length)}`,
          'Risk summary     project shell commands run with current OS permissions',
        ].join('\n'),
        noticeTone: 'warning',
        options: [
          {
            value: 'session',
            label: 'Trust once',
            description: 'Valid only for this Wukong process.',
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
  proposal: FinishLineProposal,
  supersedesGoalId?: string,
  supersedesContractId?: string,
): LoopContractV2Input {
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
    reviewPolicy: proposal.reviewPolicy,
    source: 'user',
    supersedesGoalId,
    supersedesContractId,
  };
}

function cancelFinishLine(host: SlashCommandHost, rawArgs: string): void {
  host.restoreInputText(`/loop ${rawArgs.trim()}`);
  host.showStatus('Loop not started.');
}
