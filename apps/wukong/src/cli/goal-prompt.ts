import type { GoalSnapshot } from '@wukong/wukong-sdk';

import { parseGoalCommand, parseLoopCommand } from '#/tui/commands/index';
import { loopNextAction, loopOutcomeFromGoal, type LoopStatus } from '#/utils/loop-result';

export type { LoopStatus } from '#/utils/loop-result';

/**
 * Headless goal-mode support for the `wukong -p "/goal <objective>"` prompt path.
 *
 * The goal driver keeps the prompt's turn-run alive across continuation turns
 * until the goal reaches a terminal state, so the existing prompt-turn waiter
 * already blocks until then. This module adds the create-on-entry parsing, a
 * machine-readable summary, and the terminal-status → exit-code mapping.
 */

export interface HeadlessGoalCreate {
  readonly kind: 'goal' | 'loop';
  readonly objective: string;
  readonly replace: boolean;
  readonly stopCondition?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations?: number;
  readonly minIntervalMs?: number;
  readonly reviewModel?: string;
}

/**
 * Exit codes by final goal status. The lifecycle has only one success outcome
 * (`complete` → 0) and two resumable stopped states: `blocked` (the system
 * stopped pursuing — the model's UpdateGoal, a budget, or an error) and `paused`
 * (a turn abort / SIGINT). Both are non-zero — the goal did not complete. An absent goal
 * (should not happen on the create path) maps to success.
 */
export const GOAL_EXIT_CODES = {
  complete: 0,
  blocked: 3,
  paused: 6,
} as const;

export function goalExitCode(status: string | undefined): number {
  switch (status) {
    case 'blocked':
      return GOAL_EXIT_CODES.blocked;
    case 'paused':
      return GOAL_EXIT_CODES.paused;
    case undefined:
      return GOAL_EXIT_CODES.complete;
    default:
      return GOAL_EXIT_CODES.complete;
  }
}

const GOAL_PREFIX = /^\/goal(\s|$)/;
const LOOP_PREFIX = /^\/loop(\s|$)/;

/**
 * Parses a headless prompt into a goal-create request, or `undefined` when the
 * prompt is not a `/goal` create command (so the caller runs it as a normal
 * prompt). Non-create goal subcommands are not supported headless and fall
 * through to normal prompt handling.
 */
export function parseHeadlessGoalCreate(prompt: string): HeadlessGoalCreate | undefined {
  const trimmed = prompt.trim();
  if (LOOP_PREFIX.test(trimmed)) {
    const args = trimmed.replace(/^\/loop/, '').trim();
    const parsed = parseLoopCommand(args);
    if (parsed.kind !== 'create') return undefined;
    return {
      kind: 'loop',
      objective: parsed.objective,
      replace: false,
      stopCondition: parsed.stopCondition,
      maxIterations: parsed.maxIterations,
      reviewModel: parsed.reviewModel,
      ...(parsed.minIntervalMs === undefined ? {} : { minIntervalMs: parsed.minIntervalMs }),
    };
  }
  if (!GOAL_PREFIX.test(trimmed)) return undefined;
  const args = trimmed.replace(/^\/goal/, '').trim();
  const parsed = parseGoalCommand(args);
  if (parsed.kind !== 'create') return undefined;
  return {
    kind: 'goal',
    objective: parsed.objective,
    replace: parsed.replace,
    ...(parsed.stopCondition === undefined ? {} : { stopCondition: parsed.stopCondition }),
    ...(parsed.maxIterations === undefined ? {} : { maxIterations: parsed.maxIterations }),
    ...(parsed.minIntervalMs === undefined ? {} : { minIntervalMs: parsed.minIntervalMs }),
  };
}

export interface LoopSummary {
  readonly type: 'loop.result';
  readonly schemaVersion: 2;
  readonly status: LoopStatus;
  readonly reasonCode: string;
  readonly summary: string;
  readonly iterations: number;
  readonly checks: readonly unknown[];
  readonly blockers: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly nextAction: string;
  }>;
}

export const LOOP_EXIT_CODES = {
  PASS: 0,
  NEEDS_WORK: 1,
  ERROR: 2,
  interrupted: 130,
} as const;

export function loopSummaryJson(goal: GoalSnapshot | null): LoopSummary {
  if (goal?.loopResult !== undefined) {
    return {
      type: 'loop.result',
      ...goal.loopResult,
    };
  }
  const outcome = loopOutcomeFromGoal(goal);
  return {
    type: 'loop.result',
    schemaVersion: 2,
    status: outcome.status,
    reasonCode: outcome.reasonCode,
    summary: outcome.summary,
    iterations: goal?.iteration ?? 0,
    checks: [],
    blockers: outcome.status === 'PASS'
      ? []
      : [{ id: outcome.reasonCode, summary: outcome.summary, nextAction: loopNextAction(outcome.reasonCode) }],
  };
}

export function formatLoopSummaryText(goal: GoalSnapshot | null): string {
  const result = loopSummaryJson(goal);
  return `Loop ${result.status}: ${result.summary} (iterations: ${String(result.iterations)})`;
}

export function loopExitCode(goal: GoalSnapshot | null): number {
  if (goal?.status === 'paused') return LOOP_EXIT_CODES.interrupted;
  return LOOP_EXIT_CODES[loopOutcomeFromGoal(goal).status];
}

export interface GoalSummary {
  readonly type: 'goal.summary';
  readonly goalId: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly turnsUsed: number | null;
  readonly tokensUsed: number | null;
  readonly wallClockMs: number | null;
}

export function goalSummaryJson(goal: GoalSnapshot | null): GoalSummary {
  if (goal === null) {
    return {
      type: 'goal.summary',
      goalId: null,
      status: null,
      reason: null,
      turnsUsed: null,
      tokensUsed: null,
      wallClockMs: null,
    };
  }
  return {
    type: 'goal.summary',
    goalId: goal.goalId,
    status: goal.status,
    reason: goal.terminalReason ?? null,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
  };
}

export function formatGoalSummaryText(goal: GoalSnapshot | null): string {
  if (goal === null) return 'Goal: no goal found.';
  const parts = [`Goal [${goal.status}]`];
  if (goal.terminalReason !== undefined) parts.push(goal.terminalReason);
  return `${parts.join(': ')} (turns: ${goal.turnsUsed}, tokens: ${goal.tokensUsed})`;
}
