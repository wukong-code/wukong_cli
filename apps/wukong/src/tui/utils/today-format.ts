/**
 * Shared today briefing formatting for CLI and TUI chrome.
 *
 * Keeps the compact summary string consistent between `wukong today`
 * and the TUI footer/welcome idle state.
 */

import type { TodayBriefing } from '#/utils/stats';

export interface HostedReportUsageSummary {
  readonly tier: string;
  readonly used: number;
  readonly limit: number | 'unlimited';
  readonly dashboardUrl: string;
}

export interface FormatTodayCompactOptions {
  readonly briefing: TodayBriefing;
  readonly includeFocus?: boolean;
}

export function formatTodayCompact(options: FormatTodayCompactOptions): string {
  const { briefing, includeFocus = true } = options;
  const parts: string[] = [
    `Today: verify ${String(briefing.today.verify.runs)} (${String(briefing.today.verify.passed)}✓ ${String(briefing.today.verify.failed)}✗) · scan ${String(briefing.today.scan.runs)} · proof ${String(briefing.today.proof.runs)} ${briefing.today.proof.lastStatus ?? ''}`.trimEnd(),
  ];

  if (includeFocus && briefing.focus) {
    parts.push(`Focus: ${briefing.focus}`);
  }

  return parts.join(' · ');
}

export function formatTodayFull(
  briefing: TodayBriefing,
  hosted: HostedReportUsageSummary | null = null,
): string {
  const lines = [
    `Wukong Today — ${briefing.date}`,
    '',
    `Focus: ${briefing.focus ?? '(not set) — wukong today "<your goal>"'}`,
    '',
    `Workspace: ${briefing.workspace.cwd} (${String(briefing.workspace.changedFiles)} changed)`,
    formatTodayCompact({ briefing, includeFocus: false }),
    `Streak: ${String(briefing.streak)} day${briefing.streak === 1 ? '' : 's'} with at least 1 clean verify`,
  ];

  if (briefing.lastProof !== undefined) {
    lines.push(`Last proof: ${briefing.lastProof.status.toUpperCase()} — ${briefing.lastProof.summary}`);
  }

  if (hosted !== null) {
    const limit = hosted.limit === 'unlimited' ? 'unlimited' : String(hosted.limit);
    lines.push(
      `Hosted reports: ${String(hosted.used)} / ${limit} (${hosted.tier})`,
      `Dashboard: ${hosted.dashboardUrl}`,
    );
  }

  if (briefing.next.length > 0) {
    lines.push('', 'Next');
    for (const suggestion of briefing.next) {
      lines.push(`  → ${suggestion}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
