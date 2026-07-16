import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleReviewSlashCommand } from '#/tui/commands/review';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/review', () => {
  it('creates policy, records feedback, and shows local stats', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-review-project-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'wukong-review-home-'));
    vi.stubEnv('WUKONG_CODE_HOME', dataDir);
    const statuses: string[] = [];
    const errors: string[] = [];
    const host = {
      state: { appState: { workDir: cwd } },
      showStatus: (message: string) => statuses.push(message),
      showError: (message: string) => errors.push(message),
    } as unknown as SlashCommandHost;

    await handleReviewSlashCommand(host, 'init');
    await handleReviewSlashCommand(host, 'feedback auth-refresh false-positive');
    await handleReviewSlashCommand(host, 'stats');

    expect(await readFile(join(cwd, '.wukong', 'review-policy.md'), 'utf8')).toContain(
      'Blocking rules',
    );
    expect(await readFile(join(dataDir, 'review', 'feedback.jsonl'), 'utf8')).toContain(
      '"action":"false_positive"',
    );
    expect(statuses.join('\n')).toContain('Review feedback: 1');
    expect(statuses.join('\n')).toContain('Review cycles: 0');
    expect(errors).toEqual([]);
  });

  it('shows concise usage for invalid arguments', async () => {
    const errors: string[] = [];
    const host = {
      state: { appState: { workDir: '/workspace' } },
      showStatus: () => {},
      showError: (message: string) => errors.push(message),
    } as unknown as SlashCommandHost;

    await handleReviewSlashCommand(host, 'feedback only-id');

    expect(errors[0]).toContain('/review feedback <finding-id>');
  });
});
