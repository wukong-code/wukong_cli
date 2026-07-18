/**
 * Shared today briefing formatting for CLI and TUI chrome.
 *
 * Keeps the compact summary string consistent between `wukong today`
 * and the TUI footer/welcome idle state.
 */

import type { TodayBriefing } from '#/utils/stats';

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

export function formatTodayFull(briefing: TodayBriefing): string {
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

  if (briefing.next.length > 0) {
    lines.push('', 'Next');
    for (const suggestion of briefing.next) {
      lines.push(`  → ${suggestion}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
