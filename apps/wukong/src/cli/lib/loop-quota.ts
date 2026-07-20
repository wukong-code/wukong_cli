import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveWukongHome } from '@wukong/wukong-sdk';

import { getCliAccessToken } from '#/cli/lib/auth-token';
import {
  bindTrackedLoopGoal,
  findTrackedLoopByGoalId,
  listPendingLoopTerminals,
  markLoopTerminalPending,
  markLoopTerminalSynced,
  recordTrackedLoopStart,
  stageLoopTerminal,
  type LoopRunLifecycle,
  type LoopRunRecord,
} from '#/cli/lib/loop-run-store';
import type { LoopStatus } from '#/utils/loop-result';

export interface LoopQuotaGrant {
  readonly allowed: boolean;
  readonly requestId: string;
  readonly maxIterations: number;
  readonly tracked: boolean;
  readonly repeatedWithin7d?: boolean;
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

  await flushLoopCompletionOutbox(fetchImpl, token).catch(() => {});

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
    const grant: LoopQuotaGrant = {
      allowed: true,
      requestId,
      maxIterations: paid ? 10 : 5,
      tracked: true,
      ...(body.quota.promptUpgrade === true
        ? { message: `Free Loop usage: ${String(used)}/10 this month. Pro is coming soon.` }
        : {}),
    };
    const repeatedWithin7d = await recordTrackedLoopStart(requestId).catch(() => false);
    return repeatedWithin7d ? { ...grant, repeatedWithin7d: true } : grant;
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
  lifecycle: LoopRunLifecycle = 'completed',
): Promise<void> {
  if (!grant.tracked) return;
  const record = await stageLoopTerminal(
    grant.requestId,
    lifecycle,
    outcome,
    iterations,
  ).catch(() => undefined);
  const token = await getCliAccessToken();
  if (token === null) return;
  await sendLoopTerminal(
    record ?? {
      version: 1,
      requestId: grant.requestId,
      state: 'pending_terminal',
      startedAt: new Date().toISOString(),
      terminal: {
        status: lifecycle,
        ...(lifecycle === 'completed' ? { outcome } : {}),
        iterations: Math.max(0, Math.trunc(iterations)),
        finishedAt: new Date().toISOString(),
      },
      sync: { attempts: 0 },
    },
    token,
    fetchImpl,
  );
}

async function sendLoopTerminal(
  record: LoopRunRecord,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (record.terminal === undefined) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${apiBaseUrl()}/api/v1/loops/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: record.requestId,
        status: record.terminal.status,
        ...(record.terminal.outcome === undefined ? {} : { outcome: record.terminal.outcome }),
        iterations: record.terminal.iterations,
      }),
      signal: controller.signal,
    });
    if (response.ok) {
      await markLoopTerminalSynced(record.requestId).catch(() => {});
      return;
    }
    if (response.status === 409) {
      await markLoopTerminalSynced(record.requestId, 'http_409').catch(() => {});
      return;
    }
    await markLoopTerminalPending(record.requestId, `http_${String(response.status)}`).catch(() => {});
  } catch (error) {
    const code = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error';
    await markLoopTerminalPending(record.requestId, code).catch(() => {});
  } finally {
    clearTimeout(timeout);
  }
}

export async function flushLoopCompletionOutbox(
  fetchImpl: typeof fetch = fetch,
  accessToken?: string,
): Promise<void> {
  const token = accessToken ?? await getCliAccessToken();
  if (token === null) return;
  const pending = await listPendingLoopTerminals();
  for (const record of pending) {
    await sendLoopTerminal(record, token, fetchImpl);
  }
}

export async function registerTrackedTuiLoop(
  goalId: string,
  grant: LoopQuotaGrant,
  sessionId?: string,
  workspace?: string,
): Promise<void> {
  if (!grant.tracked) return;
  trackedTuiLoops.set(goalId, grant);
  await bindTrackedLoopGoal(grant.requestId, goalId, sessionId, workspace).catch(() => {});
}

export async function cancelTrackedLoopRecord(
  record: LoopRunRecord,
  iterations: number = 0,
): Promise<void> {
  await completeLoopQuota({
    allowed: true,
    requestId: record.requestId,
    maxIterations: 5,
    tracked: true,
  }, 'ERROR', iterations, fetch, 'cancelled');
}

export async function completeTrackedTuiLoop(
  goalId: string,
  outcome: LoopStatus,
  iterations: number,
  lifecycle: LoopRunLifecycle = 'completed',
): Promise<void> {
  let grant = trackedTuiLoops.get(goalId);
  if (grant === undefined) {
    const record = await findTrackedLoopByGoalId(goalId);
    if (record !== undefined) {
      grant = {
        allowed: true,
        requestId: record.requestId,
        maxIterations: 5,
        tracked: true,
      };
    }
  }
  if (grant === undefined) return;
  trackedTuiLoops.delete(goalId);
  await completeLoopQuota(grant, outcome, iterations, fetch, lifecycle);
}
