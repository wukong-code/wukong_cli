import { describe, expect, it } from 'vitest';

import {
  buildOrdinaryTurnSummary,
  providerOutcomeUnknownFromTurnDetails,
} from '#/tui/utils/turn-summary';

describe('ordinary TUI turn summary', () => {
  it('labels model completion as unverified rather than PASS', () => {
    const text = buildOrdinaryTurnSummary({
      outcome: 'COMPLETED',
      reason: 'The model turn completed.',
      steps: 2,
      tools: 1,
      failedTools: 0,
      durationMs: 3_200,
      tokens: 42,
      sessionId: 'ses-1',
    });

    expect(text).toContain('Outcome    COMPLETED');
    expect(text).toContain('Activity   2 step(s) · 1 tool(s) · 0 failed');
    expect(text).toContain('Evidence   model completion is not verification');
    expect(text).toContain('use `/loop` when a trusted Gate is needed');
    expect(text).not.toContain('Outcome    PASS');
    expect(text).not.toMatch(/commit|push/i);
  });

  it('distinguishes user interruption from an error', () => {
    const text = buildOrdinaryTurnSummary({
      outcome: 'STOPPED_BY_USER',
      reason: 'Interrupted.',
      steps: 1,
      tools: 0,
      failedTools: 0,
      sessionId: 'ses-2',
    });
    expect(text).toContain('Outcome    STOPPED_BY_USER');
    expect(text).not.toContain('Outcome    ERROR');
  });

  it('disables blind retry when the provider outcome is unknown', () => {
    const text = buildOrdinaryTurnSummary({
      outcome: 'ERROR',
      reason: 'Connection ended after request write.',
      steps: 1,
      tools: 0,
      failedTools: 0,
      sessionId: 'ses-3',
      providerOutcomeUnknown: {
        requestId: 'req-1',
        idempotencyKey: 'idem-1',
      },
    });
    expect(text).toContain('Provider   UNKNOWN · request req-1');
    expect(text).toContain('Idempotency idem-1');
    expect(text).toContain('do not resume or retry blindly');
    expect(text).not.toMatch(/^Resume/m);
  });

  it('only accepts complete provider outcome identifiers', () => {
    expect(providerOutcomeUnknownFromTurnDetails({
      providerOutcomeUnknown: { requestId: 'req-1', idempotencyKey: 'idem-1' },
    })).toEqual({ requestId: 'req-1', idempotencyKey: 'idem-1' });
    expect(providerOutcomeUnknownFromTurnDetails({
      providerOutcomeUnknown: { requestId: 'req-1' },
    })).toBeUndefined();
  });
});
