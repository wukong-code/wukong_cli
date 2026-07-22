import { randomUUID } from 'node:crypto';

import {
  bindTrackedLoopGoal,
  findTrackedLoopByGoalId,
  hasPriorCompletedLoopWithin7d,
  recordTrackedLoopStart,
  stageLoopTerminal,
  type LoopRunLifecycle,
  type LoopRunRecord,
} from '#/cli/lib/loop-run-store';
import type { LoopStatus } from '#/utils/loop-result';

export interface LocalLoopRun {
  readonly runId: string;
  readonly repeatedWithin7d?: boolean;
}

export interface LoopCompletionResult {
  readonly repeatedCompletedWithin7d: boolean;
}

const activeTuiLoops = new Map<string, LocalLoopRun>();

/**
 * Start a local lifecycle record used only for crash recovery and opt-out-aware
 * telemetry aggregation. This never contacts Wukong services and never gates a
 * BYOK Loop.
 */
export async function beginLoopRun(): Promise<LocalLoopRun> {
  const runId = randomUUID().replaceAll('-', '');
  const repeatedWithin7d = await recordTrackedLoopStart(runId).catch(() => false);
  return repeatedWithin7d ? { runId, repeatedWithin7d: true } : { runId };
}

export async function completeLoopRun(
  run: LocalLoopRun,
  outcome: LoopStatus,
  iterations: number,
  lifecycle: LoopRunLifecycle = 'completed',
): Promise<LoopCompletionResult> {
  const repeatedCompletedWithin7d = lifecycle === 'completed'
    && (outcome === 'PASS' || outcome === 'NEEDS_WORK')
    && await hasPriorCompletedLoopWithin7d(run.runId).catch(() => false);
  await stageLoopTerminal(run.runId, lifecycle, outcome, iterations).catch(() => {});
  return { repeatedCompletedWithin7d };
}

export async function registerTuiLoop(
  goalId: string,
  run: LocalLoopRun,
  sessionId?: string,
  workspace?: string,
): Promise<void> {
  activeTuiLoops.set(goalId, run);
  await bindTrackedLoopGoal(run.runId, goalId, sessionId, workspace).catch(() => {});
}

export async function cancelLoopRecord(
  record: LoopRunRecord,
  iterations: number = 0,
): Promise<void> {
  await completeLoopRun({ runId: record.runId }, 'ERROR', iterations, 'cancelled');
}

export async function completeTuiLoop(
  goalId: string,
  outcome: LoopStatus,
  iterations: number,
  lifecycle: LoopRunLifecycle = 'completed',
): Promise<LoopCompletionResult> {
  let run = activeTuiLoops.get(goalId);
  if (run === undefined) {
    const record = await findTrackedLoopByGoalId(goalId);
    if (record !== undefined) run = { runId: record.runId };
  }
  if (run === undefined) return { repeatedCompletedWithin7d: false };
  activeTuiLoops.delete(goalId);
  return completeLoopRun(run, outcome, iterations, lifecycle);
}
