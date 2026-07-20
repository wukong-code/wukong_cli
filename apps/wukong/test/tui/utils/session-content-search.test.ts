import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBoundedSessionSearchIndex,
  extractUserPromptText,
  SESSION_CONTENT_READ_LIMIT,
  SESSION_CONTENT_SEARCH_LIMIT,
} from '#/tui/utils/session-content-search';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bounded session content search', () => {
  it('indexes only user prompt text', () => {
    const payload = [
      record({ type: 'turn.prompt', input: [{ type: 'text', text: 'keep this request' }], origin: { kind: 'user' } }),
      record({ type: 'turn.prompt', input: [{ type: 'text', text: 'ignore injected' }], origin: { kind: 'injection' } }),
      record({ type: 'context.append_message', message: { role: 'tool', content: 'ignore tool output' } }),
    ].join('\n');

    expect(extractUserPromptText(payload)).toBe('keep this request');
  });

  it('reads a bounded tail from recent main-agent records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wukong-session-search-'));
    cleanup.push(root);
    const sessionDir = join(root, 'session-one');
    const agentDir = join(sessionDir, 'agents', 'main');
    await mkdir(agentDir, { recursive: true });
    const old = record({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old-hidden-prompt' + 'x'.repeat(SESSION_CONTENT_READ_LIMIT) }],
      origin: { kind: 'user' },
    });
    const recent = record({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'recent searchable request' }],
      origin: { kind: 'user' },
    });
    await writeFile(join(agentDir, 'wire.jsonl'), `${old}\n${recent}\n`, 'utf8');

    const index = await buildBoundedSessionSearchIndex([{
      id: 'session-one',
      title: null,
      work_dir: '/workspace',
      updated_at: 2,
      session_dir: sessionDir,
      source: 'wukong',
    }], new AbortController().signal);

    expect(index.get('session-one')).toBe('recent searchable request');
    expect(index.get('session-one')).not.toContain('old-hidden-prompt');
    expect(SESSION_CONTENT_SEARCH_LIMIT).toBe(100);
  });

  it('honors cancellation before scanning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildBoundedSessionSearchIndex([], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

function record(value: unknown): string {
  return JSON.stringify(value);
}
