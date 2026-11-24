import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { GateRunRecord } from '@wukong/verification';
import { resolveWukongHome } from '@wukong/wukong-sdk';
import { z } from 'zod';

import { readJsonFile, writeJsonFile } from '#/utils/persistence';

const GateCheckSummarySchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'timed_out', 'unavailable']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
});

const GateRiskSummarySchema = z.object({
  id: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});

const StandaloneReviewFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['blocking', 'important', 'note']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  nextAction: z.string(),
});

const GateReviewerSummarySchema = z.object({
  status: z.enum(['passed', 'needs_work', 'not_run', 'error']),
  model: z.string().optional(),
  providerId: z.string().optional(),
  summary: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const GateRunRecordSchema: z.ZodType<GateRunRecord> = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  source: z.enum(['gate', 'loop']),
  generatedAt: z.string().min(1),
  workspaceIdentityDigest: z.string().min(1),
  workspaceName: z.string().min(1),
  objective: z.string().optional(),
  git: z.object({
    isRepo: z.boolean(),
    headSha: z.string().optional(),
    dirty: z.boolean(),
    changedFileCount: z.number().int().nonnegative(),
  }),
  snapshotId: z.string().min(1),
  status: z.enum(['PASS', 'NEEDS_WORK', 'ERROR']),
  reasonCode: z.string().min(1),
  summary: z.string().min(1),
  checks: z.array(GateCheckSummarySchema).readonly(),
  risks: z.array(GateRiskSummarySchema).readonly(),
  reviewer: GateReviewerSummarySchema,
  findings: z.array(StandaloneReviewFindingSchema).readonly(),
  uncoveredItems: z.array(z.string()).readonly(),
  nextSteps: z.array(z.string()).readonly(),
  reviewPolicyLoaded: z.boolean(),
});

function gateRunsDir(homeDir?: string): string {
  return join(resolveWukongHome(homeDir), 'runs', 'gate');
}

function isSafeRunId(runId: string): boolean {
  return (
    runId.length > 0
    && runId !== '.'
    && runId !== '..'
    && !runId.includes('/')
    && !runId.includes('\\')
  );
}

function gateRunPath(runId: string, homeDir?: string): string {
  if (!isSafeRunId(runId)) {
    throw new Error(`Invalid gate run id: "${runId}".`);
  }
  return join(gateRunsDir(homeDir), `${encodeURIComponent(runId)}.json`);
}

export async function saveGateRun(record: GateRunRecord, homeDir?: string): Promise<string> {
  const filePath = gateRunPath(record.runId, homeDir);
  await writeJsonFile(filePath, GateRunRecordSchema, record);
  await chmod(filePath, 0o600);
  return filePath;
}

export async function readGateRun(
  runId: string,
  homeDir?: string,
): Promise<GateRunRecord | undefined> {
  if (!isSafeRunId(runId)) {
    return undefined;
  }
  const filePath = gateRunPath(runId, homeDir);
  return readJsonFile(filePath, GateRunRecordSchema.optional(), undefined);
}

export async function listGateRuns(options: {
  readonly workspaceIdentityDigest?: string;
  readonly homeDir?: string;
} = {}): Promise<readonly GateRunRecord[]> {
  const dir = gateRunsDir(options.homeDir);
  let filenames: string[];
  try {
    filenames = await readdir(dir);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const loaded = await Promise.all(
    filenames
      .filter((filename) => filename.endsWith('.json'))
      .map(async (filename) => {
        try {
          return await readJsonFile(join(dir, filename), GateRunRecordSchema.optional(), undefined);
        } catch {
          return undefined;
        }
      }),
  );

  return loaded
    .filter((record): record is GateRunRecord => {
      if (record === undefined) return false;
      if (
        options.workspaceIdentityDigest !== undefined
        && record.workspaceIdentityDigest !== options.workspaceIdentityDigest
      ) {
        return false;
      }
      return true;
    })
    .toSorted((left, right) => right.generatedAt.localeCompare(left.generatedAt));
}

export async function findLatestGateRun(options: {
  readonly workspaceIdentityDigest?: string;
  readonly homeDir?: string;
} = {}): Promise<GateRunRecord | undefined> {
  const runs = await listGateRuns(options);
  return runs[0];
}
