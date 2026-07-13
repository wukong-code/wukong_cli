/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Idle:   Today + contextual tip / modes + model + cwd + git + context
 *   Active: deterministic gate evidence / modes + model + cwd + git + context
 * The loop phase rail above the editor owns objective, iteration, phase, and
 * blocked recovery copy so the footer does not repeat them.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { ALL_TIPS, type ToolbarTip } from '#/tui/constant/tips';
import { isRainbowDancing, renderDanceFooterModel } from '#/tui/easter-eggs/dance';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import type { ChromeStateAggregator } from '#/tui/utils/chrome-state';
import { formatTodayCompact } from '#/tui/utils/today-format';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import { safeUsageRatio } from '#/utils/usage/usage-format';

const MAX_CWD_SEGMENTS = 3;

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' | ';

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic and computed once at module load. Exported for
 * unit testing.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

const ROTATION: readonly ToolbarTip[] = buildWeightedTips(ALL_TIPS);

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * Pick the tip(s) for a rotation index over the weighted ROTATION sequence.
 * `primary` is always shown when it fits; `pair` (primary + next tip joined
 * by the separator) is offered for wide terminals. Pairing is skipped when
 * the current/next tip is `solo` or when the neighbour is a duplicate of the
 * current tip (which can happen at the wrap boundary), keeping long/important
 * tips on their own and avoiding "X | X".
 */
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const n = ROTATION.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = ROTATION[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = ROTATION[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: current.text, pair: null };
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text };
}

function formatVerifyStatus(
  summary: import('#/tui/utils/chrome-state').VerifySummary | null,
  colors: ColorPalette,
): string {
  if (summary === null) return chalk.hex(colors.textMuted)('Verify —');
  const icon = summary.status === 'passed' ? '✓' : '✗';
  const detail = summary.detail ? ` ${summary.detail}` : '';
  const paint = chalk.hex(summary.status === 'passed' ? colors.success : colors.error);
  return paint(`Verify ${icon}${detail}`);
}

function formatProofStatus(
  summary: import('#/tui/utils/chrome-state').ProofSummary | null,
  colors: ColorPalette,
): string {
  if (summary === null) return chalk.hex(colors.textMuted)('Proof —');
  const status = summary.status.toUpperCase();
  const detail = summary.summary ? ` · ${summary.summary}` : '';
  const paint = chalk.hex(summary.status === 'pass' ? colors.success : colors.error);
  return paint(`Proof ${status}${detail}`);
}

function buildConclusionLines(
  chromeState: ChromeStateAggregator,
  colors: ColorPalette,
): { lines: string[]; useWarning: boolean } {
  const state = chromeState.getState();
  const { uiMode, goal, lastVerify, lastProof, todayBriefing } = state;

  if (uiMode === 'idle') {
    if (todayBriefing !== null) {
      return {
        lines: [formatTodayCompact({ briefing: todayBriefing })],
        useWarning: false,
      };
    }
    return { lines: [], useWarning: false };
  }

  const gate = goal?.stopCondition ?? 'self';
  const gatePaint = chalk.hex(uiMode === 'blocked' ? colors.warning : colors.textDim);
  const evidence = [
    gatePaint(`Gate ${gate}`),
    formatVerifyStatus(lastVerify, colors),
    formatProofStatus(lastProof, colors),
  ];

  return {
    lines: [evidence.join(chalk.hex(colors.textMuted)('  ·  '))],
    useWarning: uiMode === 'blocked',
  };
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = `${(safeUsage(usage) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `context: ${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${pct}`;
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.textDim)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private readonly chromeState: ChromeStateAggregator;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(
    state: AppState,
    chromeState: ChromeStateAggregator,
    onRefresh: () => void = () => {},
  ) {
    this.state = state;
    this.chromeState = chromeState;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.state = state;
  }

  /**
   * Short-lived hint that replaces the rotating toolbar tips on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;

    const { lines: conclusionLines, useWarning } = buildConclusionLines(this.chromeState, colors);

    // Idle mode: append rotating tips to the today line when space allows.
    const chromeState = this.chromeState.getState();
    let idleTip: string | null = null;
    if (chromeState.uiMode === 'idle' && conclusionLines[0] !== undefined) {
      const { primary, pair } = tipsForIndex(currentTipIndex());
      const remaining = Math.max(0, width - visibleWidth(conclusionLines[0]) - 2);
      if (pair && visibleWidth(pair) <= remaining) {
        idleTip = pair;
      } else if (primary && visibleWidth(primary) <= remaining) {
        idleTip = primary;
      }
    }

    const renderedConclusion: string[] = [];
    for (let i = 0; i < conclusionLines.length; i++) {
      let raw = conclusionLines[i]!;
      if (i === 0 && idleTip !== null) {
        const pad = width - visibleWidth(raw) - visibleWidth(idleTip);
        raw = raw + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textMuted)(idleTip);
      }
      renderedConclusion.push(truncateToWidth(raw, width, useWarning ? '…' : '…'));
    }

    // ── Env track: modes · model · cwd · git · context ──
    const envParts: string[] = [];

    if (state.permissionMode === 'auto') {
      envParts.push(chalk.hex(colors.warning).bold('[auto]'));
    }
    if (state.permissionMode === 'yolo') {
      envParts.push(chalk.hex(colors.warning).bold('[yolo]'));
    }
    if (state.planMode) envParts.push(chalk.hex(colors.primary).bold('[plan]'));
    if (state.swarmMode) envParts.push(chalk.hex(colors.accent).bold('[swarm]'));

    const model = modelDisplayName(state);
    if (model) {
      const thinkingLabel = state.thinking ? ' thinking' : '';
      const modelLabel = `${model}${thinkingLabel}`;
      let renderedModelLabel = chalk.hex(colors.text)(modelLabel);
      if (isRainbowDancing()) {
        renderedModelLabel = renderDanceFooterModel(modelLabel);
      }
      envParts.push(renderedModelLabel);
    }

    // Background-task badges sit immediately before cwd. `bash-*` tasks
    // (shell processes) and `agent-*` tasks (background subagents) get
    // separate badges so the user can distinguish them at a glance.
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? 'task' : 'tasks';
      envParts.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundBashTaskCount)} ${noun} running]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? 'agent' : 'agents';
      envParts.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundAgentCount)} ${noun} running]`),
      );
    }

    const cwd = shortenCwd(state.workDir);
    if (cwd) envParts.push(chalk.hex(colors.textDim)(cwd));

    const git = this.gitCache.getStatus();
    if (git !== null) {
      envParts.push(formatFooterGitBadge(git, colors));
    }

    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    envParts.push(chalk.hex(colors.text)(contextText));

    const envLine = envParts.join('  ');

    const lines: string[] = [];
    if (this.transientHint) {
      lines.push(
        chalk.hex(colors.warning).bold(
          truncateToWidth(this.transientHint, Math.max(0, width), '…'),
        ),
      );
    }
    for (const conclusion of renderedConclusion) {
      if (conclusion.length > 0) lines.push(conclusion);
    }
    if (envLine.length > 0) lines.push(truncateToWidth(envLine, width));

    return lines.length > 0 ? lines : [''.padEnd(width, ' ')];
  }
}
