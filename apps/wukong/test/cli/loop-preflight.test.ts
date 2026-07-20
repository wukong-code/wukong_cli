import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatLoopPreflightBlocked,
  formatLoopPreflightReady,
  runLoopPreflight,
} from '#/cli/lib/loop-preflight';

describe('Loop preflight', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'wukong-loop-preflight-'));
    homes.push(path);
    return path;
  }

  it('discovers checks before declaring the Loop ready', async () => {
    const cwd = await workspace();
    const result = await runLoopPreflight({
      objective: 'fix tests',
      model: 'glm-5.2',
      workspace: cwd,
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test', 'pnpm typecheck'],
    });

    expect(result).toEqual({
      ready: true,
      model: 'glm-5.2',
      workspace: cwd,
      checks: ['pnpm test', 'pnpm typecheck'],
    });
    if (result.ready) {
      expect(formatLoopPreflightReady(result, 5)).toContain('Limit    up to 5 iterations');
    }
  });

  it('allows a Loop with no checks but labels the missing evidence', async () => {
    const cwd = await workspace();
    const result = await runLoopPreflight({
      objective: 'create a module',
      model: 'glm-5.2',
      workspace: cwd,
      getActiveGoal: async () => null,
      discoverChecks: async () => [],
    });

    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(formatLoopPreflightReady(result, 2)).toContain('No project checks configured');
    }
  });

  it('blocks before quota when model, workspace, active Goal, or checks config is invalid', async () => {
    const cwd = await workspace();
    const base = {
      objective: 'fix tests',
      model: 'glm-5.2',
      workspace: cwd,
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test'],
    };

    const noModel = await runLoopPreflight({ ...base, model: '' });
    const badWorkspace = await runLoopPreflight({ ...base, workspace: join(cwd, 'missing') });
    const activeGoal = await runLoopPreflight({
      ...base,
      getActiveGoal: async () => ({ goalId: 'g1' }) as never,
    });
    const badChecks = await runLoopPreflight({
      ...base,
      discoverChecks: async () => { throw new Error('bad checks file'); },
    });

    expect(noModel).toMatchObject({ ready: false, reason: 'No model is configured.' });
    expect(badWorkspace).toMatchObject({ ready: false, reason: 'The workspace is not readable.' });
    expect(activeGoal).toMatchObject({ ready: false, reason: 'Another Goal is already active.' });
    expect(badChecks).toMatchObject({ ready: false, reason: expect.stringContaining('bad checks file') });
    if (!noModel.ready) expect(formatLoopPreflightBlocked(noModel)).toContain('Loop not started');
  });
});
