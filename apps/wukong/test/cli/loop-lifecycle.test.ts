import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveWukongHome: vi.fn<() => string>(),
}));

vi.mock('@wukong/wukong-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wukong/wukong-sdk')>()),
  resolveWukongHome: mocks.resolveWukongHome,
}));

import {
  beginLoopRun,
  completeLoopRun,
  registerTuiLoop,
  stopLoopRun,
} from '#/cli/lib/loop-lifecycle';
import { readLoopRunForTests } from '#/cli/lib/loop-run-store';

describe('local Loop lifecycle', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wukong-loop-lifecycle-'));
    mocks.resolveWukongHome.mockReturnValue(home);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it('starts and completes locally without calling a Wukong service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const run = await beginLoopRun();
    await completeLoopRun(run, 'PASS', 2);

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readLoopRunForTests(run.runId)).resolves.toMatchObject({
      version: 2,
      runId: run.runId,
      state: 'terminal',
      terminal: { status: 'completed', outcome: 'PASS', iterations: 2 },
    });
    await expect(stat(join(home, 'usage', 'loop-guest-trial.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('marks a second local Loop within seven days as repeated use', async () => {
    const first = await beginLoopRun();
    const second = await beginLoopRun();

    expect(first.repeatedWithin7d).toBeUndefined();
    expect(second.repeatedWithin7d).toBe(true);
  });

  it('counts retention only after a Loop completes on a later day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T08:00:00.000Z'));
    const first = await beginLoopRun();
    const firstCompletion = await completeLoopRun(first, 'PASS', 2);
    expect(firstCompletion.repeatedCompletedWithin7d).toBe(false);

    vi.setSystemTime(new Date('2026-07-19T08:00:00.000Z'));
    const second = await beginLoopRun();
    const secondCompletion = await completeLoopRun(second, 'NEEDS_WORK', 3);
    expect(secondCompletion.repeatedCompletedWithin7d).toBe(true);
  });

  it('recovers the goal-to-run mapping after the lifecycle module reloads', async () => {
    const run = await beginLoopRun();
    await registerTuiLoop(
      'goal-after-restart',
      run,
      'session-after-restart',
      '/workspace',
    );
    vi.resetModules();
    const reloaded = await import('#/cli/lib/loop-lifecycle');

    await reloaded.completeTuiLoop('goal-after-restart', 'PASS', 3);

    await expect(readLoopRunForTests(run.runId)).resolves.toMatchObject({
      goalId: 'goal-after-restart',
      sessionId: 'session-after-restart',
      workspace: '/workspace',
      state: 'terminal',
    });
    const recordPath = join(home, 'usage', 'loop-runs', `${run.runId}.json`);
    const recordStat = await stat(recordPath);
    expect(recordStat.isFile()).toBe(true);
    // Win32 reports synthetic POSIX mode bits, so this assertion cannot
    // evaluate its ACLs. File identity and content remain covered above.
    if (process.platform !== 'win32') {
      expect(recordStat.mode & 0o777).toBe(0o600);
    }
  });

  it('records user cancellation separately from the Loop outcome', async () => {
    const run = await beginLoopRun();
    await stopLoopRun(run, 1);

    await expect(readLoopRunForTests(run.runId)).resolves.toMatchObject({
      state: 'terminal',
      terminal: { status: 'cancelled', iterations: 1 },
    });
    expect((await readLoopRunForTests(run.runId))?.terminal?.outcome).toBeUndefined();
  });

  it('migrates a legacy v1 quota-era record to content-free local lifecycle v2', async () => {
    const runsDir = join(home, 'usage', 'loop-runs');
    const recordPath = join(runsDir, 'legacy-run.json');
    await mkdir(runsDir, { recursive: true });
    await writeFile(recordPath, JSON.stringify({
      version: 1,
      requestId: 'legacy-run',
      goalId: 'legacy-goal',
      state: 'synced',
      startedAt: '2026-07-20T08:00:00.000Z',
      terminal: {
        status: 'completed',
        outcome: 'PASS',
        iterations: 2,
        finishedAt: '2026-07-20T08:05:00.000Z',
      },
      sync: {
        attempts: 3,
        lastAttemptAt: '2026-07-20T08:06:00.000Z',
        lastErrorCode: 'quota_service_unavailable',
      },
    }));

    await expect(readLoopRunForTests('legacy-run')).resolves.toMatchObject({
      version: 2,
      runId: 'legacy-run',
      goalId: 'legacy-goal',
      state: 'terminal',
      terminal: { status: 'completed', outcome: 'PASS', iterations: 2 },
    });
    const migrated = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    expect(migrated).not.toHaveProperty('requestId');
    expect(migrated).not.toHaveProperty('sync');
    expect(migrated).toMatchObject({ version: 2, runId: 'legacy-run', state: 'terminal' });
  });
});
