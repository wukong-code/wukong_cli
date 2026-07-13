import {
  WukongAuthFacade,
  resolveConfigPath,
  resolveWukongHome,
} from '@wukong/wukong-sdk';
import { WUKONG_CODE_PROVIDER_NAME } from '@wukong/wukong-oauth';
import {
  buildVerificationUploadPayload,
  buildScanUploadPayload,
  buildProofUploadPayload,
  type ReportUploadPayload,
  type ReportTooLargeError,
  type ProofResult,
  type ScanResult,
  type VerificationResult,
} from '@wukong/verification';

import { createWukongCodeHostIdentity, getVersion } from '#/cli/version';

export type ReportableResult =
  | { readonly kind: 'verify'; readonly result: VerificationResult; readonly markdown: string }
  | { readonly kind: 'scan'; readonly result: ScanResult; readonly markdown: string }
  | { readonly kind: 'proof'; readonly result: ProofResult; readonly markdown: string };

export interface ReportUploadSuccess {
  readonly ok: true;
  readonly id: string;
  readonly shareUrl?: string;
}

export interface ReportUploadFailure {
  readonly ok: false;
  readonly reason: string;
}

export type ReportUploadOutcome = ReportUploadSuccess | ReportUploadFailure;

export interface ReportUploadOptions {
  readonly visibility?: 'public' | 'private';
}

const MAX_UPLOAD_BYTES = 512 * 1024;

function getApiBaseUrl(): string {
  return process.env['WUKONG_API_URL'] ?? 'https://wukong.today';
}

function createAuthFacade(): WukongAuthFacade {
  const homeDir = resolveWukongHome();
  const configPath = resolveConfigPath({ homeDir });
  return new WukongAuthFacade({
    homeDir,
    configPath,
    identity: createWukongCodeHostIdentity(getVersion()),
  });
}

export async function getCliAccessToken(): Promise<string | null> {
  const auth = createAuthFacade();
  try {
    return (await auth.getCachedAccessToken(WUKONG_CODE_PROVIDER_NAME)) ?? null;
  } catch {
    return null;
  }
}

function buildPayload(input: ReportableResult): ReportUploadPayload {
  switch (input.kind) {
    case 'verify':
      return buildVerificationUploadPayload(input.result, input.markdown);
    case 'scan':
      return buildScanUploadPayload(input.result, input.markdown);
    case 'proof':
      return buildProofUploadPayload(input.result, input.markdown);
  }
}

export async function uploadReport(
  input: ReportableResult,
  options: ReportUploadOptions = {},
): Promise<ReportUploadOutcome> {
  const token = await getCliAccessToken();
  if (token === null) {
    return { ok: false, reason: 'not logged in; run `wukong login` first' };
  }

  let payload: ReportUploadPayload;
  try {
    payload = { ...buildPayload(input), visibility: options.visibility ?? 'private' };
  } catch (error) {
    const reason =
      error instanceof Error
        ? `failed to redact report: ${error.message}`
        : 'failed to redact report';
    return { ok: false, reason };
  }

  // Final client-side size guard
  const markdownBytes = new TextEncoder().encode(payload.report_markdown).length;
  if (markdownBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `report markdown is too large to upload (${markdownBytes} bytes > ${MAX_UPLOAD_BYTES})`,
    };
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/reports/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body.error?.message) {
          message = body.error.message;
        }
      } catch {
        // ignore parse error
      }
      return { ok: false, reason: `upload failed: ${message}` };
    }

    const body = (await response.json()) as {
      success?: boolean;
      data?: { id?: string; shareUrl?: string | null };
    };
    const id = body.data?.id;
    const shareUrl = body.data?.shareUrl;

    if (!id) {
      return { ok: false, reason: 'upload returned an invalid response' };
    }

    return shareUrl ? { ok: true, id, shareUrl } : { ok: true, id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `network error: ${reason}` };
  }
}

export { type ReportTooLargeError };
