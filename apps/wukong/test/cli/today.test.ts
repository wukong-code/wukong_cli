import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { handleToday, registerTodayCommand, type TodayDeps } from '#/cli/sub/today';
import type { TodayBriefing } from '#/utils/stats';

function makeWriter() {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function makeBriefing(overrides: Partial<TodayBriefing> = {}): TodayBriefing {
  return {
    date: '2026-07-08',
    focus: null,
    workspace: { cwd: '/workspace', changedFiles: 0 },
    today: {
      verify: { runs: 0, passed: 0, failed: 0 },
      scan: { runs: 0, blocked: 0 },
      proof: { runs: 0 },
      guard: { blocked: 0, allowed: 0 },
      goals: { completed: 0, inProgress: 0 },
    },
    streak: 0,
    next: ['wukong scan'],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TodayDeps> = {}): TodayDeps & { readonly stdoutWriter: ReturnType<typeof makeWriter>; readonly stderrWriter: ReturnType<typeof makeWriter> } {
  const stdoutWriter = makeWriter();
  const stderrWriter = makeWriter();
  return {
    cwd: () => '/workspace',
    stdout: stdoutWriter.writer,
    stderr: stderrWriter.writer,
    localDate: () => '2026-07-08',
    buildBriefing: vi.fn().mockResolvedValue(makeBriefing()),
    readFocus: vi.fn().mockReturnValue(null),
    writeFocus: vi.fn(),
    clearFocus: vi.fn(),
    loadHostedUsage: vi.fn().mockResolvedValue(null),
    stdoutWriter,
    stderrWriter,
    ...overrides,
  };
}

describe('handleToday', () => {
  it('prints a human-readable briefing', async () => {
    const deps = makeDeps();
    const code = await handleToday(deps, {});

    expect(code).toBe(0);
    expect(deps.buildBriefing).toHaveBeenCalledWith({ cwd: '/workspace', date: '2026-07-08' });
    expect(deps.stdoutWriter.chunks.join('')).toContain('Wukong Today — 2026-07-08');
    expect(deps.stdoutWriter.chunks.join('')).toContain('Focus: (not set)');
  });

  it('sets focus from a positional argument', async () => {
    const deps = makeDeps();
    await handleToday(deps, { focus: 'ship auth fix' });

    expect(deps.writeFocus).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'ship auth fix', workspace: '/workspace' }),
    );
  });

  it('clears focus when requested', async () => {
    const deps = makeDeps();
    await handleToday(deps, { clearFocus: true });

    expect(deps.clearFocus).toHaveBeenCalled();
  });

  it('prints JSON when requested', async () => {
    const deps = makeDeps();
    await handleToday(deps, { json: true });

    const text = deps.stdoutWriter.chunks.join('');
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ date: '2026-07-08', focus: null, hosted: null });
  });

  it('shows hosted report usage and the dashboard link', async () => {
    const deps = makeDeps({
      loadHostedUsage: vi.fn().mockResolvedValue({
        tier: 'founder',
        used: 7,
        limit: 100,
        dashboardUrl: 'https://wukong.today/dashboard',
      }),
    });

    await handleToday(deps, {});

    const output = deps.stdoutWriter.chunks.join('');
    expect(output).toContain('Hosted reports: 7 / 100 (founder)');
    expect(output).toContain('Dashboard: https://wukong.today/dashboard');
  });

  it('keeps the local briefing usable when hosted usage fails', async () => {
    const deps = makeDeps({
      loadHostedUsage: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(handleToday(deps, {})).resolves.toBe(0);
    expect(deps.stdoutWriter.chunks.join('')).toContain('Wukong Today');
    expect(deps.stderrWriter.chunks).toEqual([]);
  });

  it('uses a custom workspace directory', async () => {
    const deps = makeDeps();
    await handleToday(deps, { workspace: '/other' });

    expect(deps.buildBriefing).toHaveBeenCalledWith({ cwd: '/other', date: '2026-07-08' });
  });

  it('returns 2 and prints an error when briefing fails', async () => {
    const deps = makeDeps({
      buildBriefing: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const code = await handleToday(deps, {});

    expect(code).toBe(2);
    expect(deps.stderrWriter.chunks.join('')).toContain('boom');
  });
});

describe('registerTodayCommand', () => {
  it('registers the today command', () => {
    const program = new Command();
    registerTodayCommand(program);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain('today');
  });
});
