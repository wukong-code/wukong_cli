import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchSubmitFeedback,
  wukongFeedbackUrl,
  type SubmitFeedbackBody,
} from '../src/managed-feedback';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SAMPLE_BODY: SubmitFeedbackBody = {
  message: 'great tool',
  category: 'other',
  version: '0.0.18',
  platform: 'darwin',
  arch: 'arm64',
  contact: 'test@example.com',
};

describe('wukongFeedbackUrl', () => {
  it('appends /feedback to the default base URL', () => {
    expect(wukongFeedbackUrl()).toBe('https://wukong.today/api/v1/feedback');
  });

  it('honours WUKONG_CODE_BASE_URL and trims trailing slashes', () => {
    vi.stubEnv('WUKONG_CODE_BASE_URL', 'https://example.test/v9///');
    expect(wukongFeedbackUrl()).toBe('https://example.test/v9/feedback');
  });
});

describe('fetchSubmitFeedback', () => {
  it('POSTs only the confirmed JSON body without authorization', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ feedback_id: 'fb_123' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      SAMPLE_BODY,
      'idem-123',
      { fetchImpl: fetchMock as typeof fetch },
    );

    expect(result).toEqual({ kind: 'ok', feedbackId: 'fb_123' });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [calledUrl, init] = calls[0]!;
    expect(calledUrl).toBe('https://api.example/feedback');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('idempotency-key')).toBe('idem-123');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual(SAMPLE_BODY);
    expect(init?.body).not.toContain('session_id');
    expect(init?.body).not.toContain('model');
    expect(init?.body).not.toContain('logs');
    expect(init?.body).not.toContain('source');
    expect(init?.body).not.toContain('prompt');
  });

  it('accepts a nested API data response', async () => {
    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      SAMPLE_BODY,
      'idem-123',
      {
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ data: { id: 'fb_nested' } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        ) as typeof fetch,
      },
    );
    expect(result).toEqual({ kind: 'ok', feedbackId: 'fb_nested' });
  });

  it('rejects missing or malformed feedback identifiers', async () => {
    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      SAMPLE_BODY,
      'idem-123',
      {
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ feedback_id: 3 }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        ) as typeof fetch,
      },
    );
    expect(result).toEqual({
      kind: 'error',
      message: 'Failed to submit feedback: missing feedback_id.',
    });
  });

  it('surfaces API error messages and status', async () => {
    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      SAMPLE_BODY,
      'idem-123',
      {
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ error: { message: 'feedback rejected' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
        ) as typeof fetch,
      },
    );
    expect(result).toEqual({ kind: 'error', status: 429, message: 'feedback rejected' });
  });

  it('returns a timeout error when the request aborts', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as typeof fetch;
    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      SAMPLE_BODY,
      'idem-123',
      { timeoutMs: 5, fetchImpl },
    );
    expect(result).toEqual({
      kind: 'error',
      message: 'Failed to submit feedback: request timed out.',
    });
  });

  it('returns a generic error message on network failure', async () => {
    const result = await fetchSubmitFeedback(
      'https://api.example/feedback',
      SAMPLE_BODY,
      'idem-123',
      {
        fetchImpl: vi.fn(async () => {
          throw new TypeError('network down');
        }) as typeof fetch,
      },
    );
    expect(result).toEqual({
      kind: 'error',
      message: 'Failed to submit feedback: network down',
    });
  });
});
