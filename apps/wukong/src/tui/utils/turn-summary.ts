export interface OrdinaryTurnProviderOutcomeUnknown {
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface OrdinaryTurnSummaryInput {
  readonly outcome: 'COMPLETED' | 'ERROR' | 'STOPPED_BY_USER';
  readonly reason: string;
  readonly steps: number;
  readonly tools: number;
  readonly failedTools: number;
  readonly durationMs?: number;
  readonly tokens?: number;
  readonly sessionId: string;
  readonly providerOutcomeUnknown?: OrdinaryTurnProviderOutcomeUnknown;
}

/**
 * Deterministic end-of-turn facts for an ordinary TUI prompt. This deliberately
 * does not infer verification from model text or tool names: only a Goal/Loop
 * Gate can produce a durable delivery verdict.
 */
export function buildOrdinaryTurnSummary(input: OrdinaryTurnSummaryInput): string {
  const unknown = input.providerOutcomeUnknown;
  return [
    `Outcome    ${input.outcome}`,
    `Reason     ${input.reason}`,
    `Activity   ${String(input.steps)} step(s) · ${String(input.tools)} tool(s) · ${String(input.failedTools)} failed`,
    `Time       ${input.durationMs === undefined ? 'unknown' : formatElapsed(input.durationMs)} · Tokens ${input.tokens === undefined ? 'unknown' : String(input.tokens)}`,
    'Workspace  not attributed in TUI; inspect `git status --short` and `git diff`',
    'Checks     no durable Goal/Loop verdict',
    'Evidence   model completion is not verification',
    ...(unknown === undefined ? [] : [
      `Provider   UNKNOWN · request ${unknown.requestId}`,
      `Idempotency ${unknown.idempotencyKey}`,
    ]),
    `Session    ${input.sessionId}`,
    `Next       ${unknown === undefined
      ? 'Review the response and workspace diff; run relevant checks; use `/loop` when a trusted Gate is needed; then explicitly keep or revert changes.'
      : 'Check provider logs or billing first; do not resume or retry blindly; then explicitly keep or revert workspace changes.'}`,
  ].join('\n');
}

export function providerOutcomeUnknownFromTurnDetails(
  details: Record<string, unknown> | undefined,
): OrdinaryTurnProviderOutcomeUnknown | undefined {
  const candidate = details?.['providerOutcomeUnknown'];
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const requestId = Reflect.get(candidate, 'requestId');
  const idempotencyKey = Reflect.get(candidate, 'idempotencyKey');
  if (typeof requestId !== 'string' || typeof idempotencyKey !== 'string') return undefined;
  return { requestId, idempotencyKey };
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
}
