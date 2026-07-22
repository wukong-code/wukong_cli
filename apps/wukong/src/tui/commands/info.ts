import { randomUUID } from 'node:crypto';

import type { McpServerInfo, SessionStatus, SessionUsage } from '@wukong/wukong-sdk';

import { buildMcpStatusReportLines } from '../components/messages/mcp-status-panel';
import { buildStatusReportLines } from '../components/messages/status-panel';
import { buildUsageReportLines, UsagePanelComponent, type ManagedUsageReport } from '../components/messages/usage-panel';
import {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_STATUS_CANCELLED,
  FEEDBACK_STATUS_FALLBACK,
  FEEDBACK_STATUS_SUBMITTING,
  FEEDBACK_STATUS_SUCCESS,
  feedbackIdLine,
} from '../constant/feedback';
import { isManagedUsageProvider } from '../constant/wukong-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  promptFeedbackCategory,
  promptFeedbackConfirmation,
  promptFeedbackInput,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export async function handleFeedbackCommand(host: SlashCommandHost): Promise<void> {
  const fallback = (reason: string): void => {
    host.showStatus(reason);
    host.showStatus(FEEDBACK_ISSUE_URL);
  };

  // Stage 1: collect the free-form feedback text.
  const input = await promptFeedbackInput(host);
  if (input === undefined) {
    host.showStatus(FEEDBACK_STATUS_CANCELLED);
    return;
  }

  const category = await promptFeedbackCategory(host);
  if (category === undefined) {
    host.showStatus(FEEDBACK_STATUS_CANCELLED);
    return;
  }

  const platform = feedbackPlatform();
  const arch = feedbackArch();
  if (platform === undefined || arch === undefined) {
    fallback('Feedback is not available on this platform. You can use GitHub Issues instead:');
    return;
  }
  const loopOutcome = host.state.appState.lastProofSummary?.status === 'pass'
    ? 'PASS' as const
    : host.state.appState.lastProofSummary?.status === 'blocked'
      ? 'NEEDS_WORK' as const
      : undefined;
  const payload = {
    message: input.value,
    category,
    version: host.state.appState.version,
    platform,
    arch,
    ...(loopOutcome === undefined ? {} : { loop_outcome: loopOutcome }),
  };
  if (!(await promptFeedbackConfirmation(host, payload))) {
    host.showStatus(FEEDBACK_STATUS_CANCELLED);
    return;
  }

  const spinner = host.showLoginProgressSpinner(FEEDBACK_STATUS_SUBMITTING);
  const res = await host.harness.auth.submitFeedback({
    message: input.value,
    category,
    version: host.state.appState.version,
    platform,
    arch,
    loopOutcome,
    idempotencyKey: randomUUID(),
  });

  if (res.kind !== 'ok') {
    spinner.stop({ ok: false, label: res.message });
    fallback(FEEDBACK_STATUS_FALLBACK);
    return;
  }

  spinner.stop({ ok: true, label: FEEDBACK_STATUS_SUCCESS });
  host.showStatus(feedbackIdLine(res.feedbackId));
}

function feedbackPlatform(): 'darwin' | 'linux' | 'win32' | undefined {
  return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : undefined;
}

function feedbackArch(): 'arm64' | 'x64' | undefined {
  return process.arch === 'arm64' || process.arch === 'x64' ? process.arch : undefined;
}

// ---------------------------------------------------------------------------
// Info commands
// ---------------------------------------------------------------------------

interface SessionUsageResult {
  readonly usage?: SessionUsage;
  readonly error?: string;
}

interface RuntimeStatusResult {
  readonly status?: SessionStatus;
  readonly error?: string;
}

interface ManagedUsageResult {
  readonly usage?: ManagedUsageReport;
  readonly error?: string;
}

export async function showUsage(host: SlashCommandHost): Promise<void> {
  const sessionUsage = await loadSessionUsageReport(host);
  const managedUsage = await loadManagedUsageReport(host);
  const reportArgs = {
    sessionUsage: sessionUsage.usage,
    sessionUsageError: sessionUsage.error,
    contextUsage: host.state.appState.contextUsage,
    contextTokens: host.state.appState.contextTokens,
    maxContextTokens: host.state.appState.maxContextTokens,
    managedUsage: managedUsage?.usage,
    managedUsageError: managedUsage?.error,
  };
  const panel = new UsagePanelComponent(() => buildUsageReportLines(reportArgs), 'primary');
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function showStatusReport(host: SlashCommandHost): Promise<void> {
  const [runtimeStatus, managedUsage] = await Promise.all([
    loadRuntimeStatusReport(host),
    loadManagedUsageReport(host),
  ]);
  const appState = host.state.appState;
  const reportArgs = {
    version: appState.version,
    model: appState.model,
    workDir: appState.workDir,
    sessionId: appState.sessionId,
    sessionTitle: appState.sessionTitle,
    thinking: appState.thinking,
    permissionMode: appState.permissionMode,
    planMode: appState.planMode,
    contextUsage: appState.contextUsage,
    contextTokens: appState.contextTokens,
    maxContextTokens: appState.maxContextTokens,
    availableModels: appState.availableModels,
    status: runtimeStatus.status,
    statusError: runtimeStatus.error,
    managedUsage: managedUsage?.usage,
    managedUsageError: managedUsage?.error,
  };
  const panel = new UsagePanelComponent(() => buildStatusReportLines(reportArgs), 'primary', ' Status ');
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function showMcpServers(host: SlashCommandHost): Promise<void> {
  let servers: readonly McpServerInfo[];
  try {
    servers = await host.requireSession().listMcpServers();
  } catch (error) {
    host.showError(`Failed to load MCP servers: ${formatErrorMessage(error)}`);
    return;
  }

  const title = servers.length > 0 ? ` MCP (${servers.length}) ` : ' MCP ';
  const panel = new UsagePanelComponent(
    () => buildMcpStatusReportLines({ servers }),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function loadSessionUsageReport(host: SlashCommandHost): Promise<SessionUsageResult> {
  try {
    return { usage: await host.requireSession().getUsage() };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

async function loadRuntimeStatusReport(host: SlashCommandHost): Promise<RuntimeStatusResult> {
  try {
    return { status: await host.requireSession().getStatus() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadManagedUsageReport(host: SlashCommandHost): Promise<ManagedUsageResult | undefined> {
  const alias = host.state.appState.model;
  const providerKey = host.state.appState.availableModels[alias]?.provider;
  const managedProvider = isManagedUsageProvider(providerKey) ? providerKey : undefined;

  // Account status is independent from the active model. In 0.0.18 a user can
  // be signed in while the hosted catalog is empty and a BYOK model remains
  // active, so /usage and /status must still report the real (currently empty)
  // managed usage response instead of hiding it behind the active provider.
  if (managedProvider === undefined) {
    try {
      if ((await host.harness.auth.getCachedAccessToken()) === undefined) return undefined;
    } catch {
      return undefined;
    }
  }

  let res;
  try {
    res = await host.harness.auth.getManagedUsage(managedProvider);
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
  if (res.kind === 'error') {
    return { error: res.message };
  }
  return { usage: { summary: res.summary, limits: res.limits } };
}
