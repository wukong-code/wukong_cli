/**
 * Local stats event stream and Local Loop Briefing builder.
 *
 * This module is intentionally scoped to the CLI app. If the event model grows
 * (hosted sync, richer schemas), it can be extracted into a package.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { inspectGit } from '@wukong/verification';

import { getStatsEventsFile, getTodayFocusFile } from '#/utils/paths';

export type StatEvent =
  | VerifyStatEvent
  | ScanStatEvent
  | ProofStatEvent
  | GuardStatEvent
  | GoalStatEvent;

interface BaseStatEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly date: string;
  readonly cwd: string;
}

export interface VerifyStatEvent extends BaseStatEvent {
  readonly type: 'verify';
  readonly status: 'passed' | 'failed';
}

export interface ScanStatEvent extends BaseStatEvent {
  readonly type: 'scan';
  readonly status: 'passed' | 'failed';
}

export interface ProofStatEvent extends BaseStatEvent {
  readonly type: 'proof';
  readonly status: 'pass' | 'blocked';
  readonly summary: string;
}

export interface GuardStatEvent extends BaseStatEvent {
  readonly type: 'guard';
  readonly blocked: boolean;
}

export interface GoalStatEvent extends BaseStatEvent {
  readonly type: 'goal';
  readonly status: 'complete' | 'blocked' | 'paused';
}

export interface TodayFocus {
  readonly text: string;
  readonly setAt: string;
  readonly workspace: string;
}

export interface TodayBriefing {
  readonly date: string;
  readonly focus: string | null;
  readonly workspace: { readonly cwd: string; readonly changedFiles: number };
  readonly today: {
    readonly verify: { readonly runs: number; readonly passed: number; readonly failed: number };
    readonly scan: { readonly runs: number; readonly blocked: number };
    readonly proof: { readonly runs: number; readonly lastStatus?: 'pass' | 'blocked' };
    readonly guard: { readonly blocked: number; readonly allowed: number };
    readonly goals: { readonly completed: number; readonly inProgress: number };
  };
  readonly lastProof?: { readonly status: 'pass' | 'blocked'; readonly summary: string };
  readonly streak: number;
  readonly next: string[];
}

export interface BuildTodayBriefingOptions {
  readonly cwd: string;
  readonly date?: string;
}

/**
 * Append a stats event to `~/.wukong/stats/events.jsonl`.
 */
export function recordStatEvent(event: StatEvent): void {
  const file = getStatsEventsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

/**
 * Read all recorded stats events, newest first.
 */
export function readStatsEvents(): StatEvent[] {
  const file = getStatsEventsFile();
  try {
    const raw = readFileSync(file, 'utf8');
    const events: StatEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as StatEvent);
      } catch {
        // Ignore corrupt lines so a single bad event does not break the briefing.
      }
    }
    return events.toReversed();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function readTodayFocus(): TodayFocus | null {
  try {
    const raw = readFileSync(getTodayFocusFile(), 'utf8');
    return JSON.parse(raw) as TodayFocus;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export function writeTodayFocus(focus: TodayFocus): void {
  const file = getTodayFocusFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(focus, null, 2)}\n`);
}

export function clearTodayFocus(): void {
  try {
    writeFileSync(getTodayFocusFile(), '{}\n');
  } catch {
    // If the file cannot be written, treat focus as cleared.
  }
}

export function localDateString(date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

export function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

export async function buildTodayBriefing(options: BuildTodayBriefingOptions): Promise<TodayBriefing> {
  const date = options.date ?? localDateString();
  const cwd = options.cwd;
  const git = await inspectGit(cwd);
  const focus = readTodayFocus();
  const events = readStatsEvents();

  const todayEvents = events.filter((event) => event.date === date);
  const today = {
    verify: countVerify(todayEvents),
    scan: countScan(todayEvents),
    proof: countProof(todayEvents),
    guard: countGuard(todayEvents),
    goals: countGoals(todayEvents),
  };

  const lastProofEvent = events.find((event): event is ProofStatEvent => event.type === 'proof');

  const briefing: TodayBriefing = {
    date,
    focus: focus?.text ?? null,
    workspace: {
      cwd,
      changedFiles: git.changedFiles.length,
    },
    today,
    lastProof: lastProofEvent
      ? {
          status: lastProofEvent.status,
          summary: lastProofEvent.summary,
        }
      : undefined,
    streak: computeStreak(events),
    next: buildNext({ today, lastProof: lastProofEvent, changedFiles: git.changedFiles.length, focus: focus?.text }),
  };

  return briefing;
}

function countVerify(events: StatEvent[]) {
  const relevant = events.filter((event): event is VerifyStatEvent => event.type === 'verify');
  return {
    runs: relevant.length,
    passed: relevant.filter((event) => event.status === 'passed').length,
    failed: relevant.filter((event) => event.status === 'failed').length,
  };
}

function countScan(events: StatEvent[]) {
  const relevant = events.filter((event): event is ScanStatEvent => event.type === 'scan');
  return {
    runs: relevant.length,
    blocked: relevant.filter((event) => event.status === 'failed').length,
  };
}

function countProof(events: StatEvent[]) {
  const relevant = events.filter((event): event is ProofStatEvent => event.type === 'proof');
  const last = relevant[0];
  return {
    runs: relevant.length,
    lastStatus: last?.status,
  };
}

function countGuard(events: StatEvent[]) {
  const relevant = events.filter((event): event is GuardStatEvent => event.type === 'guard');
  return {
    blocked: relevant.filter((event) => event.blocked).length,
    allowed: relevant.filter((event) => !event.blocked).length,
  };
}

function countGoals(events: StatEvent[]) {
  const relevant = events.filter((event): event is GoalStatEvent => event.type === 'goal');
  return {
    completed: relevant.filter((event) => event.status === 'complete').length,
    inProgress: 0,
  };
}

function computeStreak(events: StatEvent[]): number {
  const datesWithCleanVerify = new Set<string>();
  for (const event of events) {
    if (event.type === 'verify' && event.status === 'passed') {
      datesWithCleanVerify.add(event.date);
    }
  }

  const today = localDateString();
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const date = offsetDate(today, -i);
    if (datesWithCleanVerify.has(date)) {
      streak += 1;
    } else if (i === 0) {
      // If today has no clean verify yet, do not break the streak; just skip counting today.
      continue;
    } else {
      break;
    }
  }
  return streak;
}

function offsetDate(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year!, month! - 1, day! + days);
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

interface NextInputs {
  readonly today: TodayBriefing['today'];
  readonly lastProof?: ProofStatEvent;
  readonly changedFiles: number;
  readonly focus?: string;
}

function buildNext(inputs: NextInputs): string[] {
  const next: string[] = [];
  if (inputs.lastProof?.status === 'blocked' || inputs.today.proof.lastStatus === 'blocked') {
    next.push('/loop fix the blocked change');
  }
  if (inputs.today.verify.failed > 0) {
    next.push('/loop fix the failing checks');
  }
  if (next.length === 0 && inputs.changedFiles > 0) {
    next.push('/loop finish the current change');
  }
  if (next.length === 0 && inputs.focus !== undefined && inputs.focus.length > 0) {
    next.push(`/loop ${inputs.focus}`);
  }
  if (next.length === 0) {
    next.push('/loop <goal>');
  }
  return next.slice(0, 2);
}
