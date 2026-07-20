import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { selectVerificationCommands } from '@wukong/verification';
import type { GoalSnapshot } from '@wukong/wukong-sdk';

export interface LoopPreflightReady {
  readonly ready: true;
  readonly model: string;
  readonly workspace: string;
  readonly checks: readonly string[];
}

export interface LoopPreflightBlocked {
  readonly ready: false;
  readonly reason: string;
  readonly next: string;
}

export type LoopPreflightResult = LoopPreflightReady | LoopPreflightBlocked;

export interface LoopPreflightOptions {
  readonly objective: string;
  readonly model: string | undefined;
  readonly workspace: string;
  readonly getActiveGoal: () => Promise<GoalSnapshot | null>;
  readonly discoverChecks?: (workspace: string) => Promise<readonly string[]>;
}

export async function runLoopPreflight(
  options: LoopPreflightOptions,
): Promise<LoopPreflightResult> {
  if (options.objective.trim().length === 0) {
    return {
      ready: false,
      reason: 'Loop objective is empty.',
      next: 'Run /loop <goal> with a concrete finish line.',
    };
  }

  const model = options.model?.trim();
  if (!model) {
    return {
      ready: false,
      reason: 'No model is configured.',
      next: 'Run /provider or /model, then start the Loop again.',
    };
  }

  try {
    const workspaceStat = await stat(options.workspace);
    if (!workspaceStat.isDirectory()) {
      return {
        ready: false,
        reason: 'The workspace is not a directory.',
        next: 'Change to a readable project directory, then start the Loop again.',
      };
    }
    await access(options.workspace, constants.R_OK);
  } catch {
    return {
      ready: false,
      reason: 'The workspace is not readable.',
      next: 'Fix the workspace path or permissions, then start the Loop again.',
    };
  }

  try {
    const activeGoal = await options.getActiveGoal();
    if (activeGoal !== null) {
      return {
        ready: false,
        reason: 'Another Goal is already active.',
        next: 'Resume or cancel the active Goal before starting a new Loop.',
      };
    }
  } catch {
    return {
      ready: false,
      reason: 'The active Goal state could not be read.',
      next: 'Run /goal status or wukong doctor, then retry.',
    };
  }

  try {
    const checks = options.discoverChecks === undefined
      ? (await selectVerificationCommands({ cwd: options.workspace })).map((entry) => entry.command)
      : await options.discoverChecks(options.workspace);
    return { ready: true, model, workspace: options.workspace, checks };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ready: false,
      reason: `Project checks could not be discovered: ${detail}`,
      next: 'Fix .wukong/checks.json or the project manifest, then retry.',
    };
  }
}

export function formatLoopPreflightBlocked(result: LoopPreflightBlocked): string {
  return `Loop not started\nReason   ${result.reason}\nNext     ${result.next}`;
}

export function formatLoopPreflightReady(
  result: LoopPreflightReady,
  maxIterations: number,
): string {
  const checks = result.checks.length === 0 ? 'No project checks configured' : result.checks.join(', ');
  return [
    'Ready to start Loop',
    `Model    ${result.model}`,
    `Checks   ${checks}`,
    `Limit    up to ${String(maxIterations)} iterations`,
  ].join('\n');
}
