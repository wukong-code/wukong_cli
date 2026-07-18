import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveWukongHome } from '@wukong/wukong-sdk';

import { getCliAccessToken } from '#/cli/lib/auth-token';
import type { LoopStatus } from '#/utils/loop-result';

export interface LoopQuotaGrant {
  readonly allowed: boolean;
  readonly requestId: string;
  readonly maxIterations: number;
  readonly tracked: boolean;
  readonly message?: string;
}

interface StartResponse {
  readonly quota?: {
    readonly tier?: unknown;
    readonly used?: unknown;
    readonly limit?: unknown;
    readonly promptUpgrade?: unknown;
  };
  readonly error?: unknown;
}

const REQUEST_TIMEOUT_MS = 2_000;
const trackedTuiLoops = new Map<string, LoopQuotaGrant>();

function apiBaseUrl(): string {
  return process.env['WUKONG_API_URL'] ?? 'https://wukong.today';
}

async function useGuestTrial(requestId: string): Promise<LoopQuotaGrant> {
  const dir = join(resolveWukongHome(), 'usage');
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(
      join(dir, 'loop-guest-trial.json'),
      `${JSON.stringify({ requestId, usedAt: new Date().toISOString() })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return { allowed: true, requestId, maxIterations: 2, tracked: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        allowed: false,
        requestId,
        maxIterations: 2,
        tracked: false,
        message: 'Guest Loop trial already used. Run `wukong login` for 10 Loop sessions per month.',
      };
    }
    throw error;
  }
}

export async function beginLoopQuota(fetchImpl: typeof fetch = fetch): Promise<LoopQuotaGrant> {
  const requestId = randomUUID().replaceAll('-', '');
  const token = await getCliAccessToken();
  if (token === null) return useGuestTrial(requestId);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${apiBaseUrl()}/api/v1/loops/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as StartResponse;
    if (response.status === 429) {
      return {
        allowed: false,
        requestId,
        maxIterations: 5,
        tracked: false,
        message: 'Monthly Loop limit reached (10/10). Pro is coming soon.',
      };
    }
    if (response.status === 401) {
      return {
        allowed: false,
        requestId,
        maxIterations: 5,
        tracked: false,
        message: 'Login expired. Run `wukong login` again.',
      };
    }
    if (!response.ok || typeof body.quota?.tier !== 'string') throw new Error(`HTTP ${String(response.status)}`);
    const paid = body.quota.tier === 'founder' || body.quota.tier === 'pro';
    const used = typeof body.quota.used === 'number' ? body.quota.used : 0;
    return {
      allowed: true,
      requestId,
      maxIterations: paid ? 10 : 5,
      tracked: true,
      ...(body.quota.promptUpgrade === true
        ? { message: `Free Loop usage: ${String(used)}/10 this month. Pro is coming soon.` }
        : {}),
    };
  } catch {
    return {
      allowed: true,
      requestId,
      maxIterations: 5,
      tracked: false,
      message: 'Loop quota service unavailable; continuing with the local 5-iteration safety limit.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeLoopQuota(
  grant: LoopQuotaGrant,
  outcome: LoopStatus,
  iterations: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!grant.tracked) return;
  const token = await getCliAccessToken();
  if (token === null) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    await fetchImpl(`${apiBaseUrl()}/api/v1/loops/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: grant.requestId, outcome, iterations }),
      signal: controller.signal,
    });
  } catch {
    // Completion is telemetry/accounting only. It must never change the local result.
  } finally {
    clearTimeout(timeout);
  }
}

export function registerTrackedTuiLoop(goalId: string, grant: LoopQuotaGrant): void {
  if (grant.tracked) trackedTuiLoops.set(goalId, grant);
}

export async function completeTrackedTuiLoop(
  goalId: string,
  outcome: LoopStatus,
  iterations: number,
): Promise<void> {
  const grant = trackedTuiLoops.get(goalId);
  if (grant === undefined) return;
  trackedTuiLoops.delete(goalId);
  await completeLoopQuota(grant, outcome, iterations);
}
