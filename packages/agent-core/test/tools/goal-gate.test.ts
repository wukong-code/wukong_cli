import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { CronManager } from '../../src/agent/cron/manager';
import { GoalMode } from '../../src/agent/goal';
import { UpdateGoalTool } from '../../src/tools/builtin';
import { executeTool } from './fixtures/execute-tool';

const mocks = vi.hoisted(() => ({
  runVerification: vi.fn(),
  runScan: vi.fn(),
  runJudge: vi.fn(),
  runProof: vi.fn(),
  createWorkspaceSnapshot: vi.fn(),
}));

vi.mock('@wukong/verification', () => mocks);

const signal = new AbortController().signal;

function ctx<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_1', args, signal };
}

function makeAgent(
  store: GoalMode,
  reminders: Array<{ readonly content: string; readonly origin: unknown }> = [],
): Agent {
  return {
    type: 'main',
    goal: store,
    config: { cwd: '/workspace' },
    records: { logRecord: () => {} },
    emitEvent: () => {},
    telemetry: { track: () => {} },
    context: {
      appendSystemReminder: (content: string, origin: unknown) => {
        reminders.push({ content, origin });
      },
    },
    subagentHost: {
      spawn: async () => ({
        completion: Promise.resolve({
          result: 'Independent review complete.\nVERDICT_JSON: {"status":"PASS","summary":"Delivery is complete."}',
        }),
      }),
    },
  } as unknown as Agent;
}

function makeStore(): GoalMode {
  return new GoalMode({
    type: 'main',
    records: { logRecord: () => {} },
    emitEvent: () => {},
    telemetry: { track: () => {} },
    context: { appendSystemReminder: () => {} },
  } as unknown as Agent);
}

describe('UpdateGoalTool verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWorkspaceSnapshot.mockResolvedValue({
      headSha: undefined,
      inputDigest: 'input',
      configDigest: 'config',
    });
  });

  function proof(status: 'passed' | 'blocked') {
    return {
      status,
      recommendation: status === 'passed' ? 'Ready.' : 'Fix the failed delivery gate.',
      reasonCode: status === 'passed' ? 'passed' : 'check_failed',
      snapshotId: 'snapshot-id',
      workspaceFingerprint: { inputDigest: 'input', configDigest: 'config' },
      blockers: [],
      verification: {
        selectedCommands: ['pnpm test'],
        commandResults: [],
        changedFiles: [],
        risks: [],
      },
      scan: { risks: [] },
    };
  }

  it('maps legacy verify-pass to proof-pass and completes when proof passes', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(mocks.runProof).toHaveBeenCalledWith({ cwd: '/workspace', writeReport: false });
  });

  it('rejects complete and injects feedback when proof-pass gate fails', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass' });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBe(false);
    expect(store.getGoal().goal?.status).toBe('active');
    expect(store.getGoal().goal?.loopResult).toMatchObject({
      schemaVersion: 2,
      status: 'NEEDS_WORK',
      reasonCode: 'check_failed',
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.origin).toEqual({ kind: 'system_trigger', name: 'goal_gate_failed' });
    expect(reminders[0]?.content).toContain('Fix the failed delivery gate');
  });

  it('rejects complete and injects feedback when scan-clean gate fails', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'scan-clean' });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(false);
    expect(store.getGoal().goal?.status).toBe('active');
    expect(mocks.runProof).toHaveBeenCalledWith({ cwd: '/workspace', writeReport: false });
  });

  it('marks complete when judge-pass gate passes', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', stopCondition: 'judge-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(mocks.runProof).toHaveBeenCalledWith({ cwd: '/workspace', writeReport: false });
  });

  it('has no gate when stopCondition is absent', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(mocks.runVerification).not.toHaveBeenCalled();
    expect(mocks.runScan).not.toHaveBeenCalled();
    expect(mocks.runJudge).not.toHaveBeenCalled();
  });

  it('blocks the goal when max-iterations is reached', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass', maxIterations: 2 });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    // First attempt: gate fails, iteration = 1
    await executeTool(new UpdateGoalTool(makeAgent(store, reminders)), ctx({ status: 'complete' }));
    expect(store.getGoal().goal?.status).toBe('active');
    expect(store.getGoal().goal?.iteration).toBe(1);

    // Second attempt: gate fails at the limit and stops without a third writer turn.
    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );
    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal?.status).toBe('blocked');
    expect(store.getGoal().goal?.iteration).toBe(2);
    expect(store.getGoal().goal?.terminalReason).toBe(
      'loop:NEEDS_WORK:max_iterations:Maximum Loop iterations reached. Last blocker: Fix the failed delivery gate.',
    );
    expect(store.getGoal().goal?.loopResult).toMatchObject({
      status: 'NEEDS_WORK',
      reasonCode: 'max_iterations',
      iterations: 2,
    });
  });

  it('schedules a one-shot cron retry when gate fails and minIntervalMs is set', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({
      objective: 'work',
      stopCondition: 'verify-pass',
      minIntervalMs: 300_000,
    });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    const addTask = vi.fn();
    const agent = makeAgent(store, reminders);
    (agent as unknown as { cron: CronManager | null }).cron = {
      addTask,
      clocks: { wallNow: () => 1_000_000_000 },
    } as unknown as CronManager;

    const result = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(result.stopTurn).toBe(true);
    expect(addTask).toHaveBeenCalledOnce();
    const init = addTask.mock.calls[0]![0] as { readonly cron: string; readonly prompt: string; readonly recurring: boolean };
    expect(init.recurring).toBe(false);
    expect(init.prompt).toContain('work');
    expect(init.prompt).toContain('proof-pass');
    expect(init.cron).toMatch(/^\d+ \d+ \d+ \d+ \*$/);
  });

  it('continues immediately when gate fails without minIntervalMs', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass' });
    mocks.runProof.mockResolvedValue(proof('blocked'));

    const addTask = vi.fn();
    const agent = makeAgent(store, reminders);
    (agent as unknown as { cron: CronManager | null }).cron = {
      addTask,
      clocks: { wallNow: () => 1_000_000_000 },
    } as unknown as CronManager;

    const result = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(result.stopTurn).toBe(false);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('uses a fresh read-only reviewer after deterministic proof passes', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'ship the change', stopCondition: 'proof-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn().mockResolvedValue({
      completion: Promise.resolve({
        result: 'The change is complete and covered.\nVERDICT_JSON: {"status":"PASS","summary":"Covered and complete."}',
      }),
    });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    const result = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'reviewer',
      runInBackground: false,
      prompt: expect.stringContaining('Objective: ship the change'),
    }));
  });

  it('keeps non-blocking findings without making them Loop blockers', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'ship the change', stopCondition: 'proof-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const verdict = {
      schemaVersion: 1,
      status: 'NEEDS_WORK',
      summary: 'One blocker remains.',
      findings: [
        {
          id: 'auth-refresh',
          criterionId: 'objective',
          severity: 'blocking',
          category: 'correctness',
          summary: 'Refresh tokens remain valid after logout.',
          file: 'src/auth.ts',
          line: 84,
          evidence: 'logout removes the cookie but does not revoke the server token',
          nextAction: 'Revoke the token during logout.',
          confidence: 'high',
          validationStatus: 'verified',
        },
        {
          id: 'auth-comment',
          severity: 'note',
          category: 'maintainability',
          summary: 'The revocation helper could use a short comment.',
          evidence: 'the helper has non-obvious retry behavior',
          nextAction: 'Consider documenting the retry behavior.',
          confidence: 'medium',
          validationStatus: 'unverified',
        },
      ],
    };
    const spawn = vi.fn().mockResolvedValue({
      completion: Promise.resolve({
        result: `Review complete.\nVERDICT_JSON: ${JSON.stringify(verdict)}`,
      }),
    });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    const result = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(result.stopTurn).toBe(false);
    expect(store.getGoal().goal?.loopResult?.blockers).toHaveLength(1);
    expect(store.getGoal().goal?.loopResult?.blockers[0]?.id).toBe('auth-refresh');
    expect(store.getGoal().goal?.loopResult?.findings).toHaveLength(2);
  });

  it('continues from a blocking finding and passes on the next review cycle', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'revoke tokens on logout',
      stopCondition: 'proof-pass',
      maxIterations: 3,
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn()
      .mockResolvedValueOnce({
        completion: Promise.resolve({
          result: `Review complete.
VERDICT_JSON: ${JSON.stringify({
            schemaVersion: 1,
            status: 'NEEDS_WORK',
            summary: 'Logout still leaves the token valid.',
            findings: [{
              id: 'auth-refresh',
              criterionId: 'objective',
              severity: 'blocking',
              category: 'security',
              summary: 'Refresh tokens remain valid after logout.',
              file: 'src/auth.ts',
              line: 84,
              evidence: 'logout removes the cookie without revoking the token',
              nextAction: 'Revoke the refresh token during logout.',
              confidence: 'high',
              validationStatus: 'verified',
            }],
          })}`,
        }),
      })
      .mockResolvedValueOnce({
        completion: Promise.resolve({
          result: 'Review complete.\nVERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Logout now revokes the token.","findings":[],"priorBlockerDispositions":[{"key":"review:objective:security:src/auth.ts","status":"resolved"}]}',
        }),
      });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    const first = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    expect(first.stopTurn).toBe(false);
    expect(store.getGoal().goal?.loopResult?.blockers[0]?.id).toBe('auth-refresh');

    const second = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    expect(second.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
    const secondPrompt = (spawn.mock.calls[1]?.[0] as { readonly prompt: string }).prompt;
    expect(secondPrompt).toContain('Immutable Loop contract');
    expect(secondPrompt).toContain('Prior blocking findings');
    expect(secondPrompt).toContain('auth-refresh');
  });

  it('falls back from an invalid configured reviewer model to the writer model', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'ship the change',
      stopCondition: 'proof-pass',
      reviewModel: 'reviewer-model',
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn()
      .mockResolvedValueOnce({ completion: Promise.resolve({ result: 'not structured' }) })
      .mockResolvedValueOnce({ completion: Promise.resolve({ result: 'still not structured' }) })
      .mockResolvedValueOnce({
        completion: Promise.resolve({
          result: 'Review complete.\nVERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Ready.","findings":[]}',
        }),
      });
    const agent = makeAgent(store);
    (agent.config as { modelAlias?: string }).modelAlias = 'writer-model';
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(spawn.mock.calls.map((call) => call[0].modelAlias)).toEqual([
      'reviewer-model',
      'reviewer-model',
      'writer-model',
    ]);
  });

  it('separates invalid reviewer output from runtime unavailability', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'ship the change', stopCondition: 'proof-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn().mockResolvedValue({
      completion: Promise.resolve({ result: 'not structured' }),
    });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(store.getGoal().goal?.loopResult).toMatchObject({
      status: 'ERROR',
      reasonCode: 'reviewer_invalid_output',
    });
  });

  it('rejects a blocking finding that invents a criterion outside the frozen contract', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'ship the change', stopCondition: 'proof-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const result = `Review complete.\nVERDICT_JSON: ${JSON.stringify({
      schemaVersion: 1,
      status: 'NEEDS_WORK',
      summary: 'Add an unrelated refactor.',
      findings: [{
        id: 'invented-scope',
        criterionId: 'reviewer-preference',
        severity: 'blocking',
        category: 'maintainability',
        summary: 'Refactor another module.',
        evidence: 'The reviewer prefers a different abstraction.',
        nextAction: 'Rewrite the unrelated module.',
        confidence: 'medium',
        validationStatus: 'unverified',
      }],
      priorBlockerDispositions: [],
    })}`;
    const spawn = vi.fn().mockResolvedValue({ completion: Promise.resolve({ result }) });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(store.getGoal().goal?.loopResult).toMatchObject({
      status: 'ERROR',
      reasonCode: 'reviewer_invalid_output',
    });
  });

  it('falls back after the configured reviewer model is unavailable', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'ship the change',
      stopCondition: 'proof-pass',
      reviewModel: 'reviewer-model',
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn()
      .mockRejectedValueOnce(new Error('reviewer provider unavailable'))
      .mockResolvedValueOnce({
        completion: Promise.resolve({
          result: 'Review complete.\nVERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Ready.","findings":[]}',
        }),
      });
    const agent = makeAgent(store);
    (agent.config as { modelAlias?: string }).modelAlias = 'writer-model';
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(spawn.mock.calls.map((call) => call[0].modelAlias)).toEqual([
      'reviewer-model',
      'writer-model',
    ]);
    expect(store.getGoal().goal).toBeNull();
  });

  it('returns reviewer_unavailable after both configured and writer models fail', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'ship the change',
      stopCondition: 'proof-pass',
      reviewModel: 'reviewer-model',
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn()
      .mockRejectedValueOnce(new Error('reviewer provider unavailable'))
      .mockRejectedValueOnce(new Error('writer provider unavailable'));
    const agent = makeAgent(store);
    (agent.config as { modelAlias?: string }).modelAlias = 'writer-model';
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(store.getGoal().goal?.loopResult).toMatchObject({
      status: 'ERROR',
      reasonCode: 'reviewer_unavailable',
    });
  });

  it('does not fall back after cancellation', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'ship the change',
      stopCondition: 'proof-pass',
      reviewModel: 'reviewer-model',
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const controller = new AbortController();
    const spawn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const agent = makeAgent(store);
    (agent.config as { modelAlias?: string }).modelAlias = 'writer-model';
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await expect(executeTool(new UpdateGoalTool(agent), {
      ...ctx({ status: 'complete' }),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(spawn).toHaveBeenCalledOnce();
    expect(store.getGoal().goal?.status).toBe('active');
  });

  it('changes strategy once for a repeated blocker, then stops with no_progress', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({
      objective: 'make the check pass',
      stopCondition: 'proof-pass',
      maxIterations: 5,
    });
    const blockedProof = {
      ...proof('blocked'),
      blockers: [{
        id: 'tests',
        kind: 'check' as const,
        summary: 'Tests fail.',
        command: 'pnpm test',
        nextAction: 'Fix the failing test.',
      }],
    };
    mocks.runProof.mockResolvedValue(blockedProof);
    const spawn = vi.fn().mockResolvedValue({
      completion: Promise.resolve({
        result: 'Strategy ready.\nSTRATEGY_JSON: {"diagnosis":"The edit did not address the failing assertion.","recommendedApproach":"Trace the first failing assertion before editing again.","risks":["Avoid broad rewrites."]}',
      }),
    });
    const agent = makeAgent(store, reminders);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    const first = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    const second = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    expect(first.stopTurn).toBe(false);
    expect(second.stopTurn).toBe(false);
    expect(store.getGoal().goal?.convergence).toMatchObject({
      reviewAttempts: 2,
      strategyAttempts: 1,
    });
    expect(reminders.some((reminder) => reminder.origin === undefined
      || (reminder.origin as { name?: string }).name === 'goal_loop_strategy')).toBe(true);

    const third = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    expect(third.stopTurn).toBe(true);
    expect(store.getGoal().goal).toMatchObject({
      status: 'blocked',
      loopResult: { status: 'NEEDS_WORK', reasonCode: 'no_progress' },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ profileName: 'strategist' }));
  });

  it('continues and completes when the blocker clears after the strategy change', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'make the check pass',
      stopCondition: 'proof-pass',
      maxIterations: 5,
    });
    const blockedProof = {
      ...proof('blocked'),
      blockers: [{
        id: 'tests',
        kind: 'check' as const,
        summary: 'Tests fail.',
        command: 'pnpm test',
        nextAction: 'Fix the failing test.',
      }],
    };
    mocks.runProof.mockResolvedValue(blockedProof);
    const spawn = vi.fn().mockResolvedValueOnce({
      completion: Promise.resolve({
        result: 'Strategy ready.\nSTRATEGY_JSON: {"diagnosis":"The same assertion is still failing.","recommendedApproach":"Trace the assertion input before editing.","risks":["Keep the fix scoped."]}',
      }),
    });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));
    const priorKey = store.getReviewHistory().at(-1)?.blockerKeys[0];
    if (priorKey === undefined) throw new Error('expected a prior blocker key');

    mocks.runProof.mockResolvedValueOnce(proof('passed'));
    spawn.mockResolvedValueOnce({
      completion: Promise.resolve({
        result: `Review complete.\nVERDICT_JSON: ${JSON.stringify({
          schemaVersion: 1,
          status: 'PASS',
          summary: 'The failing check is fixed.',
          findings: [],
          priorBlockerDispositions: [{ key: priorKey, status: 'resolved' }],
        })}`,
      }),
    });

    const result = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(spawn.mock.calls.map((call) => call[0].profileName)).toEqual([
      'strategist',
      'reviewer',
    ]);
  });

  it('uses the Loop reviewer model without changing the writer model', async () => {
    const store = makeStore();
    await store.createGoal({
      objective: 'ship the change',
      stopCondition: 'proof-pass',
      reviewModel: 'reviewer-model',
    });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const spawn = vi.fn().mockResolvedValue({
      completion: Promise.resolve({
        result: 'Review complete.\nVERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Ready.","findings":[]}',
      }),
    });
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost: { spawn: typeof spawn } }).subagentHost = { spawn };

    await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'reviewer',
      modelAlias: 'reviewer-model',
    }));
  });

  it('stops with a verification error when the fresh reviewer is unavailable', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'ship the change', stopCondition: 'proof-pass' });
    mocks.runProof.mockResolvedValue(proof('passed'));
    const agent = makeAgent(store);
    (agent as unknown as { subagentHost?: unknown }).subagentHost = undefined;

    const result = await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete' }));

    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal?.status).toBe('blocked');
    expect(store.getGoal().goal?.terminalReason).toBe(
      'loop:ERROR:reviewer_unavailable:fresh reviewer is unavailable in this runtime.',
    );
  });
});
