/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked` / `paused`) or keeps going
 * (`active`).
 *
 * When the goal carries a deterministic `stopCondition` (`verify-pass`,
 * `scan-clean`, `judge-pass`), a `complete` request runs that gate first. If the
 * gate fails, the goal stays active and a system reminder injects the failure
 * feedback so the model continues rather than self-declaring completion.
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal. The tool is only offered to the model while a goal exists (see the
 * `loopTools` filter in the tool manager).
 */

import { runJudge, runScan, runVerification } from '@wukong/verification';
import type { Agent } from '#/agent';
import { z } from 'zod';

import type { GoalStopCondition } from '../../../agent/goal';
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
      execute: async () => {
        if (args.status === 'active') {
          await goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (args.status === 'complete') {
          const current = goal.getGoal().goal;
          const stopCondition = current?.stopCondition;
          if (stopCondition !== undefined) {
            const iterated = await goal.incrementIteration();
            if (iterated !== null && iterated.maxIterations !== undefined && iterated.iteration > iterated.maxIterations) {
              const blocked = await goal.markBlocked(
                { reason: 'max-iterations' },
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
            const gate = await runGoalGate(stopCondition, this.agent.config.cwd);
            if (!gate.passed) {
              this.agent.context.appendSystemReminder(
                `Goal verification gate failed: ${gate.reason} The goal remains active. Address the failures before marking complete.`,
                { kind: 'system_trigger', name: 'goal_gate_failed' },
              );
              return {
                output: `Goal gate failed: ${gate.reason} Continuing goal.`,
                stopTurn: false,
              };
            }
          }
          const completed = await goal.markComplete({}, 'model');
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
}

async function runGoalGate(stopCondition: GoalStopCondition, cwd: string): Promise<GateResult> {
  switch (stopCondition) {
    case 'verify-pass': {
      const result = await runVerification({ cwd, writeReport: false });
      return result.status === 'failed'
        ? { passed: false, reason: 'verification did not pass.' }
        : { passed: true, reason: 'verification passed.' };
    }
    case 'scan-clean': {
      const result = await runScan({ cwd, writeReport: false });
      return result.status === 'failed'
        ? { passed: false, reason: 'risk scan is not clean.' }
        : { passed: true, reason: 'risk scan is clean.' };
    }
    case 'judge-pass': {
      const result = await runJudge({ cwd });
      return result.verdict === 'block'
        ? { passed: false, reason: `judge returned ${result.verdict}: ${result.reason}` }
        : { passed: true, reason: 'judge passed.' };
    }
  }
}
