import { randomUUID } from 'node:crypto';

import {
  bindTrackedLoopGoal,
  findTrackedLoopByGoalId,
  hasPriorCompletedLoopWithin7d,
  recordTrackedLoopStart,
  stageLoopTerminal,
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
 * Start a local UI/lifecycle index for the authoritative core Loop run id.
 * Durable contract, attempt, evidence, and terminal truth lives in the agent
 * record log; this convenience index never gates a BYOK Loop.
 */
export async function beginLoopRun(authoritativeRunId?: string): Promise<LocalLoopRun> {
  const runId = authoritativeRunId ?? randomUUID().replaceAll('-', '');
  const repeatedWithin7d = await recordTrackedLoopStart(runId).catch(() => false);
  return repeatedWithin7d ? { runId, repeatedWithin7d: true } : { runId };
}

export async function completeLoopRun(
  run: LocalLoopRun,
  outcome: LoopStatus,
  iterations: number,
): Promise<LoopCompletionResult> {
  const repeatedCompletedWithin7d = (outcome === 'PASS' || outcome === 'NEEDS_WORK')
    && await hasPriorCompletedLoopWithin7d(run.runId).catch(() => false);
  await stageLoopTerminal(run.runId, { status: 'completed', outcome, iterations }).catch(() => {});
  return { repeatedCompletedWithin7d };
}

export async function stopLoopRun(
  run: LocalLoopRun,
  iterations: number,
): Promise<void> {
  await stageLoopTerminal(run.runId, { status: 'cancelled', iterations }).catch(() => {});
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
  await stopLoopRun({ runId: record.runId }, iterations);
}

export async function completeTuiLoop(
  goalId: string,
  outcome: LoopStatus,
  iterations: number,
): Promise<LoopCompletionResult> {
  let run = activeTuiLoops.get(goalId);
  if (run === undefined) {
    const record = await findTrackedLoopByGoalId(goalId);
    if (record !== undefined) run = { runId: record.runId };
  }
  if (run === undefined) return { repeatedCompletedWithin7d: false };
  activeTuiLoops.delete(goalId);
  return completeLoopRun(run, outcome, iterations);
}

export async function stopTuiLoop(goalId: string, iterations: number): Promise<void> {
  let run = activeTuiLoops.get(goalId);
  if (run === undefined) {
    const record = await findTrackedLoopByGoalId(goalId);
    if (record !== undefined) run = { runId: record.runId };
  }
  if (run === undefined) return;
  activeTuiLoops.delete(goalId);
  await stopLoopRun(run, iterations);
}
