/**
 * Loop phase heartbeat line rendered between the transcript and the editor
 * separator. It answers "what is the loop doing right now?" at a glance.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export type LoopPhase =
  | 'writing'
  | 'verifying'
  | 'judging'
  | 'proofing'
  | 'waiting'
  | 'paused'
  | 'composing'
  | 'thinking'
  | 'shell'
  | 'blocked';

export interface LoopPhaseState {
  readonly phase: LoopPhase;
  /** Current iteration (1-based). */
  readonly iteration: number;
  /** Maximum iterations, if known. */
  readonly maxIterations?: number;
  /** Elapsed milliseconds in the current phase/iteration. */
  readonly elapsedMs: number;
  /** Reason shown when phase is 'blocked'. */
  readonly blockedReason?: string;
  /** Goal objective shown after the high-signal phase fields. */
  readonly objective?: string;
  /** Recommended recovery action shown for a blocked goal. */
  readonly nextAction?: string;
  /** Seconds until the next retry when a cron loop is throttled. */
  readonly cronRetryInSec?: number;
  /** Cron interval string, e.g. "1m". */
  readonly cronInterval?: string;
  /** Whether the line should use the warning colour. */
  readonly warning?: boolean;
  /** When true the component renders nothing (used in idle mode). */
  readonly hidden?: boolean;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function phaseIcon(phase: LoopPhase): string {
  switch (phase) {
    case 'blocked':
      return '⛔';
    case 'paused':
      return 'Ⅱ';
    case 'waiting':
    case 'thinking':
    case 'composing':
      return '◐';
    case 'writing':
    case 'verifying':
    case 'judging':
    case 'proofing':
    case 'shell':
      return '↻';
  }
}

function phaseLabel(phase: LoopPhase): string {
  switch (phase) {
    case 'writing':
      return 'WRITE';
    case 'verifying':
      return 'CHECK';
    case 'judging':
      return 'REVIEW';
    case 'proofing':
      return 'REVIEW';
    case 'waiting':
      return 'WAIT';
    case 'paused':
      return 'PAUSED';
    case 'composing':
      return 'COMPOSE';
    case 'thinking':
      return 'THINK';
    case 'shell':
      return 'SHELL';
    case 'blocked':
      return 'BLOCKED';
  }
}

export class LoopPhaseComponent implements Component {
  private state: LoopPhaseState;

  constructor(state: LoopPhaseState) {
    this.state = state;
  }

  setState(state: LoopPhaseState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.state;
    if (state.hidden) return [];

    const primaryParts: string[] = [];
    const secondaryParts: string[] = [];

    // Iteration budget: "3/10"
    if (state.iteration > 0) {
      const iterBudget =
        state.maxIterations !== undefined
          ? `${state.iteration}/${state.maxIterations}`
          : String(state.iteration);
      primaryParts.push(`${phaseIcon(state.phase)} ${iterBudget}`);
    } else {
      primaryParts.push(phaseIcon(state.phase));
    }

    if (state.phase === 'blocked') {
      primaryParts.push(phaseLabel(state.phase));
      if (state.nextAction) secondaryParts.push(`Next: ${state.nextAction}`);
      if (state.blockedReason) secondaryParts.push(state.blockedReason);
    } else if (state.cronRetryInSec !== undefined && state.cronRetryInSec > 0) {
      const intervalSuffix = state.cronInterval ? ` (--every ${state.cronInterval})` : '';
      primaryParts.push(`RETRY ${state.cronRetryInSec}s${intervalSuffix}`);
    } else {
      primaryParts.push(phaseLabel(state.phase));
    }

    primaryParts.push(formatElapsed(state.elapsedMs));
    if (state.phase !== 'blocked' && state.objective) secondaryParts.push(state.objective);

    const primary = currentTheme.boldFg(
      state.warning ? 'warning' : 'primary',
      primaryParts.join('  '),
    );
    const secondary =
      secondaryParts.length > 0
        ? currentTheme.fg(
            state.warning ? 'warning' : 'textDim',
            `  ·  ${secondaryParts.join('  ·  ')}`,
          )
        : '';
    return [truncateToWidth(`${primary}${secondary}`, width, '…')];
  }
}

export function formatLoopPhaseText(state: LoopPhaseState): string {
  return new LoopPhaseComponent(state).render(1000)[0] ?? '';
}
