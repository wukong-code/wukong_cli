import { mkdtemp, rm } from 'node:fs/promises';
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

import { beginLoopQuota, completeLoopQuota } from '#/cli/lib/loop-quota';

describe('Loop quota client', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wukong-loop-quota-'));
    mocks.resolveWukongHome.mockReturnValue(home);
  });

  afterEach(async () => {
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
