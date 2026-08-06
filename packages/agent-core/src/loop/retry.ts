import { sleep } from '@antfu/utils';
import * as retry from 'retry';
import { randomUUID } from 'node:crypto';

import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5000;
const RETRY_FACTOR = 2;

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  readonly log?: Logger | undefined;
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = Math.max(input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1);
  const delays = retryBackoffDelays(maxAttempts);
  const idempotencyKey = input.params.idempotencyKey ?? `wukong-${input.stepUuid}`;

  for (let attempt = 1; ; attempt += 1) {
    input.params.signal.throwIfAborted();
    const requestId = randomUUID();
    let outputObserved = false;
    await input.dispatchEvent({
      type: 'provider.request',
      requestId,
      idempotencyKey,
      turnId: input.turnId,
      step: input.currentStep,
      stepUuid: input.stepUuid,
      attempt,
      maxAttempts,
      state: 'started',
    });
    try {
      const response = await input.llm.chat(paramsForAttempt(
        input,
        attempt,
        maxAttempts,
        idempotencyKey,
        () => { outputObserved = true; },
      ));
      await input.dispatchEvent({
        type: 'provider.request',
        requestId,
        idempotencyKey,
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        attempt,
        maxAttempts,
        state: 'succeeded',
        outputObserved,
      });
      return response;
    } catch (error) {
      const fields = retryErrorFields(error);
      const retryable = input.llm.isRetryableError?.(error) === true;
      const outcomeUnknown = outputObserved || fields.statusCode === undefined;
      await input.dispatchEvent({
        type: 'provider.request',
        requestId,
        idempotencyKey,
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        attempt,
        maxAttempts,
        state: outcomeUnknown ? 'outcome_unknown' : 'failed',
        outputObserved,
        ...fields,
      });
      if (
        attempt >= maxAttempts
        || input.llm.isRetryableError === undefined
        || !retryable
        || outcomeUnknown
      ) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      const delayMs = delays[attempt - 1] ?? 0;
      input.params.signal.throwIfAborted();
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      });
      await sleepForRetry(delayMs, input.params.signal);
    }
  }
}

function logRequestFailure(
  input: ChatWithRetryInput,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
  idempotencyKey: string,
  markOutputObserved: () => void,
): LLMChatParams {
  const turnStep = `${input.turnId}.${String(input.currentStep)}`;
  return {
    ...input.params,
    idempotencyKey,
    onTextDelta: wrapObserved(input.params.onTextDelta, markOutputObserved),
    onThinkDelta: wrapObserved(input.params.onThinkDelta, markOutputObserved),
    onToolCallDelta: wrapObserved(input.params.onToolCallDelta, markOutputObserved),
    onTextPart: wrapObservedAsync(input.params.onTextPart, markOutputObserved),
    onThinkPart: wrapObservedAsync(input.params.onThinkPart, markOutputObserved),
    requestLogFields:
      attempt === 1
        ? { turnStep }
        : { turnStep, attempt: `${String(attempt)}/${String(maxAttempts)}` },
  };
}

function wrapObserved<T>(
  callback: ((value: T) => void) | undefined,
  mark: () => void,
): ((value: T) => void) | undefined {
  if (callback === undefined) return undefined;
  return (value) => {
    mark();
    callback(value);
  };
}

function wrapObservedAsync<T>(
  callback: ((value: T) => Promise<void> | void) | undefined,
  mark: () => void,
): ((value: T) => Promise<void>) | undefined {
  if (callback === undefined) return undefined;
  return async (value) => {
    mark();
    await callback(value);
  };
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  return retry.timeouts({
    retries: Math.max(maxAttempts - 1, 0),
    minTimeout: RETRY_MIN_TIMEOUT_MS,
    maxTimeout: RETRY_MAX_TIMEOUT_MS,
    factor: RETRY_FACTOR,
    randomize: true,
  });
}

export async function sleepForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await abortable(sleep(delayMs), signal);
}

interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
