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
  version: z.literal(2),
  runId: z.string().min(1),
  goalId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  state: z.enum(['active', 'terminal']),
  startedAt: z.string(),
  terminal: LoopTerminalSchema.optional(),
}).superRefine((record, context) => {
  if (record.state === 'terminal' && record.terminal === undefined) {
    context.addIssue({ code: 'custom', message: 'terminal state requires terminal data' });
  }
  if (record.state === 'active' && record.terminal !== undefined) {
    context.addIssue({ code: 'custom', message: 'active state cannot contain terminal data' });
  }
});

const LegacyLoopRunRecordSchema = z.object({
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

const StoredLoopRunRecordSchema = z.union([
  LoopRunRecordSchema,
  LegacyLoopRunRecordSchema,
]);

export type LoopRunRecord = z.infer<typeof LoopRunRecordSchema>;
type StoredLoopRunRecord = z.infer<typeof StoredLoopRunRecordSchema>;

function loopRunsDir(): string {
  return join(resolveWukongHome(), 'usage', 'loop-runs');
}

function loopRunPath(runId: string): string {
  return join(loopRunsDir(), `${encodeURIComponent(runId)}.json`);
}

function migrateLoopRun(record: StoredLoopRunRecord): LoopRunRecord {
  if (record.version === 2) return record;
  const common = {
    version: 2 as const,
    runId: record.requestId,
    ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
    startedAt: record.startedAt,
  };
  if (record.terminal !== undefined) {
    return { ...common, state: 'terminal', terminal: record.terminal };
  }
  return { ...common, state: 'active' };
}

async function readLoopRunFile(filePath: string): Promise<LoopRunRecord | undefined> {
  const stored = await readJsonFile(filePath, StoredLoopRunRecordSchema.optional(), undefined);
  if (stored === undefined) return undefined;
  const record = migrateLoopRun(stored);
  if (stored.version === 1) await writeLoopRun(record);
  return record;
}

async function readLoopRun(runId: string): Promise<LoopRunRecord | undefined> {
  return readLoopRunFile(loopRunPath(runId));
}

async function writeLoopRun(record: LoopRunRecord): Promise<void> {
  const filePath = loopRunPath(record.runId);
  await writeJsonFile(filePath, LoopRunRecordSchema, record);
  await chmod(filePath, 0o600);
}

export async function recordTrackedLoopStart(runId: string): Promise<boolean> {
  const existing = await readLoopRun(runId);
  if (existing !== undefined) return false;
  const repeatThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const repeatedWithin7d = (await listLoopRuns()).some(
    (record) => Date.parse(record.startedAt) >= repeatThreshold,
  );
  await writeLoopRun({
    version: 2,
    runId,
    state: 'active',
    startedAt: new Date().toISOString(),
  });
  return repeatedWithin7d;
}

export async function hasPriorCompletedLoopWithin7d(
  runId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const currentDayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const repeatThreshold = currentDayStart - 7 * 24 * 60 * 60 * 1000;
  return (await listLoopRuns()).some((record) => {
    if (record.runId === runId || record.terminal?.status !== 'completed') return false;
    if (record.terminal.outcome !== 'PASS' && record.terminal.outcome !== 'NEEDS_WORK') return false;
    const finishedAt = Date.parse(record.terminal.finishedAt);
    return finishedAt >= repeatThreshold && finishedAt < currentDayStart;
  });
}

export async function bindTrackedLoopGoal(
  runId: string,
  goalId: string,
  sessionId?: string,
  workspace?: string,
): Promise<void> {
  const existing = await readLoopRun(runId);
  const record = existing ?? {
    version: 2 as const,
    runId,
    state: 'active' as const,
    startedAt: new Date().toISOString(),
  };
  await writeLoopRun({
    ...record,
    goalId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workspace === undefined ? {} : { workspace }),
  });
}

export async function stageLoopTerminal(
  runId: string,
  terminalInput:
    | { readonly status: 'completed'; readonly outcome: LoopStatus; readonly iterations: number }
    | { readonly status: 'cancelled'; readonly iterations: number },
): Promise<LoopRunRecord> {
  const existing = await readLoopRun(runId);
  const terminal = {
    ...terminalInput,
    iterations: Math.max(0, Math.trunc(terminalInput.iterations)),
    finishedAt: new Date().toISOString(),
  } as const;
  const record: LoopRunRecord = {
    version: 2,
    runId,
    ...(existing?.goalId === undefined ? {} : { goalId: existing.goalId }),
    ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
    ...(existing?.workspace === undefined ? {} : { workspace: existing.workspace }),
    state: 'terminal',
    startedAt: existing?.startedAt ?? terminal.finishedAt,
    terminal,
  };
  await writeLoopRun(record);
  return record;
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
        return await readLoopRunFile(join(loopRunsDir(), filename));
      } catch {
        return undefined;
      }
    }));
  return records.filter((record): record is LoopRunRecord => record !== undefined);
}

export async function findTrackedLoopByGoalId(goalId: string): Promise<LoopRunRecord | undefined> {
  const matches = (await listLoopRuns())
    .filter((record) => record.goalId === goalId && record.state === 'active')
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
  return matches[0];
}

export async function listActiveLoopRuns(): Promise<LoopRunRecord[]> {
  return (await listLoopRuns())
    .filter((record) => record.state === 'active')
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function readLoopRunForTests(runId: string): Promise<LoopRunRecord | undefined> {
  return readLoopRun(runId);
}
