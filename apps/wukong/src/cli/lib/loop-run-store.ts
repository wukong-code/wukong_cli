import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveWukongHome } from '@wukong/wukong-sdk';
import { z } from 'zod';

import { readJsonFile, writeJsonFile } from '#/utils/persistence';
import type { LoopStatus } from '#/utils/loop-result';

export type LoopRunLifecycle = 'completed' | 'cancelled';

const LoopTerminalSchema = z.object({
  status: z.enum(['completed', 'cancelled']),
  outcome: z.enum(['PASS', 'NEEDS_WORK', 'ERROR']).optional(),
  iterations: z.number().int().nonnegative(),
  finishedAt: z.string(),
});

const LoopRunRecordSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1),
  goalId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  state: z.enum(['active', 'pending_terminal', 'synced']),
  startedAt: z.string(),
  terminal: LoopTerminalSchema.optional(),
  sync: z.object({
    attempts: z.number().int().nonnegative(),
    lastAttemptAt: z.string().optional(),
    lastErrorCode: z.string().optional(),
    nextAttemptAt: z.string().optional(),
  }),
});

export type LoopRunRecord = z.infer<typeof LoopRunRecordSchema>;

function loopRunsDir(): string {
  return join(resolveWukongHome(), 'usage', 'loop-runs');
}

function loopRunPath(requestId: string): string {
  return join(loopRunsDir(), `${encodeURIComponent(requestId)}.json`);
}

async function readLoopRun(requestId: string): Promise<LoopRunRecord | undefined> {
  return readJsonFile(loopRunPath(requestId), LoopRunRecordSchema.optional(), undefined);
}

async function writeLoopRun(record: LoopRunRecord): Promise<void> {
  const filePath = loopRunPath(record.requestId);
  await writeJsonFile(filePath, LoopRunRecordSchema, record);
  await chmod(filePath, 0o600);
}

export async function recordTrackedLoopStart(requestId: string): Promise<boolean> {
  const existing = await readLoopRun(requestId);
  if (existing !== undefined) return false;
  const repeatThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const repeatedWithin7d = (await listLoopRuns()).some(
    (record) => Date.parse(record.startedAt) >= repeatThreshold,
  );
  await writeLoopRun({
    version: 1,
    requestId,
    state: 'active',
    startedAt: new Date().toISOString(),
    sync: { attempts: 0 },
  });
  return repeatedWithin7d;
}

export async function hasPriorCompletedLoopWithin7d(
  requestId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const currentDayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const repeatThreshold = currentDayStart - 7 * 24 * 60 * 60 * 1000;
  return (await listLoopRuns()).some((record) => {
    if (record.requestId === requestId || record.terminal?.status !== 'completed') return false;
    if (record.terminal.outcome !== 'PASS' && record.terminal.outcome !== 'NEEDS_WORK') return false;
    const finishedAt = Date.parse(record.terminal.finishedAt);
    return finishedAt >= repeatThreshold && finishedAt < currentDayStart;
  });
}

export async function bindTrackedLoopGoal(
  requestId: string,
  goalId: string,
  sessionId?: string,
  workspace?: string,
): Promise<void> {
  const existing = await readLoopRun(requestId);
  const record = existing ?? {
    version: 1 as const,
    requestId,
    state: 'active' as const,
    startedAt: new Date().toISOString(),
    sync: { attempts: 0 },
  };
  await writeLoopRun({
    ...record,
    goalId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workspace === undefined ? {} : { workspace }),
  });
}

export async function stageLoopTerminal(
  requestId: string,
  status: LoopRunLifecycle,
  outcome: LoopStatus,
  iterations: number,
): Promise<LoopRunRecord> {
  const existing = await readLoopRun(requestId);
  const terminal = {
    status,
    ...(status === 'completed' ? { outcome } : {}),
    iterations: Math.max(0, Math.trunc(iterations)),
    finishedAt: new Date().toISOString(),
  } as const;
  const record: LoopRunRecord = {
    version: 1,
    requestId,
    ...(existing?.goalId === undefined ? {} : { goalId: existing.goalId }),
    ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
    ...(existing?.workspace === undefined ? {} : { workspace: existing.workspace }),
    state: 'pending_terminal',
    startedAt: existing?.startedAt ?? terminal.finishedAt,
    terminal,
    sync: existing?.sync ?? { attempts: 0 },
  };
  await writeLoopRun(record);
  return record;
}

export async function markLoopTerminalSynced(
  requestId: string,
  lastErrorCode?: string,
): Promise<void> {
  const record = await readLoopRun(requestId);
  if (record === undefined) return;
  await writeLoopRun({
    ...record,
    state: 'synced',
    sync: {
      attempts: record.sync.attempts + 1,
      lastAttemptAt: new Date().toISOString(),
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    },
  });
}

export async function markLoopTerminalPending(
  requestId: string,
  errorCode: string,
): Promise<void> {
  const record = await readLoopRun(requestId);
  if (record === undefined) return;
  const delayMs = Math.min(30_000 * (2 ** record.sync.attempts), 60 * 60 * 1000);
  const attemptedAt = new Date();
  await writeLoopRun({
    ...record,
    state: 'pending_terminal',
    sync: {
      attempts: record.sync.attempts + 1,
      lastAttemptAt: attemptedAt.toISOString(),
      lastErrorCode: errorCode,
      nextAttemptAt: new Date(attemptedAt.getTime() + delayMs).toISOString(),
    },
  });
}

async function listLoopRuns(): Promise<LoopRunRecord[]> {
  let filenames: string[];
  try {
    filenames = await readdir(loopRunsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(filenames
    .filter((filename) => filename.endsWith('.json'))
    .map(async (filename) => {
      try {
        return await readJsonFile(
          join(loopRunsDir(), filename),
          LoopRunRecordSchema.optional(),
          undefined,
        );
      } catch {
        return undefined;
      }
    }));
  return records.filter((record): record is LoopRunRecord => record !== undefined);
}

export async function findTrackedLoopByGoalId(goalId: string): Promise<LoopRunRecord | undefined> {
  const matches = (await listLoopRuns())
    .filter((record) => record.goalId === goalId && record.state !== 'synced')
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
  return matches[0];
}

export async function listPendingLoopTerminals(): Promise<LoopRunRecord[]> {
  const now = new Date().toISOString();
  return (await listLoopRuns()).filter(
    (record) => record.state === 'pending_terminal'
      && record.terminal !== undefined
      && (record.sync.nextAttemptAt === undefined || record.sync.nextAttemptAt <= now),
  );
}

export async function listActiveLoopRuns(): Promise<LoopRunRecord[]> {
  return (await listLoopRuns())
    .filter((record) => record.state === 'active')
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function readLoopRunForTests(requestId: string): Promise<LoopRunRecord | undefined> {
  return readLoopRun(requestId);
}
