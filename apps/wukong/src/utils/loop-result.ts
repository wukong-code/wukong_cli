import type { GoalSnapshot } from '@wukong/wukong-sdk';

export type LoopStatus = 'PASS' | 'NEEDS_WORK' | 'ERROR';

export interface LoopTerminalOutcome {
  readonly status: LoopStatus;
  readonly reasonCode: string;
  readonly summary: string;
}

export function loopOutcomeFromGoal(goal: GoalSnapshot | null): LoopTerminalOutcome {
  if (goal === null) {
    return { status: 'ERROR', reasonCode: 'result_missing', summary: 'Loop ended without a final result.' };
  }
  const encoded = parseLoopTerminalReason(goal.terminalReason);
  if (encoded !== null) return encoded;
  if (goal.status === 'complete') {
    return { status: 'PASS', reasonCode: 'passed', summary: 'Delivery gate passed.' };
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
    case 'reviewer_error':
    case 'reviewer_unavailable':
    case 'verification_error':
      return 'Resolve the model or verification runtime error, then rerun the Loop.';
    default:
      return 'Resolve the blocker and rerun the Loop.';
  }
}
