import { mkdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverForeignSessionRows,
  discoverForeignSessionSuggestion,
} from '#/tui/utils/foreign-sessions';

describe('discoverForeignSessionRows', () => {
  let home: string;
  const workDir = '/tmp/wukong-resume-project';

  beforeEach(async () => {
    home = join(tmpdir(), `wukong-foreign-sessions-${crypto.randomUUID()}`);
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('discovers and labels Codex, Claude Code, and Cursor sessions', async () => {
    const codex = join(home, '.codex/sessions/2026/07/18/rollout-test.jsonl');
    const claude = join(home, '.claude/projects/project/claude-id.jsonl');
    const cursor = join(
      home,
      '.cursor/projects/tmp-wukong-resume-project/agent-transcripts/cursor-id/cursor-id.jsonl',
    );
    await Promise.all([
      mkdir(join(codex, '..'), { recursive: true }),
      mkdir(join(claude, '..'), { recursive: true }),
      mkdir(join(cursor, '..'), { recursive: true }),
    ]);
    await writeFile(
      codex,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex-id', cwd: workDir } }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions for project' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Fix Codex task' },
        }),
      ].join('\n'),
    );
    await writeFile(
      claude,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-id',
          cwd: workDir,
          message: { role: 'user', content: 'Fix Claude task' },
        }),
        JSON.stringify({ type: 'ai-title', sessionId: 'claude-id', aiTitle: 'Claude title' }),
      ].join('\n'),
    );
    await writeFile(
      cursor,
      JSON.stringify({ role: 'user', message: { content: 'Fix Cursor task' } }),
    );

    const rows = await discoverForeignSessionRows({ homeDir: home, workDir });
    const codexRealPath = await realpath(codex);

    expect(rows.map((row) => row.source).toSorted()).toEqual(['claude', 'codex', 'cursor']);
    expect(rows.find((row) => row.source === 'codex')).toMatchObject({
      id: 'external:codex:codex-id',
      title: 'Fix Codex task',
      external: { id: 'codex-id', sourcePath: codexRealPath },
    });
    expect(rows.find((row) => row.source === 'claude')?.title).toBe('Claude title');
    expect(rows.find((row) => row.source === 'cursor')?.title).toBe('Fix Cursor task');
  });

  it('filters by source and current working directory', async () => {
    const matching = join(home, '.codex/sessions/2026/07/18/rollout-match.jsonl');
    const other = join(home, '.codex/sessions/2026/07/18/rollout-other.jsonl');
    await mkdir(join(matching, '..'), { recursive: true });
    await writeFile(
      matching,
      JSON.stringify({ type: 'session_meta', payload: { id: 'match', cwd: workDir } }),
    );
    await writeFile(
      other,
      JSON.stringify({ type: 'session_meta', payload: { id: 'other', cwd: '/tmp/other' } }),
    );

    const rows = await discoverForeignSessionRows({ source: 'codex', homeDir: home, workDir });

    expect(rows.map((row) => row.external?.id)).toEqual(['match']);
  });

  it('returns only a recent workspace-matching suggestion', async () => {
    const recent = join(home, '.codex/sessions/2026/07/18/rollout-recent.jsonl');
    const old = join(home, '.claude/projects/project/old.jsonl');
    await Promise.all([
      mkdir(join(recent, '..'), { recursive: true }),
      mkdir(join(old, '..'), { recursive: true }),
    ]);
    await writeFile(
      recent,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'recent', cwd: workDir } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Continue recent work' } })}`,
    );
    await writeFile(
      old,
      JSON.stringify({
        type: 'user',
        sessionId: 'old',
        cwd: workDir,
        message: { content: 'Old work' },
      }),
    );
    const now = Date.parse('2026-07-20T00:00:00.000Z');
    await utimes(recent, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(old, new Date(now - 31 * 24 * 60 * 60 * 1000), new Date(now - 31 * 24 * 60 * 60 * 1000));

    await expect(discoverForeignSessionSuggestion({
      homeDir: home,
      workDir,
      now,
    })).resolves.toMatchObject({ source: 'codex', title: 'Continue recent work' });
  });

  it('recovers an existing Cursor workspace path when listing all sessions', async () => {
    const cursorWorkDir = join(home, 'workspace-with-dash');
    const encoded = cursorWorkDir.replace(/^\/+/, '').replaceAll('/', '-');
    const cursor = join(
      home,
      `.cursor/projects/${encoded}/agent-transcripts/cursor-all/cursor-all.jsonl`,
    );
    await Promise.all([
      mkdir(cursorWorkDir, { recursive: true }),
      mkdir(join(cursor, '..'), { recursive: true }),
    ]);
    await writeFile(cursor, JSON.stringify({ role: 'user', message: { content: 'Resume me' } }));

    const rows = await discoverForeignSessionRows({ source: 'cursor', homeDir: home });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.work_dir).toBe(cursorWorkDir);
  });

  it('hides Cursor transcripts whose encoded workspace cannot be resolved safely', async () => {
    const cursor = join(
      home,
      '.cursor/projects/path-that-does-not-exist/agent-transcripts/orphan/orphan.jsonl',
    );
    await mkdir(join(cursor, '..'), { recursive: true });
    await writeFile(cursor, JSON.stringify({ role: 'user', message: { content: 'Orphan' } }));

    const rows = await discoverForeignSessionRows({ source: 'cursor', homeDir: home });

    expect(rows).toEqual([]);
  });

  it('discovers Kimi Code sessions from the bounded index and request history', async () => {
    const sessionDir = join(home, '.kimi-code/sessions/kimi-id');
    const history = join(home, '.kimi-code/user-history/kimi-id.jsonl');
    await Promise.all([
      mkdir(sessionDir, { recursive: true }),
      mkdir(join(history, '..'), { recursive: true }),
    ]);
    await writeFile(
      join(home, '.kimi-code/session_index.jsonl'),
      JSON.stringify({ sessionId: 'kimi-id', sessionDir, workDir }),
    );
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ title: 'Kimi title', lastPrompt: 'Newest Kimi request', updatedAt: 123 }),
    );
    await writeFile(history, JSON.stringify({ content: 'Initial Kimi request' }));

    const rows = await discoverForeignSessionRows({ source: 'kimi', homeDir: home, workDir });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'external:kimi:kimi-id',
      source: 'kimi',
      title: 'Kimi title',
      last_prompt: 'Newest Kimi request',
      work_dir: workDir,
    });
  });

  it('never projects Kimi system, auth, terminal, or memtrace records as user requests', async () => {
    const sessionDir = join(home, '.kimi-code/sessions/kimi-safe');
    const history = join(home, '.kimi-code/user-history/kimi-safe.jsonl');
    await Promise.all([
      mkdir(sessionDir, { recursive: true }),
      mkdir(join(history, '..'), { recursive: true }),
    ]);
    await writeFile(
      join(home, '.kimi-code/session_index.jsonl'),
      JSON.stringify({ sessionId: 'kimi-safe', sessionDir, workDir }),
    );
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ title: 'Safe Kimi task' }));
    await writeFile(history, [
      JSON.stringify({ type: 'user', content: 'Finish the safe user request' }),
      JSON.stringify({ type: 'system', content: 'hidden system prompt' }),
      JSON.stringify({ type: 'auth', content: 'secret bearer token' }),
      JSON.stringify({ type: 'terminal', content: 'raw terminal output' }),
      JSON.stringify({ type: 'memtrace', content: 'hidden memory trace' }),
    ].join('\n'));

    const rows = await discoverForeignSessionRows({ source: 'kimi', homeDir: home, workDir });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_prompt).toBe('Finish the safe user request');
    const projected = JSON.stringify(rows[0]);
    expect(projected).not.toContain('hidden system prompt');
    expect(projected).not.toContain('secret bearer token');
    expect(projected).not.toContain('raw terminal output');
    expect(projected).not.toContain('hidden memory trace');
  });

  it('projects only allowlisted user text blocks across foreign transcript formats', async () => {
    const codex = join(home, '.codex/sessions/2026/07/18/rollout-safe.jsonl');
    const claude = join(home, '.claude/projects/project/claude-safe.jsonl');
    const cursor = join(
      home,
      '.cursor/projects/tmp-wukong-resume-project/agent-transcripts/cursor-safe/cursor-safe.jsonl',
    );
    const grokDir = join(home, '.grok/sessions/2026-07-22/grok-safe');
    await Promise.all([
      mkdir(join(codex, '..'), { recursive: true }),
      mkdir(join(claude, '..'), { recursive: true }),
      mkdir(join(cursor, '..'), { recursive: true }),
      mkdir(grokDir, { recursive: true }),
    ]);
    await writeFile(codex, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-safe', cwd: workDir } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Safe Codex request' },
            { type: 'system', text: 'hidden Codex system text' },
          ],
        },
      }),
    ].join('\n'));
    await writeFile(claude, JSON.stringify({
      type: 'user',
      sessionId: 'claude-safe',
      cwd: workDir,
      message: {
        content: [
          { type: 'text', text: 'Safe Claude request' },
          { type: 'tool_result', content: 'hidden Claude terminal output' },
        ],
      },
    }));
    await writeFile(cursor, JSON.stringify({
      role: 'user',
      message: {
        content: [
          { type: 'text', text: 'Safe Cursor request' },
          { type: 'memtrace', text: 'hidden Cursor memory trace' },
        ],
      },
    }));
    await writeFile(join(grokDir, 'summary.json'), JSON.stringify({
      chat_format_version: 1,
      generated_title: 'Safe Grok task',
      info: { id: 'grok-safe', cwd: workDir },
    }));
    await writeFile(join(grokDir, 'chat_history.jsonl'), JSON.stringify({
      type: 'user',
      content: [
        { type: 'text', text: 'Safe Grok request' },
        { type: 'auth', content: 'hidden Grok credential' },
      ],
    }));

    const rows = await discoverForeignSessionRows({ homeDir: home, workDir });
    expect(rows.find((row) => row.source === 'codex')?.last_prompt).toBe('Safe Codex request');
    expect(rows.find((row) => row.source === 'claude')?.last_prompt).toBe('Safe Claude request');
    expect(rows.find((row) => row.source === 'cursor')?.last_prompt).toBe('Safe Cursor request');
    expect(rows.find((row) => row.source === 'grok')?.last_prompt).toBe('Safe Grok request');
    const projected = JSON.stringify(rows);
    expect(projected).not.toMatch(/hidden .*?(system|terminal|memory|credential)/iu);
  });

  it('discovers only supported Grok chat history formats', async () => {
    const validDir = join(home, '.grok/sessions/2026-07-22/grok-id');
    const unsupportedDir = join(home, '.grok/sessions/2026-07-22/grok-v2');
    await Promise.all([
      mkdir(validDir, { recursive: true }),
      mkdir(unsupportedDir, { recursive: true }),
    ]);
    await writeFile(
      join(validDir, 'summary.json'),
      JSON.stringify({
        chat_format_version: 1,
        generated_title: 'Grok title',
        info: { id: 'grok-id', cwd: workDir },
      }),
    );
    await writeFile(
      join(validDir, 'chat_history.jsonl'),
      `${JSON.stringify({ type: 'user', content: 'Initial Grok request' })}\n${JSON.stringify({ type: 'user', content: 'Newest Grok request' })}`,
    );
    await writeFile(
      join(unsupportedDir, 'summary.json'),
      JSON.stringify({ chat_format_version: 2, info: { id: 'grok-v2', cwd: workDir } }),
    );
    await writeFile(
      join(unsupportedDir, 'chat_history.jsonl'),
      JSON.stringify({ type: 'user', content: 'Unsupported request' }),
    );

    const rows = await discoverForeignSessionRows({ source: 'grok', homeDir: home, workDir });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'external:grok:grok-id',
      source: 'grok',
      title: 'Grok title',
      last_prompt: 'Newest Grok request',
      work_dir: workDir,
    });
  });

  it('rejects Kimi metadata and Grok summaries that escape their source roots', async () => {
    const outsideKimi = join(home, 'outside-kimi');
    const outsideGrok = join(home, 'outside-grok');
    const grokLinkDir = join(home, '.grok/sessions/2026-07-22/linked');
    await Promise.all([
      mkdir(outsideKimi, { recursive: true }),
      mkdir(outsideGrok, { recursive: true }),
      mkdir(join(home, '.kimi-code'), { recursive: true }),
      mkdir(join(grokLinkDir, '..'), { recursive: true }),
    ]);
    await writeFile(join(outsideKimi, 'state.json'), JSON.stringify({ title: 'Escaped' }));
    await writeFile(
      join(home, '.kimi-code/session_index.jsonl'),
      JSON.stringify({ sessionId: 'escaped-kimi', sessionDir: outsideKimi, workDir }),
    );
    await writeFile(
      join(outsideGrok, 'summary.json'),
      JSON.stringify({ chat_format_version: 1, info: { id: 'escaped-grok', cwd: workDir } }),
    );
    await writeFile(
      join(outsideGrok, 'chat_history.jsonl'),
      JSON.stringify({ type: 'user', content: 'Escaped' }),
    );
    await symlink(outsideGrok, grokLinkDir);

    await expect(
      discoverForeignSessionRows({ source: 'kimi', homeDir: home, workDir }),
    ).resolves.toEqual([]);
    await expect(
      discoverForeignSessionRows({ source: 'grok', homeDir: home, workDir }),
    ).resolves.toEqual([]);
  });

  it('skips malformed records without hiding valid sessions', async () => {
    const valid = join(home, '.claude/projects/project/valid.jsonl');
    const invalid = join(home, '.claude/projects/project/invalid.jsonl');
    await mkdir(join(valid, '..'), { recursive: true });
    await writeFile(
      valid,
      `not json\n${JSON.stringify({
        type: 'user',
        sessionId: 'valid',
        cwd: workDir,
        message: { content: 'Continue safely' },
      })}`,
    );
    await writeFile(invalid, 'not json');

    const rows = await discoverForeignSessionRows({ source: 'claude', homeDir: home });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.external?.id).toBe('valid');
  });

  it('returns no sessions for damaged records across all five sources', async () => {
    const paths = [
      join(home, '.codex/sessions/2026/07/18/rollout-damaged.jsonl'),
      join(home, '.claude/projects/project/damaged.jsonl'),
      join(
        home,
        '.cursor/projects/tmp-wukong-resume-project/agent-transcripts/damaged/damaged.jsonl',
      ),
      join(home, '.kimi-code/session_index.jsonl'),
      join(home, '.grok/sessions/2026-07-22/damaged/summary.json'),
    ];
    await Promise.all(paths.map(async (path) => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'not json');
    }));

    await expect(discoverForeignSessionRows({ homeDir: home, workDir }))
      .resolves.toEqual([]);
  });

  it('filters workspace mismatches across all five sources', async () => {
    const otherWorkDir = '/tmp/another-resume-project';
    const codex = join(home, '.codex/sessions/2026/07/18/rollout-other.jsonl');
    const claude = join(home, '.claude/projects/project/other.jsonl');
    const cursor = join(
      home,
      '.cursor/projects/tmp-another-resume-project/agent-transcripts/other/other.jsonl',
    );
    const kimiDir = join(home, '.kimi-code/sessions/other');
    const grokDir = join(home, '.grok/sessions/2026-07-22/other');
    await Promise.all([
      mkdir(join(codex, '..'), { recursive: true }),
      mkdir(join(claude, '..'), { recursive: true }),
      mkdir(join(cursor, '..'), { recursive: true }),
      mkdir(kimiDir, { recursive: true }),
      mkdir(grokDir, { recursive: true }),
    ]);
    await writeFile(codex, JSON.stringify({
      type: 'session_meta', payload: { id: 'codex-other', cwd: otherWorkDir },
    }));
    await writeFile(claude, JSON.stringify({
      type: 'user', sessionId: 'claude-other', cwd: otherWorkDir,
      message: { content: 'Other Claude task' },
    }));
    await writeFile(cursor, JSON.stringify({
      role: 'user', message: { content: 'Other Cursor task' },
    }));
    await writeFile(join(home, '.kimi-code/session_index.jsonl'), JSON.stringify({
      sessionId: 'kimi-other', sessionDir: kimiDir, workDir: otherWorkDir,
    }));
    await writeFile(join(kimiDir, 'state.json'), JSON.stringify({ lastPrompt: 'Other Kimi task' }));
    await writeFile(join(grokDir, 'summary.json'), JSON.stringify({
      chat_format_version: 1,
      info: { id: 'grok-other', cwd: otherWorkDir },
    }));
    await writeFile(join(grokDir, 'chat_history.jsonl'), JSON.stringify({
      type: 'user', content: 'Other Grok task',
    }));

    await expect(discoverForeignSessionRows({ homeDir: home, workDir }))
      .resolves.toEqual([]);
  });

  it.each(['codex', 'claude', 'cursor', 'kimi', 'grok'] as const)(
    'returns an empty result when %s has no local sessions',
    async (source) => {
      await expect(discoverForeignSessionRows({ source, homeDir: home, workDir }))
        .resolves.toEqual([]);
    },
  );

  it('rejects a transcript symlink that escapes the known source root', async () => {
    const outside = join(home, 'outside.jsonl');
    const linked = join(home, '.codex/sessions/2026/07/18/rollout-linked.jsonl');
    await mkdir(join(linked, '..'), { recursive: true });
    await writeFile(
      outside,
      JSON.stringify({ type: 'session_meta', payload: { id: 'escaped', cwd: workDir } }),
    );
    await symlink(outside, linked);

    const rows = await discoverForeignSessionRows({ source: 'codex', homeDir: home });

    expect(rows).toEqual([]);
  });

  it.each(['claude', 'cursor'] as const)(
    'rejects a %s transcript symlink that escapes its source root',
    async (source) => {
      const outside = join(home, `${source}-outside.jsonl`);
      const linked = source === 'claude'
        ? join(home, '.claude/projects/project/linked.jsonl')
        : join(
            home,
            '.cursor/projects/tmp-wukong-resume-project/agent-transcripts/linked/linked.jsonl',
          );
      await mkdir(join(linked, '..'), { recursive: true });
      await writeFile(outside, source === 'claude'
        ? JSON.stringify({
            type: 'user', sessionId: 'escaped', cwd: workDir,
            message: { content: 'Escaped Claude request' },
          })
        : JSON.stringify({ role: 'user', message: { content: 'Escaped Cursor request' } }));
      await symlink(outside, linked);

      await expect(discoverForeignSessionRows({ source, homeDir: home, workDir }))
        .resolves.toEqual([]);
    },
  );

  it('uses the last request from a large transcript without loading the whole file', async () => {
    const codex = join(home, '.codex/sessions/2026/07/18/rollout-large.jsonl');
    await mkdir(join(codex, '..'), { recursive: true });
    const filler = Array.from({ length: 140 }, (_, index) =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: `step ${String(index)}` } }),
    );
    await writeFile(
      codex,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'large', cwd: workDir } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Initial goal' } }),
        ...filler,
        'malformed tail event',
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Newest unfinished request' } }),
      ].join('\n'),
    );

    const rows = await discoverForeignSessionRows({ source: 'codex', homeDir: home, workDir });

    expect(rows[0]?.title).toBe('Initial goal');
    expect(rows[0]?.last_prompt).toBe('Newest unfinished request');
  });
});
