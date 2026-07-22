import type { Component, Focusable } from '@earendil-works/pi-tui';
import type { DeviceAuthorization } from '@wukong/wukong-oauth';
import type { WukongHarness, Session } from '@wukong/wukong-sdk';

import type { ColorToken, ThemeName } from '#/tui/theme';
import type { SessionSource } from '#/tui/components/dialogs/session-picker';

import { LLM_NOT_SET_MESSAGE } from '../constant/wukong-tui';
import type { AuthFlowController } from '../controllers/auth-flow';
import type { BtwPanelController } from '../controllers/btw-panel';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import { tryHandleDanceCommand } from '../easter-eggs/dance';
import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  LoginProgressSpinnerHandle,
  QueuedMessage,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { handleLoginCommand, handleLogoutCommand } from './auth';
import { handleBtwCommand } from './btw';
import {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleModelCommand,
  handlePlanCommand,
  handleThemeCommand,
  handleYoloCommand,
  showExperimentsPanel,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
import { handleGoalCommand, handleLoopSlashCommand } from './goal';
import { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
import { handleAddDirCommand } from './add-dir';
import { parseSlashInput } from './parse';
import { handlePluginsCommand } from './plugins';
import { handleProviderCommand } from './provider';
import type { BuiltinSlashCommandName } from './registry';
import { handleReloadCommand, handleReloadTuiCommand } from './reload';
import { resolveSlashCommandInput, slashBusyMessage, slashDisabledMessage } from './resolve';
import {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
import { handleSwarmCommand } from './swarm';
import { handleUndoCommand } from './undo';
import { handleWebCommand } from './web';
import { handleTransformCommand } from './role';
import { handleReviewSlashCommand } from './review';
import {
  handleVerifySlashCommand,
  handleScanSlashCommand,
  handleGuardSlashCommand,
  handleProofSlashCommand,
  handleJudgeSlashCommand,
} from './verification';

// ---------------------------------------------------------------------------
// Re-exports — keep existing consumers working
// ---------------------------------------------------------------------------

export { handleLoginCommand, handleLogoutCommand } from './auth';
export { handleBtwCommand } from './btw';
export { handleAddDirCommand } from './add-dir';
export {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleModelCommand,
  handlePlanCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showExperimentsPanel,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
export { handleSwarmCommand } from './swarm';
export { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
export { handlePluginsCommand } from './plugins';
export { handleReloadCommand, handleReloadTuiCommand } from './reload';
export { handleGoalCommand } from './goal';
export {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
export { handleUndoCommand } from './undo';
export { handleWebCommand } from './web';

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: WukongHarness;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  refreshSlashCommandAutocomplete(): void;

  // Session
  requireSession(): Session;
  switchToSession(session: Session, message: string): Promise<void>;
  reloadCurrentSessionView(session: Session, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  requestQueuedGoalPromotion?(): void;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  setExitOpenUrl(url: string): void;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(source?: SessionSource): Promise<void>;
  sendNormalUserInput(text: string): void;
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  readonly skillCommandMap: Map<string, string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly authFlow: AuthFlowController;
}

// ---------------------------------------------------------------------------
// Dispatch — entry point from handleUserInput
// ---------------------------------------------------------------------------

const REMOVED_SLASH_COMMAND_HINTS: Readonly<Record<string, string>> = {
  role: 'Unknown slash command: /role. Use /transform to change the current session; manage profiles with `wukong roles`.',
  report: 'Unknown slash command: /report. Use /export-md for Markdown or /export for a ZIP archive.',
  yes: 'Unknown slash command: /yes. Use /yolo on only when you intentionally accept its risk.',
};

export function dispatchInput(host: SlashCommandHost, text: string): void {
  if (parseSlashInput(text) !== null) {
    void executeSlashCommand(host, text);
    return;
  }
  host.sendNormalUserInput(text);
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const parsedCommand = parseSlashInput(input);
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: host.skillCommandMap,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
  });

  switch (intent.kind) {
    case 'not-command':
      return;
    case 'blocked':
      host.track('input_command_invalid', { reason: 'blocked', command: intent.commandName });
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      return;
    case 'disabled':
      host.track('input_command_invalid', { reason: 'disabled', command: intent.commandName });
      host.showError(slashDisabledMessage(intent.commandName, intent.experimentalFlag));
      return;
    case 'invalid':
      if (parsedCommand !== null && tryHandleDanceCommand(host, parsedCommand)) {
        return;
      }
      host.track('input_command_invalid', {
        reason: intent.reason,
        command: intent.commandName,
      });
      host.showError(REMOVED_SLASH_COMMAND_HINTS[intent.commandName]
        ?? (intent.suggestions.length === 0
          ? `Unknown slash command: /${intent.commandName}. Run /help to list commands.`
          : `Unknown slash command: /${intent.commandName}. Did you mean ${intent.suggestions.map((name) => `/${name}`).join(', ')}?`));
      return;
    case 'skill': {
      const session = host.session;
      if (host.state.appState.model.trim().length === 0 || session === undefined) {
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      host.track('input_command', {
        command: intent.commandName,
        skill_name: intent.skillName,
      });
      host.sendSkillActivation(session, intent.skillName, intent.args);
      return;
    }
    case 'builtin':
      host.track('input_command', { command: intent.name });
      if (intent.name === 'new' && parsedCommand?.name === 'clear') {
        host.track('clear');
      }
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
): Promise<void> {
  if (args.trim().length > 0 && NO_ARGUMENT_COMMANDS.has(name)) {
    host.showError(`Usage: /${name}`);
    return;
  }
  switch (name) {
    case 'exit':
      void host.stop();
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(`Wukong v${host.state.appState.version}`);
      return;
    case 'new':
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    case 'resume': {
      const source = parseResumeSource(args);
      if (source === null) {
        host.showError('Usage: /resume [codex|claude|cursor]');
        return;
      }
      void host.showSessionPicker(source);
      return;
    }
    case 'resume-codex':
      void host.showSessionPicker('codex');
      return;
    case 'resume-claude':
      void host.showSessionPicker('claude');
      return;
    case 'resume-cursor':
      void host.showSessionPicker('cursor');
      return;
    case 'tasks':
      void host.tasksBrowserController.show();
      return;
    case 'mcp':
      void showMcpServers(host);
      return;
    case 'plugins':
      void handlePluginsCommand(host, args);
      return;
    case 'add-dir':
      await handleAddDirCommand(host, args);
      return;
    case 'experiments':
      await showExperimentsPanel(host);
      return;
    case 'reload':
      await handleReloadCommand(host);
      return;
    case 'reload-tui':
      await handleReloadTuiCommand(host);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'model':
      await handleModelCommand(host, args);
      return;
    case 'transform':
      await handleTransformCommand(host, args);
      return;
    case 'provider':
      await handleProviderCommand(host);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'settings':
      showSettingsSelector(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'status':
      void showStatusReport(host);
      return;
    case 'feedback':
      await handleFeedbackCommand(host);
      return;
    case 'btw':
      await handleBtwCommand(host, args);
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yolo':
      await handleYoloCommand(host, args);
      return;
    case 'auto':
      await handleAutoCommand(host, args);
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'swarm':
      await handleSwarmCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'goal':
      await handleGoalCommand(host, args);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'export-md':
      await handleExportMdCommand(host, args);
      return;
    case 'export-debug-zip':
      await handleExportDebugZipCommand(host);
      return;
    case 'login':
      await handleLoginCommand(host);
      return;
    case 'logout':
      await handleLogoutCommand(host);
      return;
    case 'undo':
      await handleUndoCommand(host, args);
      return;
    case 'web':
      await handleWebCommand(host);
      return;
    case 'verify':
      await handleVerifySlashCommand(host, args);
      return;
    case 'scan':
      await handleScanSlashCommand(host);
      return;
    case 'proof':
      await handleProofSlashCommand(host);
      return;
    case 'judge':
      await handleJudgeSlashCommand(host);
      return;
    case 'loop':
      await handleLoopSlashCommand(host, args);
      return;
    case 'guard':
      await handleGuardSlashCommand(host, args);
      return;
    case 'review':
      await handleReviewSlashCommand(host, args);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}

const NO_ARGUMENT_COMMANDS = new Set<BuiltinSlashCommandName>([
  'exit',
  'help',
  'version',
  'new',
  'resume-codex',
  'resume-claude',
  'resume-cursor',
  'tasks',
  'mcp',
  'experiments',
  'reload',
  'reload-tui',
  'provider',
  'permission',
  'settings',
  'usage',
  'status',
  'feedback',
  'init',
  'fork',
  'export-debug-zip',
  'login',
  'logout',
  'web',
  'verify',
  'scan',
  'proof',
  'judge',
]);

function parseResumeSource(args: string): SessionSource | null {
  const value = args.trim().toLowerCase();
  if (value.length === 0) return 'wukong';
  if (value === 'codex' || value === 'claude' || value === 'cursor') {
    return value;
  }
  return null;
}
