/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked` / `paused`) or keeps going
 * (`active`).
 *
 * When the goal carries a delivery `stopCondition` (`proof-pass`; legacy
 * conditions normalize to it), a `complete` request runs that gate first. If the
 * gate fails, the goal stays active and a system reminder injects the failure
 * feedback so the model continues rather than self-declaring completion.
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal. The tool is only offered to the model while a goal exists (see the
 * `loopTools` filter in the tool manager).
 */

import { createWorkspaceSnapshot, runJudge, runProof, runScan, runVerification } from '@wukong/verification';
import type { ProofBlocker, ProofResult } from '@wukong/verification';
import type { Agent } from '#/agent';
import { z } from 'zod';

import type { GoalStopCondition, LoopResult } from '../../../agent/goal';
import type { CronManager } from '../../../agent/cron/manager';
import {
  GOAL_BLOCKED_REMINDER_NAME,
  GOAL_COMPLETION_REMINDER_NAME,
} from '../../../agent/turn';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from './outcome-prompts';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'paused', 'blocked'])
      .describe('The lifecycle status to set for the current goal.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

const ReviewerVerdictSchema = z.object({
  status: z.enum(['PASS', 'NEEDS_WORK']),
  summary: z.string().min(1).max(1000),
  file: z.string().min(1).max(1000).optional(),
  line: z.number().int().positive().optional(),
  nextAction: z.string().min(1).max(1000).optional(),
}).strict();

const MAX_GATE_FEEDBACK_LENGTH = 6000;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    const goal = this.agent.goal;

    return {
      description: `Setting goal status: ${args.status}`,
      stopBatchAfterThis: args.status !== 'active',
      approvalRule: this.name,
      execute: async (context) => {
        if (args.status === 'active') {
          await goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (args.status === 'complete') {
          const current = goal.getGoal().goal;
          const stopCondition = current?.stopCondition;
          let completionReason: string | undefined;
          if (current !== null && stopCondition !== undefined) {
            const iterated = await goal.incrementIteration();
            if (iterated !== null && iterated.maxIterations !== undefined && iterated.iteration > iterated.maxIterations) {
              goal.recordLoopResult({
                schemaVersion: 2,
                status: 'NEEDS_WORK',
                reasonCode: 'max_iterations',
                summary: 'Maximum Loop iterations reached.',
                checks: [],
                blockers: [],
              });
              const blocked = await goal.markBlocked(
                { reason: loopTerminalReason('NEEDS_WORK', 'max_iterations', 'Maximum Loop iterations reached.') },
                'system',
              );
              if (blocked !== null) {
                this.agent.context.appendSystemReminder(
                  `Loop reached the maximum iteration limit (${String(iterated.maxIterations)}). The goal is blocked.`,
                  { kind: 'system_trigger', name: 'goal_max_iterations' },
                );
              }
              return { output: 'Maximum iterations reached.', stopTurn: true };
            }
            let gate: GateResult;
            try {
              gate = await runGoalGate(
                stopCondition,
                this.agent,
                current.objective,
                context.toolCallId,
                context.signal,
              );
            } catch (error) {
              gate = {
                passed: false,
                terminal: true,
                reasonCode: errorCode(error, 'verification_error'),
                reason: `delivery gate failed to run: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            if (!gate.passed) {
              if (gate.terminal === true) {
                goal.recordLoopResult(loopResultFromGate('ERROR', gate));
                await goal.markBlocked({
                  reason: loopTerminalReason('ERROR', gate.reasonCode ?? 'verification_error', gate.reason),
                }, 'system');
                this.agent.context.appendSystemReminder(
                  `Loop stopped because the delivery gate could not complete: ${gate.reason}`,
                  { kind: 'system_trigger', name: 'goal_gate_error' },
                );
                return { output: `Goal gate error: ${gate.reason}`, stopTurn: true };
              }
              if (
                iterated !== null
                && iterated.maxIterations !== undefined
                && iterated.iteration >= iterated.maxIterations
              ) {
                const maxResult: GateResult = {
                  ...gate,
                  reasonCode: 'max_iterations',
                  reason: `Maximum Loop iterations reached. Last blocker: ${gate.reason}`,
                };
                goal.recordLoopResult(loopResultFromGate('NEEDS_WORK', maxResult));
                await goal.markBlocked({
                  reason: loopTerminalReason('NEEDS_WORK', 'max_iterations', maxResult.reason),
                }, 'system');
                this.agent.context.appendSystemReminder(
                  `Loop reached the maximum iteration limit (${String(iterated.maxIterations)}).`,
                  { kind: 'system_trigger', name: 'goal_max_iterations' },
                );
                return { output: 'Maximum iterations reached.', stopTurn: true };
              }
              goal.recordLoopResult(loopResultFromGate('NEEDS_WORK', gate));
              const feedback = buildGateFeedback(gate);
              this.agent.context.appendSystemReminder(
                `Loop delivery gate returned NEEDS_WORK. Address the structured blockers before marking complete again.\n${feedback}`,
                { kind: 'system_trigger', name: 'goal_gate_failed' },
              );
              const scheduled = current !== null && scheduleLoopRetry(this.agent, current, gate.reason);
              if (scheduled) {
                return {
                  output: `Goal gate failed: ${gate.reason} A retry is scheduled after the configured interval.`,
                  stopTurn: true,
                };
              }
              return {
                output: `Goal gate needs work: ${gate.reason} Continuing goal.`,
                stopTurn: false,
              };
            }
            goal.recordLoopResult(loopResultFromGate('PASS', gate));
            completionReason = loopTerminalReason('PASS', gate.reasonCode ?? 'passed', gate.reason);
          }
          const completed = await goal.markComplete({ reason: completionReason }, 'model');
          // `complete` is transient: markComplete announces then clears the
          // record. Store the summary request as a system reminder, so the next
          // provider request ends with a user message after the UpdateGoal tool
          // result. Anthropic-compatible providers reject trailing assistant
          // messages as unsupported prefill.
          if (completed !== null) {
            this.agent.context.appendSystemReminder(buildGoalCompletionSummaryPrompt(completed), {
              kind: 'system_trigger',
              name: GOAL_COMPLETION_REMINDER_NAME,
            });
          }
          return { output: 'Goal marked complete.', stopTurn: true };
        }
        if (args.status === 'blocked') {
          const blocked = await goal.markBlocked({}, 'model');
          if (blocked !== null) {
            this.agent.context.appendSystemReminder(buildGoalBlockedReasonPrompt(blocked), {
              kind: 'system_trigger',
              name: GOAL_BLOCKED_REMINDER_NAME,
            });
          }
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        await goal.pauseGoal({}, 'model');
        return { output: 'Goal paused.', stopTurn: true };
      },
    };
  }
}

interface GateResult {
  readonly passed: boolean;
  readonly reason: string;
  readonly reasonCode?: string;
  readonly blockers?: readonly ProofBlocker[];
  readonly checks?: LoopResult['checks'];
  readonly terminal?: boolean;
}

async function runGoalGate(
  stopCondition: GoalStopCondition,
  agent: Agent,
  objective: string,
  parentToolCallId: string,
  signal: AbortSignal,
): Promise<GateResult> {
  const cwd = agent.config.cwd;
  switch (stopCondition) {
    case 'proof-pass': {
      const proof = await runProof({ cwd, writeReport: false });
      if (proof.status === 'blocked') {
        return {
          passed: false,
          reason: proof.recommendation,
          reasonCode: proof.reasonCode,
          blockers: proof.blockers,
          checks: proofChecks(proof),
        };
      }
      return runFreshReviewer(agent, objective, proof, parentToolCallId, signal);
    }
    case 'verify-pass': {
      const result = await runVerification({ cwd, writeReport: false });
      return result.status === 'failed'
        ? { passed: false, reasonCode: 'verification_failed', reason: 'verification did not pass.' }
        : { passed: true, reasonCode: 'passed', reason: 'verification passed.' };
    }
    case 'scan-clean': {
      const result = await runScan({ cwd, writeReport: false });
      return result.status === 'failed'
        ? { passed: false, reasonCode: 'scan_failed', reason: 'risk scan is not clean.' }
        : { passed: true, reasonCode: 'passed', reason: 'risk scan is clean.' };
    }
    case 'judge-pass': {
      const result = await runJudge({ cwd });
      return result.verdict === 'block'
        ? { passed: false, reasonCode: 'judge_blocked', reason: `judge returned ${result.verdict}: ${result.reason}` }
        : { passed: true, reasonCode: 'passed', reason: 'judge passed.' };
    }
  }
}

async function runFreshReviewer(
  agent: Agent,
  objective: string,
  proof: ProofResult,
  parentToolCallId: string,
  signal: AbortSignal,
): Promise<GateResult> {
  const host = agent.subagentHost;
  const checks = proofChecks(proof);
  if (host === undefined) {
    return {
      passed: false,
      terminal: true,
      reasonCode: 'reviewer_unavailable',
      reason: 'fresh reviewer is unavailable in this runtime.',
      checks,
    };
  }

  const failedCommands = proof.verification.commandResults
    .filter((command) => command.status !== 'passed')
    .map((command) => `${command.command} (${command.status})`);
  const risks = [...proof.verification.risks, ...proof.scan.risks]
    .map((risk) => `${risk.severity}: ${risk.message}${risk.file === undefined ? '' : ` (${risk.file})`}`)
    .slice(0, 20);
  const prompt = [
    'Independently review the current workspace as the final Wukong Loop delivery gate.',
    `Objective: ${objective}`,
    `Deterministic proof: ${proof.status}`,
    `Checks: ${proof.verification.selectedCommands.join(', ') || 'none discovered'}`,
    `Failed checks: ${failedCommands.join(', ') || 'none'}`,
    `Changed files: ${proof.verification.changedFiles.map((file) => file.path).join(', ') || 'none'}`,
    `Risks: ${risks.join('; ') || 'none'}`,
    'Inspect the changed code and decide whether the objective is correctly and completely delivered. Do not modify anything.',
    'End with exactly one line in this format:',
    'VERDICT_JSON: {"status":"PASS|NEEDS_WORK","summary":"specific evidence-based summary","file":"optional/path","line":1,"nextAction":"required for NEEDS_WORK"}',
  ].join('\n');

  let lastError = 'fresh reviewer returned no valid verdict.';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await host.spawn({
        profileName: 'reviewer',
        parentToolCallId,
        prompt,
        description: 'Review Loop delivery gate',
        runInBackground: false,
        signal,
      });
      const completion = await handle.completion;
      const verdict = parseReviewerVerdict(completion.result);
      if (verdict === null) {
        lastError = 'fresh reviewer returned no valid structured verdict.';
        continue;
      }
      if (!await proofWorkspaceStillCurrent(agent.config.cwd, proof)) {
        return {
          passed: false,
          terminal: true,
          reasonCode: 'workspace_changed',
          reason: 'workspace changed after deterministic checks; reviewer verdict was discarded.',
          checks,
        };
      }
      if (verdict.status === 'PASS') {
        return { passed: true, reasonCode: 'passed', reason: verdict.summary, checks };
      }
      const blocker: ProofBlocker = {
        id: 'reviewer_needs_work',
        kind: 'review',
        summary: verdict.summary,
        file: verdict.file,
        line: verdict.line,
        nextAction: verdict.nextAction ?? 'Address the reviewer finding and rerun the Loop gate.',
      };
      return {
        passed: false,
        reasonCode: blocker.id,
        reason: verdict.summary,
        blockers: [blocker],
        checks,
      };
    } catch (error) {
      lastError = `fresh reviewer failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { passed: false, terminal: true, reasonCode: 'reviewer_error', reason: lastError, checks };
}

function proofChecks(proof: ProofResult): LoopResult['checks'] {
  return proof.verification.commandResults.map((result) => ({
    command: result.command,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  }));
}

function loopResultFromGate(
  status: LoopResult['status'],
  gate: GateResult,
): Omit<LoopResult, 'iterations'> {
  return {
    schemaVersion: 2,
    status,
    reasonCode: gate.reasonCode ?? (status === 'PASS' ? 'passed' : 'verification_error'),
    summary: gate.reason,
    checks: gate.checks ?? [],
    blockers: gate.blockers ?? [],
  };
}

function parseReviewerVerdict(value: string): z.infer<typeof ReviewerVerdictSchema> | null {
  const match = value.trim().match(/VERDICT_JSON:\s*(\{[^\n]+\})\s*$/);
  if (match?.[1] === undefined) return null;
  try {
    return ReviewerVerdictSchema.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

async function proofWorkspaceStillCurrent(cwd: string, proof: ProofResult): Promise<boolean> {
  const current = await createWorkspaceSnapshot({ cwd });
  return current.headSha === proof.workspaceFingerprint.headSha
    && current.inputDigest === proof.workspaceFingerprint.inputDigest
    && current.configDigest === proof.workspaceFingerprint.configDigest;
}

function buildGateFeedback(gate: GateResult): string {
  const payload = JSON.stringify({
    status: 'NEEDS_WORK',
    reasonCode: gate.reasonCode ?? 'needs_work',
    summary: gate.reason,
    blockers: gate.blockers ?? [],
  });
  return payload.length <= MAX_GATE_FEEDBACK_LENGTH
    ? payload
    : `${payload.slice(0, MAX_GATE_FEEDBACK_LENGTH - 3)}...`;
}

function loopTerminalReason(status: 'PASS' | 'NEEDS_WORK' | 'ERROR', reasonCode: string, summary: string): string {
  const normalizedSummary = summary.replaceAll(/\s+/g, ' ').trim().slice(0, 1000);
  return `loop:${status}:${reasonCode}:${normalizedSummary}`;
}

function errorCode(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return fallback;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}

/**
 * If the loop is configured with a minimum interval between iterations,
 * schedule a one-shot cron task to re-inject the loop prompt after that
 * interval. This reuses the existing agent-core cron scheduler instead of
 * introducing a second timer.
 *
 * Returns true when a retry was scheduled; false when there is no interval,
 * no cron manager (subagents/tests), or cron is disabled.
 */
function scheduleLoopRetry(agent: Agent, current: { readonly minIntervalMs?: number; readonly iteration: number; readonly maxIterations?: number; readonly objective: string; readonly stopCondition?: string }, reason: string): boolean {
  const minIntervalMs = current.minIntervalMs;
  if (minIntervalMs === undefined || minIntervalMs <= 0) return false;

  const cron: CronManager | null = agent.cron;
  if (cron === null) return false;
  if (process.env['WUKONG_DISABLE_CRON'] === '1') return false;

  const fireAt = cron.clocks.wallNow() + minIntervalMs;
  const date = new Date(fireAt);
  const cronExpr = `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
  const maxText = current.maxIterations !== undefined ? String(current.maxIterations) : 'unlimited';
  const prompt = `Continue the loop toward: ${current.objective} (iteration ${String(current.iteration)}/${maxText}, stop when ${current.stopCondition ?? 'complete'}). The previous attempt did not pass the gate: ${reason}. Make the next attempt and only mark the goal complete when the gate passes.`;

  cron.addTask({ cron: cronExpr, prompt, recurring: false });
  return true;
}
