/**
 * Loop-local error helpers.
 */

import { ErrorCodes, WukongError, isWukongError } from '#/errors';

export function createMaxStepsExceededError(maxSteps: number, message?: string): WukongError {
  return new WukongError(
    ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
    message ??
      `Turn exceeded maxSteps=${maxSteps}. For a user turn, raise loop_control.max_steps_per_turn or split the task. For a bounded internal workflow, follow the parent result's recovery guidance.`,
    {
      details: { maxSteps },
    },
  );
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return isWukongError(error) && error.code === ErrorCodes.LOOP_MAX_STEPS_EXCEEDED;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
