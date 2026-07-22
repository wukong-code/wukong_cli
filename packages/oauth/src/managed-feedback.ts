/**
 * Submit user feedback to the managed Wukong platform.
 *
 * POSTs an explicitly confirmed, content-minimal JSON body to
 * `{wukongBaseUrl}/feedback`. Feedback is intentionally independent of OAuth.
 */

import { readApiErrorMessage } from './api-error';
import { wukongBaseUrl } from './managed-usage';

export interface SubmitFeedbackBody {
  readonly message: string;
  readonly category: 'bug' | 'onboarding' | 'loop_result' | 'feature_request' | 'other';
  readonly version: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly arch: 'arm64' | 'x64';
  readonly loop_outcome?: 'PASS' | 'NEEDS_WORK' | 'ERROR' | null;
  readonly reason_code?: string | null;
  readonly contact?: string | null;
}

export interface FetchSubmitFeedbackOk {
  readonly kind: 'ok';
  readonly feedbackId: string;
}

export interface FetchSubmitFeedbackError {
  readonly kind: 'error';
  readonly status?: number;
  readonly message: string;
}

export type FetchSubmitFeedbackResult = FetchSubmitFeedbackOk | FetchSubmitFeedbackError;

export function wukongFeedbackUrl(baseUrl?: string): string {
  return `${(baseUrl ?? wukongBaseUrl()).replace(/\/+$/, '')}/feedback`;
}

export async function fetchSubmitFeedback(
  url: string,
  body: SubmitFeedbackBody,
  idempotencyKey: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchSubmitFeedbackResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        kind: 'error',
        status: res.status,
        message: await readApiErrorMessage(
          res,
          `Failed to submit feedback: HTTP ${String(res.status)}`,
        ),
      };
    }
    const feedbackId = parseFeedbackId(await res.json());
    if (feedbackId === undefined) {
      return { kind: 'error', message: 'Failed to submit feedback: missing feedback_id.' };
    }
    return { kind: 'ok', feedbackId };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to submit feedback: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to submit feedback: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseFeedbackId(payload: unknown): string | undefined {
  const direct = readFeedbackId(payload);
  if (direct !== undefined) return direct;
  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    return readFeedbackId((payload as { readonly data: unknown }).data);
  }
  return undefined;
}

function readFeedbackId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const value = record['feedback_id'] ?? record['id'];
  return typeof value === 'string' && /^fb_[A-Za-z0-9-]+$/u.test(value) ? value : undefined;
}
