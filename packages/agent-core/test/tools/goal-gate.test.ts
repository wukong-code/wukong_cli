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
  });

  it('marks complete when verify-pass gate passes', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass' });
    mocks.runVerification.mockResolvedValue({ status: 'passed' });

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(mocks.runVerification).toHaveBeenCalledWith({ cwd: '/workspace', writeReport: false });
  });

  it('rejects complete and injects feedback when verify-pass gate fails', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass' });
    mocks.runVerification.mockResolvedValue({ status: 'failed' });

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBe(false);
    expect(store.getGoal().goal?.status).toBe('active');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.origin).toEqual({ kind: 'system_trigger', name: 'goal_gate_failed' });
    expect(reminders[0]?.content).toContain('verification did not pass');
  });

  it('rejects complete and injects feedback when scan-clean gate fails', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'scan-clean' });
    mocks.runScan.mockResolvedValue({ status: 'failed' });

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(false);
    expect(store.getGoal().goal?.status).toBe('active');
    expect(mocks.runScan).toHaveBeenCalledWith({ cwd: '/workspace', writeReport: false });
  });

  it('marks complete when judge-pass gate passes', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', stopCondition: 'judge-pass' });
    mocks.runJudge.mockResolvedValue({ verdict: 'pass' });

    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store)),
      ctx({ status: 'complete' }),
    );

    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal).toBeNull();
    expect(mocks.runJudge).toHaveBeenCalledWith({ cwd: '/workspace' });
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
    mocks.runVerification.mockResolvedValue({ status: 'failed' });

    // First attempt: gate fails, iteration = 1
    await executeTool(new UpdateGoalTool(makeAgent(store, reminders)), ctx({ status: 'complete' }));
    expect(store.getGoal().goal?.status).toBe('active');
    expect(store.getGoal().goal?.iteration).toBe(1);

    // Second attempt: gate fails, iteration = 2
    await executeTool(new UpdateGoalTool(makeAgent(store, reminders)), ctx({ status: 'complete' }));
    expect(store.getGoal().goal?.status).toBe('active');
    expect(store.getGoal().goal?.iteration).toBe(2);

    // Third attempt: exceeds max-iterations
    const result = await executeTool(
      new UpdateGoalTool(makeAgent(store, reminders)),
      ctx({ status: 'complete' }),
    );
    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal?.status).toBe('blocked');
    expect(store.getGoal().goal?.terminalReason).toBe('max-iterations');
  });

  it('schedules a one-shot cron retry when gate fails and minIntervalMs is set', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({
      objective: 'work',
      stopCondition: 'verify-pass',
      minIntervalMs: 300_000,
    });
    mocks.runVerification.mockResolvedValue({ status: 'failed' });

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
    expect(init.prompt).toContain('verify-pass');
    expect(init.cron).toMatch(/^\d+ \d+ \d+ \d+ \*$/);
  });

  it('continues immediately when gate fails without minIntervalMs', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work', stopCondition: 'verify-pass' });
    mocks.runVerification.mockResolvedValue({ status: 'failed' });

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
});
