import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

export const SESSION_CONTENT_SEARCH_LIMIT = 100;
export const SESSION_CONTENT_READ_LIMIT = 128 * 1024;

/** Build a local-only search corpus from bounded main-agent user prompts. */
export async function buildBoundedSessionSearchIndex(
  rows: readonly SessionRow[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  signal.throwIfAborted();
  const candidates = rows
    .filter((row) => row.source === 'wukong' && row.session_dir !== undefined)
    .toSorted((left, right) => right.updated_at - left.updated_at)
    .slice(0, SESSION_CONTENT_SEARCH_LIMIT);
  const result = new Map<string, string>();

  for (let offset = 0; offset < candidates.length; offset += 8) {
    signal.throwIfAborted();
    const batch = candidates.slice(offset, offset + 8);
    const values = await Promise.all(batch.map(async (row) => ({
      id: row.id,
      text: await readUserPromptTail(row.session_dir!, signal),
    })));
    for (const value of values) {
      if (value.text.length > 0) result.set(value.id, value.text);
    }
  }
  return result;
}

async function readUserPromptTail(sessionDir: string, signal: AbortSignal): Promise<string> {
  const path = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const size = (await file.stat()).size;
    const length = Math.min(size, SESSION_CONTENT_READ_LIMIT);
    if (length <= 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    const position = Math.max(0, size - length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    signal.throwIfAborted();
    let payload = buffer.subarray(0, bytesRead).toString('utf8');
    if (position > 0) {
      const firstNewline = payload.indexOf('\n');
      payload = firstNewline === -1 ? '' : payload.slice(firstNewline + 1);
    }
    return extractUserPromptText(payload);
  } catch (error) {
    if (signal.aborted) throw error;
    return '';
  } finally {
    await file?.close().catch(() => {});
  }
}

export function extractUserPromptText(payload: string): string {
  const prompts: string[] = [];
  for (const line of payload.split('\n')) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record['type'] !== 'turn.prompt') continue;
    const origin = record['origin'];
    if (!isRecord(origin) || origin['kind'] !== 'user') continue;
    const input = record['input'];
    if (!Array.isArray(input)) continue;
    for (const part of input) {
      if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') continue;
      const sanitized = sanitizeUserPrompt(part['text']);
      if (sanitized.length > 0) prompts.push(sanitized);
    }
  }
  return prompts.join(' ');
}

function sanitizeUserPrompt(text: string): string {
  return text
    .replaceAll(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replaceAll(/<image[\s\S]*?<\/image>/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
