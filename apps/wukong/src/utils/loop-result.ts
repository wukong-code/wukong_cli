import type { GoalSnapshot } from '@wukong/wukong-sdk';

export type LoopStatus = 'PASS' | 'NEEDS_WORK' | 'ERROR';

export interface LoopTerminalOutcome {
  readonly status: LoopStatus;
  readonly reasonCode: string;
  readonly summary: string;
}

export function durableLoopResultFromGoal(
  goal: GoalSnapshot | null,
): GoalSnapshot['loopResult'] | undefined {
  if (goal === null) return undefined;
  const result = goal.loopResult;
  const terminal = goal.loopTerminal;
  if (
    result === undefined
    || terminal === undefined
    || terminal.runId !== goal.loopRunId
    || terminal.status !== result.status
    || terminal.reasonCode !== result.reasonCode
  ) return undefined;
  if (result.status === 'PASS') return goal.status === 'complete' ? result : undefined;
  return goal.status === 'blocked' ? result : undefined;
}

export function loopOutcomeFromGoal(goal: GoalSnapshot | null): LoopTerminalOutcome {
  if (goal === null) {
    return { status: 'ERROR', reasonCode: 'result_missing', summary: 'Loop ended without a final result.' };
  }
  if (goal.providerOutcomeUnknown !== undefined) {
    return {
      status: 'ERROR',
      reasonCode: 'provider_outcome_unknown',
      summary: `Provider request ${goal.providerOutcomeUnknown.requestId} has an unknown outcome; blind retry is disabled (idempotency key ${goal.providerOutcomeUnknown.idempotencyKey}).`,
    };
  }
  const terminal = goal.loopTerminal?.runId === goal.loopRunId
    ? goal.loopTerminal
    : undefined;
  if (goal.loopResult !== undefined) {
    const result = durableLoopResultFromGoal(goal);
    if (result === undefined) {
      return {
        status: 'ERROR',
        reasonCode: 'result_missing',
        summary: 'Loop result is not bound to the durable terminal for the current run.',
      };
    }
    return {
      status: result.status,
      reasonCode: result.reasonCode,
      summary: result.summary,
    };
  }
  const encoded = parseLoopTerminalReason(goal.terminalReason);
  if (
    encoded !== null
    && terminal?.status === encoded.status
    && terminal.reasonCode === encoded.reasonCode
    && (encoded.status === 'PASS' ? goal.status === 'complete' : goal.status === 'blocked')
  ) return encoded;
  if (goal.status === 'complete') {
    return {
      status: 'ERROR',
      reasonCode: 'result_missing',
      summary: 'Loop reported completion without a durable Gate result.',
    };
  }
  if (goal.status === 'paused') {
    return { status: 'ERROR', reasonCode: 'interrupted', summary: goal.terminalReason ?? 'Loop was interrupted.' };
  }
  return {
    status: 'NEEDS_WORK',
    reasonCode: 'external_blocker',
    summary: goal.terminalReason ?? 'Loop stopped before the delivery gate passed.',
  };
}

export function parseLoopTerminalReason(value: string | undefined): LoopTerminalOutcome | null {
  if (value === undefined) return null;
  const match = value.match(/^loop:(PASS|NEEDS_WORK|ERROR):([^:]+):(.*)$/s);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return {
    status: match[1] as LoopStatus,
    reasonCode: match[2],
    summary: match[3] || match[2],
  };
}

export function loopNextAction(reasonCode: string): string {
  switch (reasonCode) {
    case 'max_iterations':
      return 'Review the remaining blocker and start a new Loop with a narrower goal.';
    case 'workspace_changed':
      return 'Stop other workspace writers, then rerun the Loop.';
    case 'reviewer_limit_exceeded':
      return 'Retry the Gate with the same contract; if the limit repeats, narrow the review scope or choose a faster reviewer model.';
    case 'reviewer_error':
    case 'reviewer_invalid_output':
    case 'reviewer_unavailable':
    case 'verification_error':
      return 'Resolve the model or verification runtime error, then rerun the Loop.';
    case 'runtime_error':
      return 'Resolve the provider or runtime error, then resume or rerun the Loop.';
    case 'provider_outcome_unknown':
      return 'Check provider logs or billing with the request id and idempotency key; then cancel and start a new Loop only if a new request is safe.';
    case 'permission_required':
    case 'permission_denied':
      return 'Switch to Manual, run `/loop resume`, and approve the exact action; use YOLO only after explicitly accepting the risk, or revise the goal.';
    default:
      return 'Resolve the blocker and rerun the Loop.';
  }
}
