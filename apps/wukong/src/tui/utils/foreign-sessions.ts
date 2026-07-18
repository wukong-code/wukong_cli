import { glob, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

import type { SessionRow, SessionSource } from '#/tui/components/dialogs/session-picker';

const MAX_HEADER_LINES = 80;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_FILES_PER_SOURCE = 500;
const MAX_TAIL_BYTES = 512 * 1024;

interface ForeignSessionCandidate {
  readonly source: Exclude<SessionSource, 'wukong'>;
  readonly sourcePath: string;
  readonly sourceRoot: string;
  readonly id: string;
  readonly workDir: string;
}

export async function discoverForeignSessionRows(options: {
  readonly source?: Exclude<SessionSource, 'wukong'>;
  readonly workDir?: string;
  readonly homeDir?: string;
}): Promise<SessionRow[]> {
  const home = options.homeDir ?? homedir();
  const sources =
    options.source === undefined ? (['codex', 'claude', 'cursor'] as const) : [options.source];
  const groups = await Promise.all(
    sources.map((source) => discoverSource(source, home, options.workDir)),
  );
  const rows = (await Promise.all(groups.flat().map(readCandidate))).filter(
    (row): row is SessionRow => row !== undefined,
  );
  return rows.toSorted((left, right) => right.updated_at - left.updated_at);
}

async function discoverSource(
  source: Exclude<SessionSource, 'wukong'>,
  home: string,
  workDir: string | undefined,
): Promise<ForeignSessionCandidate[]> {
  switch (source) {
    case 'codex':
      return discoverCodex(home, workDir);
    case 'claude':
      return discoverClaude(home, workDir);
    case 'cursor':
      return discoverCursor(home, workDir);
  }
}

async function discoverCodex(
  home: string,
  workDir: string | undefined,
): Promise<ForeignSessionCandidate[]> {
  const files = await collectGlob(join(home, '.codex/sessions/**/rollout-*.jsonl'));
  const sourceRoot = join(home, '.codex/sessions');
  const candidates = await Promise.all(
    files.map(async (sourcePath) => {
      const first = await firstJsonObject(sourcePath);
      if (first?.['type'] !== 'session_meta') return undefined;
      const payload = asRecord(first['payload']);
      const id = stringValue(payload?.['id']) ?? stringValue(payload?.['session_id']);
      const cwd = stringValue(payload?.['cwd']);
      if (id === undefined || cwd === undefined || !sameOptionalWorkDir(cwd, workDir)) {
        return undefined;
      }
      return { source: 'codex' as const, sourcePath, sourceRoot, id, workDir: cwd };
    }),
  );
  return candidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined,
  );
}

async function discoverClaude(
  home: string,
  workDir: string | undefined,
): Promise<ForeignSessionCandidate[]> {
  const files = await collectGlob(join(home, '.claude/projects/*/*.jsonl'));
  const sourceRoot = join(home, '.claude/projects');
  const candidates = await Promise.all(
    files.map(async (sourcePath) => {
      const records = await firstJsonObjects(sourcePath);
      const record = records.find(
        (item) =>
          stringValue(item['sessionId']) !== undefined && stringValue(item['cwd']) !== undefined,
      );
      const id = stringValue(record?.['sessionId']) ?? basename(sourcePath, '.jsonl');
      const cwd = stringValue(record?.['cwd']);
      if (cwd === undefined || !sameOptionalWorkDir(cwd, workDir)) return undefined;
      return { source: 'claude' as const, sourcePath, sourceRoot, id, workDir: cwd };
    }),
  );
  return candidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined,
  );
}

async function discoverCursor(
  home: string,
  workDir: string | undefined,
): Promise<ForeignSessionCandidate[]> {
  const files = await collectGlob(join(home, '.cursor/projects/*/agent-transcripts/*/*.jsonl'));
  const sourceRoot = join(home, '.cursor/projects');
  const wantedProject = workDir === undefined ? undefined : encodeCursorProject(workDir);
  const discovered = await Promise.all(files.map(async (sourcePath) => {
    const transcriptDir = dirname(sourcePath);
    if (basename(sourcePath, '.jsonl') !== basename(transcriptDir)) return undefined;
    const projectDir = basename(dirname(dirname(transcriptDir)));
    if (wantedProject !== undefined && projectDir !== wantedProject) return undefined;
    const resolvedWorkDir = workDir ?? (await decodeCursorProject(projectDir));
    if (resolvedWorkDir === undefined) return undefined;
    return {
      source: 'cursor' as const,
      sourcePath,
      sourceRoot,
      id: basename(sourcePath, '.jsonl'),
      workDir: resolvedWorkDir,
    };
  }));
  return discovered.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined,
  );
}

async function readCandidate(candidate: ForeignSessionCandidate): Promise<SessionRow | undefined> {
  try {
    const [safeSourcePath, safeSourceRoot] = await Promise.all([
      realpath(candidate.sourcePath),
      realpath(candidate.sourceRoot),
    ]);
    const sourceRelative = relative(safeSourceRoot, safeSourcePath);
    if (
      sourceRelative.length === 0 ||
      sourceRelative === '..' ||
      sourceRelative.startsWith('../') ||
      isAbsolute(sourceRelative)
    ) {
      return undefined;
    }
    const fileStat = await stat(safeSourcePath);
    const [headRecords, tailRecords] = await Promise.all([
      firstJsonObjects(safeSourcePath),
      lastJsonObjects(safeSourcePath, fileStat.size),
    ]);
    const records = [...headRecords, ...tailRecords];
    const title =
      findTitle(candidate.source, records) ?? `${displaySource(candidate.source)} session`;
    return {
      id: `external:${candidate.source}:${candidate.id}`,
      title,
      last_prompt: findLastPrompt(candidate.source, records),
      work_dir: candidate.workDir,
      updated_at: fileStat.mtimeMs,
      source: candidate.source,
      external: {
        id: candidate.id,
        sourcePath: safeSourcePath,
      },
    };
  } catch {
    return undefined;
  }
}

function findTitle(
  source: ForeignSessionCandidate['source'],
  records: readonly Record<string, unknown>[],
): string | undefined {
  if (source === 'claude') {
    const aiTitle = records.map((item) => stringValue(item['aiTitle'])).find(Boolean);
    if (aiTitle !== undefined) return singleLine(aiTitle);
  }
  return records
    .map((item) => userText(source, item))
    .find((text) => text !== undefined && text.length > 0);
}

function findLastPrompt(
  source: ForeignSessionCandidate['source'],
  records: readonly Record<string, unknown>[],
): string | null {
  return (
    records
      .toReversed()
      .map((item) => userText(source, item))
      .find((text): text is string => text !== undefined && text.length > 0) ?? null
  );
}

function userText(
  source: ForeignSessionCandidate['source'],
  record: Record<string, unknown>,
): string | undefined {
  if (source === 'codex') {
    const payload = asRecord(record['payload']);
    if (record['type'] === 'event_msg' && payload?.['type'] === 'user_message') {
      return contentText(payload['message']);
    }
    if (
      record['type'] !== 'response_item' ||
      payload?.['role'] !== 'user' ||
      payload['type'] !== 'message'
    ) {
      return undefined;
    }
    return contentText(payload['content']);
  }
  if (source === 'claude') {
    if (record['type'] !== 'user') return undefined;
    return contentText(asRecord(record['message'])?.['content']);
  }
  if (record['role'] !== 'user') return undefined;
  return contentText(asRecord(record['message'])?.['content']);
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanPrompt(value);
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      const record = asRecord(part);
      return stringValue(record?.['text']) ?? stringValue(record?.['content']);
    })
    .filter((item): item is string => item !== undefined)
    .join(' ');
  return cleanPrompt(text);
}

function cleanPrompt(value: string): string | undefined {
  const requestMarker = '## My request for Codex:';
  const requestIndex = value.lastIndexOf(requestMarker);
  const candidate = requestIndex >= 0 ? value.slice(requestIndex + requestMarker.length) : value;
  const text = singleLine(candidate).replace(/^<[^>]+>.*?<\/[^>]+>\s*/u, '').trim();
  if (isSyntheticPrompt(text)) return undefined;
  return text.length > 0 ? text.slice(0, 240) : undefined;
}

function isSyntheticPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    '# agents.md instructions',
    '<action>',
    '<app-context',
    '<collaboration_mode',
    '<environment_context',
    '<instructions',
    '<multi_agent_mode',
    '<permissions instructions',
    '<user_action',
  ].some((prefix) => lower.startsWith(prefix));
}

async function collectGlob(pattern: string): Promise<string[]> {
  try {
    const files: string[] = [];
    for await (const file of glob(pattern)) {
      files.push(file);
      if (files.length >= MAX_FILES_PER_SOURCE) break;
    }
    return files;
  } catch {
    return [];
  }
}

async function firstJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  return (await firstJsonObjects(path, 1))[0];
}

async function firstJsonObjects(
  path: string,
  limit = MAX_HEADER_LINES,
): Promise<Record<string, unknown>[]> {
  const handle = await open(path, 'r');
  const rows: Record<string, unknown>[] = [];
  try {
    for await (const line of handle.readLines()) {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const record = asRecord(parsed);
        if (record !== undefined) rows.push(record);
      } catch {
        // A malformed event does not hide the rest of the local transcript.
      }
      if (rows.length >= limit) break;
    }
  } finally {
    await handle.close();
  }
  return rows;
}

async function lastJsonObjects(
  path: string,
  fileSize: number,
  limit = MAX_HEADER_LINES,
): Promise<Record<string, unknown>[]> {
  if (fileSize <= 0) return [];
  const length = Math.min(fileSize, MAX_TAIL_BYTES);
  const position = Math.max(0, fileSize - length);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split(/\r?\n/u);
    if (position > 0) lines.shift();
    const rows: Record<string, unknown>[] = [];
    for (const line of lines.toReversed()) {
      if (rows.length >= limit) break;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      try {
        const record = asRecord(JSON.parse(line) as unknown);
        if (record !== undefined) rows.push(record);
      } catch {
        // Tail corruption is isolated to the malformed event.
      }
    }
    return rows.toReversed();
  } finally {
    await handle.close();
  }
}

function sameOptionalWorkDir(candidate: string, requested: string | undefined): boolean {
  return requested === undefined || resolve(candidate) === resolve(requested);
}

function encodeCursorProject(workDir: string): string {
  return resolve(workDir).replace(/^\/+/, '').replaceAll('/', '-');
}

/**
 * Cursor stores a workspace path by replacing separators with hyphens. Because
 * real directory names can also contain hyphens, decoding by string replacement
 * is unsafe. Walk only existing path segments and return a complete match.
 */
async function decodeCursorProject(encoded: string): Promise<string | undefined> {
  const parts = encoded.split('-').filter(Boolean);
  if (parts.length === 0 || parts.length > 80) return undefined;
  const memo = new Map<string, string | undefined>();

  const visit = async (parent: string, index: number): Promise<string | undefined> => {
    if (index === parts.length) return parent;
    const memoKey = `${parent}\0${String(index)}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    for (let end = index + 1; end <= parts.length; end++) {
      const candidate = join(parent, parts.slice(index, end).join('-'));
      try {
        if (!(await stat(candidate)).isDirectory()) continue;
      } catch {
        continue;
      }
      const resolved = await visit(candidate, end);
      if (resolved !== undefined) {
        memo.set(memoKey, resolved);
        return resolved;
      }
    }
    memo.set(memoKey, undefined);
    return undefined;
  };

  return visit('/', 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function displaySource(source: ForeignSessionCandidate['source']): string {
  return source === 'claude' ? 'Claude Code' : source === 'codex' ? 'Codex' : 'Cursor';
}
