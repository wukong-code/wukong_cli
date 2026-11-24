import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  createWorkspaceSnapshot,
  inspectGit,
  renderDeliveryProofCard,
  resolveWorkspaceIdentity,
  sanitizeGateRunRecord,
  type GateRunRecord,
} from '@wukong/verification';
import { resolveWukongHome } from '@wukong/wukong-sdk';
import type { Command } from 'commander';

import { listGateRuns, readGateRun } from '#/cli/lib/gate-run-store';
import { listLoopRunsForSummary, type LoopRunRecord } from '#/cli/lib/loop-run-store';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SummaryCliOptions {
  readonly cwd?: string;
  readonly runId?: string;
  readonly out?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface SummaryDeps {
  readonly cwd: () => string;
  readonly homeDir: () => string | undefined;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly resolveWorkspaceIdentity: typeof resolveWorkspaceIdentity;
  readonly inspectGit: typeof inspectGit;
  readonly createSnapshot: typeof createWorkspaceSnapshot;
  readonly readGateRun: (runId: string, homeDir?: string) => Promise<GateRunRecord | undefined>;
  readonly listGateRuns: typeof listGateRuns;
  readonly listLoopRuns: typeof listLoopRunsForSummary;
}

export async function handleSummary(
  deps: SummaryDeps,
  options: SummaryCliOptions,
): Promise<number> {
  try {
    const cwd = resolve(options.cwd ?? deps.cwd());
    const homeDir = deps.homeDir();
    const workspaceIdentity = await deps.resolveWorkspaceIdentity(cwd);
    const workspaceName = basename(workspaceIdentity.canonicalRealpath) || 'workspace';

    const target = await resolveTargetRecord(
      deps,
      options.runId,
      workspaceIdentity.canonicalRealpath,
      workspaceIdentity.workspaceIdentityDigest,
      workspaceName,
      homeDir,
    );
    if (target === undefined) {
      deps.stderr.write(
        options.runId === undefined
          ? 'No gate or loop runs found for this workspace. Run `wukong gate` first.\n'
          : `Run "${options.runId}" not found.\n`,
      );
      return 1;
    }

    const git = await deps.inspectGit(cwd);
    const snapshot = git.isRepo
      ? await deps.createSnapshot({ cwd, commands: [], git })
      : undefined;
    const currentHeadSha = snapshot?.headSha;
    const currentDirty = git.changedFiles.length > 0;
    const sanitized = sanitizeGateRunRecord(target, homeDir);
    const markdown = renderDeliveryProofCard(sanitized, {
      currentHeadSha,
      currentDirty,
      homeDir,
    });

    if (options.out !== undefined) {
      const targetPath = resolve(cwd, options.out);
      await mkdir(dirname(targetPath), { recursive: true });
      try {
        await writeFile(targetPath, markdown, {
          encoding: 'utf8',
          flag: options.force === true ? 'w' : 'wx',
        });
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          deps.stderr.write(`File already exists: ${options.out}. Pass --force to overwrite.\n`);
          return 1;
        }
        throw error;
      }
    }

    const headDrifted = currentHeadSha !== undefined
      && sanitized.git.isRepo
      && (
        sanitized.git.headSha === undefined
          ? true
          : currentHeadSha !== sanitized.git.headSha
      );
    const dirtyDrifted = currentDirty && !sanitized.git.dirty;

    if (options.json === true) {
      deps.stdout.write(
        `${JSON.stringify(
          {
            record: sanitized,
            stale: headDrifted || dirtyDrifted,
            outPath: options.out,
            markdown,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      deps.stdout.write(markdown);
    }
    return 0;
  } catch (error) {
    deps.stderr.write(`wukong summary failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerSummaryCommand(parent: Command, deps?: Partial<SummaryDeps>): void {
  parent
    .command('summary')
    .description('Render a sanitized PR-ready Markdown Delivery Proof Card from a previous gate or loop run.')
    .option('--run <runId>', 'Render summary for a specific gate or loop run ID.')
    .option('--out <path>', 'Write the Markdown Delivery Proof Card to this path.')
    .option('--force', 'Allow overwriting an existing --out file.', false)
    .option('--json', 'Print the sanitized record and Markdown summary as JSON.', false)
    .action(async (raw: RawSummaryOptions) => {
      const code = await handleSummary(resolveDeps(deps), {
        runId: raw.run,
        out: raw.out,
        force: raw.force === true,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawSummaryOptions {
  readonly run?: string;
  readonly out?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

function resolveDeps(overrides: Partial<SummaryDeps> = {}): SummaryDeps {
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    homeDir: overrides.homeDir ?? (() => resolveWukongHome()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    resolveWorkspaceIdentity: overrides.resolveWorkspaceIdentity ?? resolveWorkspaceIdentity,
    inspectGit: overrides.inspectGit ?? inspectGit,
    createSnapshot: overrides.createSnapshot ?? createWorkspaceSnapshot,
    readGateRun: overrides.readGateRun ?? readGateRun,
    listGateRuns: overrides.listGateRuns ?? listGateRuns,
    listLoopRuns: overrides.listLoopRuns ?? listLoopRunsForSummary,
  };
}

async function resolveTargetRecord(
  deps: SummaryDeps,
  runId: string | undefined,
  canonicalCwd: string,
  workspaceIdentityDigest: string,
  workspaceName: string,
  homeDir: string | undefined,
): Promise<GateRunRecord | undefined> {
  if (runId !== undefined) {
    const gate = await deps.readGateRun(runId, homeDir);
    if (gate !== undefined) return gate;

    const loopRuns = await deps.listLoopRuns(undefined);
    const matchedLoop = loopRuns.find((item) => item.runId === runId || item.goalId === runId);
    if (matchedLoop === undefined) return undefined;
    return loopRunToGateRecord(matchedLoop, workspaceIdentityDigest, workspaceName);
  }

  const [gateRuns, loopRuns] = await Promise.all([
    deps.listGateRuns({ workspaceIdentityDigest, homeDir }),
    deps.listLoopRuns(canonicalCwd),
  ]);

  const latestGate = gateRuns[0];
  const latestLoop = loopRuns[0];
  if (latestGate === undefined && latestLoop === undefined) return undefined;
  if (latestLoop === undefined) return latestGate;
  if (latestGate === undefined) {
    return loopRunToGateRecord(latestLoop, workspaceIdentityDigest, workspaceName);
  }

  const gateMs = Date.parse(latestGate.generatedAt);
  const loopTimestamp = latestLoop.terminal?.finishedAt ?? latestLoop.startedAt;
  const loopMs = Date.parse(loopTimestamp);
  if (Number.isFinite(loopMs) && Number.isFinite(gateMs) && loopMs > gateMs) {
    return loopRunToGateRecord(latestLoop, workspaceIdentityDigest, workspaceName);
  }
  return latestGate;
}

function loopRunToGateRecord(
  loop: LoopRunRecord,
  workspaceIdentityDigest: string,
  workspaceName: string,
): GateRunRecord {
  const generatedAt = loop.terminal?.finishedAt ?? loop.startedAt;
  let status: GateRunRecord['status'];
  let reasonCode: string;
  let summary: string;

  if (loop.state === 'active') {
    status = 'ERROR';
    reasonCode = 'loop_still_active';
    summary = 'Recorded Loop run is still in progress or did not record a terminal outcome.';
  } else if (loop.terminal?.status === 'cancelled') {
    status = 'NEEDS_WORK';
    reasonCode = 'loop_cancelled';
    summary = `Recorded Loop run was cancelled after ${String(loop.terminal.iterations)} iteration(s).`;
  } else if (loop.terminal?.outcome === 'PASS') {
    status = 'PASS';
    reasonCode = 'loop_passed';
    summary = `Recorded Loop run reached PASS outcome after ${String(loop.terminal.iterations)} iteration(s).`;
  } else if (loop.terminal?.outcome === 'NEEDS_WORK') {
    status = 'NEEDS_WORK';
    reasonCode = 'loop_needs_work';
    summary = `Recorded Loop run stopped with NEEDS_WORK after ${String(loop.terminal.iterations)} iteration(s).`;
  } else {
    status = 'ERROR';
    reasonCode = 'loop_error';
    summary = 'Recorded Loop run ended with ERROR or missing outcome.';
  }

  return {
    schemaVersion: 1,
    runId: loop.runId,
    source: 'loop',
    generatedAt,
    workspaceIdentityDigest,
    workspaceName,
    objective: undefined,
    git: {
      isRepo: false,
      headSha: undefined,
      dirty: false,
      changedFileCount: 0,
    },
    snapshotId: `loop:${loop.runId}`,
    status,
    reasonCode,
    summary,
    checks: [],
    risks: [],
    reviewer: {
      status: 'not_run',
      model: undefined,
      providerId: undefined,
      summary: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    },
    findings: [],
    uncoveredItems: [
      'Per-check command results and detailed reviewer findings are not stored in the lightweight Loop lifecycle index; run `wukong gate` for a full proof breakdown.',
      'Loop lifecycle index did not record baseline commit SHA or dirty working-tree state.',
    ],
    nextSteps:
      status === 'PASS'
        ? ['Run `wukong gate` if you need per-check proof lines attached to your PR.']
        : ['Run `wukong gate` to verify the workspace and inspect blockers.'],
    reviewPolicyLoaded: false,
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EEXIST'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
