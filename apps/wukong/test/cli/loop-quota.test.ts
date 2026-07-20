import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCliAccessToken: vi.fn<() => Promise<string | null>>(),
  resolveWukongHome: vi.fn<() => string>(),
}));

vi.mock('#/cli/lib/auth-token', () => ({ getCliAccessToken: mocks.getCliAccessToken }));
vi.mock('@wukong/wukong-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wukong/wukong-sdk')>()),
  resolveWukongHome: mocks.resolveWukongHome,
}));

import {
  beginLoopQuota,
  completeLoopQuota,
  registerTrackedTuiLoop,
} from '#/cli/lib/loop-quota';
import { readLoopRunForTests } from '#/cli/lib/loop-run-store';

describe('Loop quota client', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wukong-loop-quota-'));
    mocks.resolveWukongHome.mockReturnValue(home);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it('allows one two-iteration guest trial', async () => {
    mocks.getCliAccessToken.mockResolvedValue(null);

    const first = await beginLoopQuota();
    const second = await beginLoopQuota();

    expect(first).toMatchObject({ allowed: true, maxIterations: 2, tracked: false });
    expect(second).toMatchObject({ allowed: false, maxIterations: 2, tracked: false });
  });

  it('parses a signed-in Free grant and reports completion', async () => {
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 3, limit: 10, promptUpgrade: true },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), { status: 200 }));

    const grant = await beginLoopQuota(fetchMock);
    await completeLoopQuota(grant, 'PASS', 2, fetchMock);

    expect(grant).toMatchObject({ allowed: true, maxIterations: 5, tracked: true });
    expect(grant.message).toContain('3/10');
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/v1/loops/complete'),
      expect.objectContaining({ body: expect.stringContaining('"outcome":"PASS"') }),
    );
    await expect(readLoopRunForTests(grant.requestId)).resolves.toMatchObject({
      state: 'synced',
      terminal: { status: 'completed', outcome: 'PASS', iterations: 2 },
    });
  });

  it('marks a second tracked Loop within seven days as repeated use', async () => {
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 1, limit: 10 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 2, limit: 10 },
      }), { status: 200 }));

    const first = await beginLoopQuota(fetchMock);
    const second = await beginLoopQuota(fetchMock);

    expect(first.repeatedWithin7d).toBeUndefined();
    expect(second.repeatedWithin7d).toBe(true);
  });

  it('counts retention only after a Loop completes on a later day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T08:00:00.000Z'));
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({
        quota: { tier: 'free', used: 1, limit: 10 },
      }), { status: 200 }));

    const first = await beginLoopQuota(fetchMock);
    const firstCompletion = await completeLoopQuota(first, 'PASS', 2, fetchMock);
    expect(firstCompletion.repeatedCompletedWithin7d).toBe(false);

    vi.setSystemTime(new Date('2026-07-19T08:00:00.000Z'));
    const second = await beginLoopQuota(fetchMock);
    const secondCompletion = await completeLoopQuota(second, 'NEEDS_WORK', 3, fetchMock);
    expect(secondCompletion.repeatedCompletedWithin7d).toBe(true);
  });

  it('keeps a failed completion in the outbox and retries before the next reservation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T08:00:00.000Z'));
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 1, limit: 10 },
      }), { status: 200 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 2, limit: 10 },
      }), { status: 200 }));

    const first = await beginLoopQuota(fetchMock);
    await completeLoopQuota(first, 'NEEDS_WORK', 5, fetchMock);
    await expect(readLoopRunForTests(first.requestId)).resolves.toMatchObject({
      state: 'pending_terminal',
      sync: { attempts: 1, lastErrorCode: 'network_error' },
    });

    vi.advanceTimersByTime(31_000);
    await beginLoopQuota(fetchMock);

    await expect(readLoopRunForTests(first.requestId)).resolves.toMatchObject({
      state: 'synced',
      sync: { attempts: 2 },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/api/v1/loops/complete');
    expect(fetchMock.mock.calls[3]?.[0]).toContain('/api/v1/loops/start');
  });

  it('recovers the goal-to-request mapping after the quota module reloads', async () => {
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 1, limit: 10 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), { status: 200 }));

    const grant = await beginLoopQuota(fetchMock);
    await registerTrackedTuiLoop(
      'goal-after-restart',
      grant,
      'session-after-restart',
      '/workspace',
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const reloaded = await import('#/cli/lib/loop-quota');

    await reloaded.completeTrackedTuiLoop('goal-after-restart', 'PASS', 3);

    await expect(readLoopRunForTests(grant.requestId)).resolves.toMatchObject({
      goalId: 'goal-after-restart',
      sessionId: 'session-after-restart',
      workspace: '/workspace',
      state: 'synced',
    });
    const recordPath = join(home, 'usage', 'loop-runs', `${grant.requestId}.json`);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it('records user cancellation separately from the Loop outcome', async () => {
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        quota: { tier: 'free', used: 1, limit: 10 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 }));

    const grant = await beginLoopQuota(fetchMock);
    await completeLoopQuota(grant, 'ERROR', 1, fetchMock, 'cancelled');

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/v1/loops/complete'),
      expect.objectContaining({ body: expect.stringContaining('"status":"cancelled"') }),
    );
    await expect(readLoopRunForTests(grant.requestId)).resolves.toMatchObject({
      state: 'synced',
      terminal: { status: 'cancelled' },
    });
    expect((await readLoopRunForTests(grant.requestId))?.terminal?.outcome).toBeUndefined();
  });

  it('fails open with a five-iteration cap on a temporary network error', async () => {
    mocks.getCliAccessToken.mockResolvedValue('token');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));

    await expect(beginLoopQuota(fetchMock)).resolves.toMatchObject({
      allowed: true,
      maxIterations: 5,
      tracked: false,
      message: expect.stringContaining('unavailable'),
    });
  });
});
