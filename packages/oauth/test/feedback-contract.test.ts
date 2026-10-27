import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { fetchSubmitFeedback, type SubmitFeedbackBody } from '../src/managed-feedback';

interface FeedbackContractFixture {
  readonly contract_version: number;
  readonly endpoint: string;
  readonly method: string;
  readonly content_type: string;
  readonly max_body_bytes: number;
  readonly idempotency_header: string;
  readonly request: {
    readonly additional_properties: boolean;
    readonly required: Record<string, Record<string, unknown>>;
    readonly optional: Record<string, Record<string, unknown>>;
  };
  readonly response_success: {
    readonly status: number;
    readonly body: Record<string, Record<string, unknown>>;
  };
  readonly forbidden_fields: readonly string[];
  readonly valid_samples: readonly SubmitFeedbackBody[];
}

const here = import.meta.dirname;
const fixture = JSON.parse(
  readFileSync(join(here, '../fixtures/feedback-contract.v1.json'), 'utf-8'),
) as FeedbackContractFixture;

function readBodyText(body: unknown): string {
  return typeof body === 'string' ? body : '';
}

const contractFields = new Set([
  ...Object.keys(fixture.request.required),
  ...Object.keys(fixture.request.optional),
]);

interface CapturedRequest {
  readonly calls: Array<{ url: string; init: RequestInit }>;
  readonly fetchMock: typeof fetch;
}

function captureRequest(_sample: SubmitFeedbackBody): CapturedRequest {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: urlText, init: init ?? {} });
    return new Response(JSON.stringify({ feedback_id: 'fb_contract-1', status: 'received' }), {
      status: fixture.response_success.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { calls, fetchMock: fetchMock as unknown as typeof fetch };
}

describe('shared feedback contract fixture', () => {
  it('describes exactly the SubmitFeedbackBody field surface', () => {
    const fullyPopulated: Record<string, unknown> = {
      message: 'x',
      category: 'other',
      version: '0.1.2',
      platform: 'darwin',
      arch: 'arm64',
      loop_outcome: 'PASS',
      reason_code: 'none',
      contact: null,
    };
    expect(new Set(Object.keys(fullyPopulated))).toEqual(contractFields);
  });

  it('declares a closed request body and a forbidden-field allowlist', () => {
    expect(fixture.request.additional_properties).toBe(false);
    expect(fixture.forbidden_fields.length).toBeGreaterThan(0);
    for (const field of contractFields) {
      expect(fixture.forbidden_fields).not.toContain(field);
    }
  });

  it('round-trips every valid sample exactly as the contract specifies', async () => {
    for (const sample of fixture.valid_samples) {
      const { calls, fetchMock } = captureRequest(sample);
      const result = await fetchSubmitFeedback(
        `https://api.example${fixture.endpoint}`,
        sample,
        '0f0e0d0c-0b0a-4908-af00-102030405060',
        { fetchImpl: fetchMock },
      );

      expect(result).toEqual({ kind: 'ok', feedbackId: 'fb_contract-1' });
      const init = calls[0]?.init;
      expect(init).toBeDefined();
      expect(init?.method).toBe(fixture.method);
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe(fixture.content_type);
      expect(headers).toHaveProperty(fixture.idempotency_header);
      const bodyText = readBodyText(calls[0]?.init.body);
      expect(new TextEncoder().encode(bodyText).byteLength).toBeLessThanOrEqual(
        fixture.max_body_bytes,
      );
      expect(JSON.parse(bodyText)).toEqual(sample);
    }
  });

  it('never emits a forbidden field on the wire', async () => {
    for (const sample of fixture.valid_samples) {
      const { calls, fetchMock } = captureRequest(sample);
      await fetchSubmitFeedback('https://api.example/feedback', sample, 'uuid', {
        fetchImpl: fetchMock,
      });
      const sentKeys = Object.keys(JSON.parse(readBodyText(calls[0]?.init.body)) as object);
      for (const key of sentKeys) {
        expect(contractFields.has(key)).toBe(true);
        expect(fixture.forbidden_fields).not.toContain(key);
      }
    }
  });

  it('keeps the accepted feedback id shape in sync with the contract pattern', () => {
    const pattern = String(fixture.response_success.body['feedback_id']?.['pattern']);
    expect(pattern).toBe('^fb_[A-Za-z0-9-]+$');
    expect('fb_contract-1').toMatch(new RegExp(pattern));
  });
});
