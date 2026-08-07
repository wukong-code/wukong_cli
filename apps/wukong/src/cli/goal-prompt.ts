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
  readonly writerProviderCallLimit?: number;
  readonly reviewerProviderCallLimit?: number;
  readonly tokenBudget?: number;
  readonly minIntervalMs?: number;
  readonly reviewModel?: string;
  readonly completionCriterion?: string;
  readonly constraints?: readonly string[];
  readonly checks?: readonly string[];
  readonly discoveredCheckDecision?: 'accept' | 'only-explicit';
  readonly trustWorkspaceChallenge?: string;
  readonly approveGatePlanDigest?: string;
  readonly acknowledgeWarningSetDigest?: string;
  readonly acknowledgeNoExecutableChecksDigest?: string;
  readonly verificationCatalogDigest?: string;
  readonly verificationSkills?: readonly {
    readonly selectionId: string;
    readonly provenanceDigest: string;
  }[];
  readonly trustReviewSubjectChallenge?: string;
  readonly acknowledgeReviewSubjectConsentDigest?: string;
}

/**
 * Exit codes by final goal status. The lifecycle has only one success outcome
 * (`complete` → 0) and two resumable stopped states: `blocked` (the system
 * stopped pursuing — the model's UpdateGoal, a budget, or an error) and `paused`
 * (a turn abort / SIGINT). Both are non-zero — the goal did not complete. A missing
 * goal or any unknown/non-terminal status is an error: only durable `complete` is success.
 */
export const GOAL_EXIT_CODES = {
  complete: 0,
  error: 2,
  blocked: 3,
  paused: 6,
} as const;

export function goalExitCode(status: string | undefined): number {
  if (status === undefined) return GOAL_EXIT_CODES.error;
  switch (status) {
    case 'complete':
      return GOAL_EXIT_CODES.complete;
    case 'blocked':
      return GOAL_EXIT_CODES.blocked;
    case 'paused':
      return GOAL_EXIT_CODES.paused;
    default:
      return GOAL_EXIT_CODES.error;
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
  readonly writerIterations: number;
  readonly gateAttempts: number | null;
  readonly continuationMode: 'same-contract' | 'restore-or-revise' | 'revised-loop' | 'blocked' | null;
  readonly nextAction: string;
  readonly checks: readonly unknown[];
  readonly changedFiles: ReadonlyArray<{
    readonly path: string;
    readonly status: string;
    readonly attribution?:
      | 'introduced_by_loop'
      | 'modified_by_loop'
      | 'deleted_by_loop'
      | 'pre_existing_or_modified'
      | 'unknown';
    readonly preExisting?: boolean;
    readonly touchedByLoop?: boolean;
  }>;
  readonly evidence: {
    readonly verification: 'fresh' | 'not_run';
    readonly reviewer: 'fresh' | 'not_run';
    readonly completeness?: 'complete' | 'partial' | 'inconclusive';
    readonly fresh?: boolean;
    readonly expectedProducers?: readonly string[];
    readonly observedProducers?: readonly string[];
    readonly missingProducers?: readonly string[];
    readonly generatedAt?: string;
    readonly snapshotId?: string;
  };
  readonly durationMs: number | null;
  readonly tokensUsed: number | null;
  readonly providerUsage: GoalSnapshot['providerUsage'] | null;
  readonly tokenBudget: number | null;
  readonly remainingTokens: number | null;
  readonly blockers: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly nextAction: string;
    readonly file?: string;
    readonly line?: number;
  }>;
}

export const LOOP_EXIT_CODES = {
  PASS: 0,
  NEEDS_WORK: 1,
  ERROR: 2,
  interrupted: 130,
} as const;

export function loopSummaryJson(goal: GoalSnapshot | null): LoopSummary {
  const outcome = loopOutcomeFromGoal(goal);
  const loopTerminal = goal?.loopTerminal;
  const continuationMode = goal !== null
    && loopTerminal !== undefined
    && loopTerminal.runId === goal.loopRunId
    ? loopTerminal.continuationPolicy.mode
    : null;
  if (
    goal?.loopResult !== undefined
    && outcome.status === goal.loopResult.status
    && outcome.reasonCode === goal.loopResult.reasonCode
  ) {
    const result: Omit<LoopSummary, 'nextAction'> = {
      type: 'loop.result',
      ...goal.loopResult,
      changedFiles: goal.loopResult.changedFiles === undefined
        ? []
        : [...goal.loopResult.changedFiles],
      evidence: goal.loopResult.evidence ?? {
        verification: goal.loopResult.checks.length > 0 ? 'fresh' : 'not_run',
        reviewer: 'not_run',
      },
      durationMs: goal.wallClockMs,
      tokensUsed: goal.tokensUsed,
      providerUsage: goal.providerUsage ?? null,
      tokenBudget: goal.budget?.tokenBudget ?? null,
      remainingTokens: goal.budget?.remainingTokens ?? null,
      writerIterations: goal.loopResult.iterations,
      gateAttempts: goal.gateAttempts ?? null,
      continuationMode,
    };
    return { ...result, nextAction: loopSummaryNextAction(result) };
  }
  const result: Omit<LoopSummary, 'nextAction'> = {
    type: 'loop.result',
    schemaVersion: 2,
    status: outcome.status,
    reasonCode: outcome.reasonCode,
    summary: outcome.summary,
    iterations: goal?.iteration ?? 0,
    writerIterations: goal?.iteration ?? 0,
    gateAttempts: goal?.gateAttempts ?? null,
    continuationMode,
    checks: [],
    changedFiles: [],
    evidence: { verification: 'not_run', reviewer: 'not_run' },
    durationMs: goal?.wallClockMs ?? null,
    tokensUsed: goal?.tokensUsed ?? null,
    providerUsage: goal?.providerUsage ?? null,
    tokenBudget: goal?.budget?.tokenBudget ?? null,
    remainingTokens: goal?.budget?.remainingTokens ?? null,
    blockers: outcome.status === 'PASS'
      ? []
      : [{ id: outcome.reasonCode, summary: outcome.summary, nextAction: loopNextAction(outcome.reasonCode) }],
  };
  return { ...result, nextAction: loopSummaryNextAction(result) };
}

export function loopRuntimeErrorSummary(
  goal: GoalSnapshot | null,
  errorMessage: string,
): LoopSummary {
  const message = errorMessage.replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
  const summary = message.length === 0
    ? 'Loop stopped because the provider or runtime failed.'
    : `Loop stopped because the provider or runtime failed: ${message}`;
  const iterations = goal?.iteration ?? 0;
  const result: Omit<LoopSummary, 'nextAction'> = {
    type: 'loop.result',
    schemaVersion: 2,
    status: 'ERROR',
    reasonCode: 'runtime_error',
    summary,
    iterations,
    writerIterations: iterations,
    gateAttempts: goal?.gateAttempts ?? null,
    continuationMode: null,
    checks: [],
    changedFiles: [],
    evidence: { verification: 'not_run', reviewer: 'not_run' },
    durationMs: goal?.wallClockMs ?? null,
    tokensUsed: goal?.tokensUsed ?? null,
    providerUsage: goal?.providerUsage ?? null,
    tokenBudget: goal?.budget?.tokenBudget ?? null,
    remainingTokens: goal?.budget?.remainingTokens ?? null,
    blockers: [{
      id: 'runtime_error',
      summary,
      nextAction: loopNextAction('runtime_error'),
    }],
  };
  return { ...result, nextAction: loopSummaryNextAction(result) };
}

export function formatLoopSummaryText(goal: GoalSnapshot | null): string {
  return formatLoopResultText(loopSummaryJson(goal));
}

export function formatLoopResultText(result: LoopSummary): string {
  const passedChecks = result.checks.filter((check) => (
    typeof check === 'object'
    && check !== null
    && 'status' in check
    && check.status === 'passed'
  )).length;
  const checkSummary = result.evidence.verification === 'not_run'
    ? 'not run'
    : `${String(passedChecks)}/${String(result.checks.length)} passed`;
  const changed = result.changedFiles.length === 0
    ? 'none recorded'
    : `${String(result.changedFiles.length)} file(s): ${result.changedFiles
        .slice(0, 6)
        .map((file) => `${file.status} ${file.path}${formatFileAttribution(file)}`)
        .join(', ')}${result.changedFiles.length > 6 ? ', …' : ''}`;
  const blockerLines = result.blockers.slice(0, 3).flatMap((blocker, index) => [
    `Blocker ${String(index + 1)}  ${blocker.summary}${blocker.file === undefined ? '' : ` (${blocker.file}${blocker.line === undefined ? '' : `:${String(blocker.line)}`})`}`,
    `  Fix      ${blocker.nextAction}`,
  ]);
  if (result.blockers.length > 3) {
    blockerLines.push(`  More     ${String(result.blockers.length - 3)} additional blocker(s); inspect stream-json or \`/loop status\`.`);
  }
  return [
    `Outcome    ${result.status}`,
    `Reason     ${result.summary}`,
    `Writer     ${String(result.writerIterations)} iteration(s)`,
    `Gate       ${result.gateAttempts === null ? 'attempts unavailable' : `${String(result.gateAttempts)} attempt(s)`}`,
    `Time       ${formatDuration(result.durationMs)} · Tokens ${result.tokensUsed === null ? 'unknown' : String(result.tokensUsed)} · Cost unavailable`,
    `Usage      ${formatLoopUsage(result)}`,
    `Workspace  ${changed}`,
    `Checks     ${checkSummary}`,
    `Evidence   ${formatLoopEvidence(result.evidence)}`,
    `Blockers   ${String(result.blockers.length)}`,
    ...blockerLines,
    `Unverified ${formatUnverifiedEvidence(result.evidence)}`,
    `Next       ${result.nextAction}`,
  ].join('\n');
}

function formatLoopEvidence(evidence: LoopSummary['evidence']): string {
  return [
    ...(evidence.completeness === undefined
      ? []
      : [`completeness ${evidence.completeness}`]),
    ...(evidence.fresh === undefined ? [] : [`fresh ${evidence.fresh ? 'yes' : 'no'}`]),
    `verification ${evidence.verification}`,
    `reviewer ${evidence.reviewer}`,
    ...((evidence.missingProducers?.length ?? 0) === 0
      ? []
      : [`missing ${evidence.missingProducers!.join(', ')}`]),
  ].join('; ');
}

function formatUnverifiedEvidence(evidence: LoopSummary['evidence']): string {
  if ((evidence.missingProducers?.length ?? 0) > 0) {
    return `Missing Gate producers: ${evidence.missingProducers!.join(', ')}.`;
  }
  return evidence.verification === 'not_run'
    ? 'No verification evidence was recorded.'
    : 'Nothing beyond the recorded checks and reviewer evidence.';
}

function formatFileAttribution(file: LoopSummary['changedFiles'][number]): string {
  if (file.attribution === 'introduced_by_loop') return ' [introduced by Loop]';
  if (file.attribution === 'modified_by_loop') {
    return file.preExisting === true
      ? ' [pre-existing; modified by Loop]'
      : ' [modified by Loop]';
  }
  if (file.attribution === 'deleted_by_loop') {
    return file.preExisting === true
      ? ' [pre-existing; deleted by Loop]'
      : ' [deleted by Loop]';
  }
  if (file.attribution === 'pre_existing_or_modified') {
    return file.preExisting === true
      ? ' [pre-existing; Loop touch unknown]'
      : ' [pre-existing or modified]';
  }
  return ' [attribution unavailable]';
}

function formatLoopUsage(
  result: Pick<LoopSummary, 'providerUsage' | 'tokensUsed' | 'tokenBudget' | 'remainingTokens'>,
): string {
  const usage = result.providerUsage;
  const writer = usage === undefined || usage === null
    ? 'unknown'
    : formatCallBudget(
        usage.writerCalls,
        usage.writerCallLimit,
        usage.remainingWriterCalls,
      );
  const reviewer = usage === undefined || usage === null
    ? 'unknown'
    : formatCallBudget(
        usage.reviewerCalls,
        usage.reviewerCallLimit,
        usage.remainingReviewerCalls,
      );
  const retries = usage === undefined || usage === null
    ? 'unknown'
    : String((usage.writerRetries ?? 0) + (usage.reviewerRetries ?? 0));
  const tokens = result.tokensUsed === null
    ? 'unknown'
    : `${String(result.tokensUsed)}${result.tokenBudget === null
      ? ' (uncapped)'
      : `/${String(result.tokenBudget)} (${String(result.remainingTokens ?? 0)} remaining)`}`;
  return `Writer calls ${writer} · Reviewer calls ${reviewer} · Retries ${retries} · Tokens ${tokens}`;
}

function formatCallBudget(used: number, limit: number | null, remaining: number | null): string {
  return limit === null
    ? `${String(used)} (uncapped)`
    : `${String(used)}/${String(limit)} (${String(remaining ?? 0)} remaining)`;
}

function loopSummaryNextAction(
  result: Pick<LoopSummary, 'status' | 'reasonCode' | 'continuationMode' | 'blockers'>,
): string {
  if (result.status === 'PASS') {
    return 'Review `git diff`, then explicitly keep or revert the workspace changes.';
  }
  if (result.reasonCode === 'provider_outcome_unknown') {
    return loopNextAction(result.reasonCode);
  }
  switch (result.continuationMode) {
    case 'same-contract':
      return 'Address every blocker above, then run `/loop resume` under the same frozen Finish Line.';
    case 'restore-or-revise':
      return 'Restore the approved workspace/contract and retry, or start `/loop revise` with explicit approval.';
    case 'revised-loop':
      return 'Start `/loop revise` and explicitly approve the new Finish Line and Gate.';
    case 'blocked':
      return 'This run cannot resume; inspect the blockers, then cancel it or start an explicitly revised/new Loop.';
    case null:
      return result.blockers[0]?.nextAction ?? loopNextAction(result.reasonCode);
  }
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return 'unknown';
  if (durationMs < 1000) return `${String(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
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
