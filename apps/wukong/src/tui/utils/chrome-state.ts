/**
 * In-process aggregator for loop-driven chrome state.
 *
 * Combines the live GoalSnapshot with recent verify/scan/proof/guard events to
 * produce the heartbeat line and footer conclusion tracks. It is refreshed on
 * events (goal.updated, gate completion) and reads the stats file only once at
 * startup — never per frame.
 */

import type { GoalSnapshot } from '@wukong/wukong-sdk';

import {
  buildTodayBriefing,
  readStatsEvents,
  recordStatEvent,
  type StatEvent,
  type TodayBriefing,
} from '#/utils/stats';
import { loopNextAction, parseLoopTerminalReason } from '#/utils/loop-result';

import type { LoopPhaseState } from '../components/chrome/loop-phase';

export interface VerifySummary {
  readonly status: 'passed' | 'failed';
  readonly detail?: string;
  readonly timestamp: number;
}

export interface ProofSummary {
  readonly status: 'pass' | 'blocked';
  readonly summary: string;
  readonly timestamp: number;
}

export type UIMode = 'idle' | 'active' | 'blocked';

export interface ChromeState {
  readonly uiMode: UIMode;
  readonly loopPhase: LoopPhaseState | null;
  readonly goal: GoalSnapshot | null;
  readonly lastVerify: VerifySummary | null;
  readonly lastProof: ProofSummary | null;
  readonly todayBriefing: TodayBriefing | null;
}

export interface ChromeStateOptions {
  readonly cwd: string;
  /**
   * Optional initial goal snapshot, e.g. from session.getGoal() during startup.
   */
  readonly initialGoal?: GoalSnapshot | null;
  /**
   * Optional override for reading stats events (used in tests).
   */
  readonly readStatsEvents?: () => StatEvent[];
  /**
   * Optional override for recording stats events (used in tests).
   */
  readonly recordStatEvent?: (event: StatEvent) => void;
  /**
   * Optional override for building the today briefing (used in tests).
   */
  readonly buildTodayBriefing?: (options: { cwd: string }) => Promise<TodayBriefing>;
}

export class ChromeStateAggregator {
  private goal: GoalSnapshot | null = null;
  private lastVerify: VerifySummary | null = null;
  private lastProof: ProofSummary | null = null;
  private todayBriefing: TodayBriefing | null = null;
  private readonly cwd: string;
  private readonly readStatsEventsFn: () => StatEvent[];
  private readonly recordStatEventFn: (event: StatEvent) => void;
  private readonly buildTodayBriefingFn: (options: { cwd: string }) => Promise<TodayBriefing>;

  constructor(options: ChromeStateOptions) {
    this.cwd = options.cwd;
    this.readStatsEventsFn = options.readStatsEvents ?? readStatsEvents;
    this.recordStatEventFn = options.recordStatEvent ?? recordStatEvent;
    this.buildTodayBriefingFn =
      options.buildTodayBriefing ?? ((opts) => buildTodayBriefing({ cwd: opts.cwd }));
    if (options.initialGoal !== undefined) {
      this.goal = options.initialGoal ?? null;
    }
  }

  /**
   * Hydrate from the stats file once at startup. Called after construction so
   * the caller can decide whether to await it.
   */
  async hydrate(): Promise<void> {
    try {
      // readStatsEvents returns newest-first; keep only the latest verify/proof.
      this.hydrateFromEvents(this.readStatsEventsFn());
    } catch {
      // Stats read failures are non-fatal; chrome starts empty.
    }
    try {
      this.todayBriefing = await this.buildTodayBriefingFn({ cwd: this.cwd });
    } catch {
      // Failure to build the briefing is non-fatal; chrome will show minimal info.
    }
  }

  private hydrateFromEvents(events: StatEvent[]): void {
    let foundVerify = false;
    let foundProof = false;
    for (const event of events) {
      if (event.type === 'verify' && !foundVerify) {
        this.applyEvent(event);
        foundVerify = true;
      } else if (event.type === 'proof' && !foundProof) {
        this.applyEvent(event);
        foundProof = true;
      }
      if (foundVerify && foundProof) break;
    }
  }

  setGoal(goal: GoalSnapshot | null): void {
    const previousGoalId = this.goal?.goalId;
    const nextGoalId = goal?.goalId;
    if (nextGoalId !== undefined && nextGoalId !== previousGoalId) {
      // Evidence belongs to a single Loop. Do not present yesterday's or a
      // previous goal's failure as the status of a newly started goal.
      this.lastVerify = null;
      this.lastProof = null;
    }
    this.goal = goal ?? null;
  }

  recordVerify(status: 'passed' | 'failed', detail?: string): void {
    const event: StatEvent = {
      type: 'verify',
      status,
      timestamp: new Date().toISOString(),
      date: localDateString(),
      cwd: this.cwd,
    };
    this.recordStatEventFn(event);
    this.lastVerify = { status, detail, timestamp: Date.now() };
  }

  recordProof(status: 'pass' | 'blocked', summary: string): void {
    const event: StatEvent = {
      type: 'proof',
      status,
      summary,
      timestamp: new Date().toISOString(),
      date: localDateString(),
      cwd: this.cwd,
    };
    this.recordStatEventFn(event);
    this.lastProof = { status, summary, timestamp: Date.now() };
  }

  recordScan(status: 'passed' | 'failed'): void {
    this.recordStatEventFn({
      type: 'scan',
      status,
      timestamp: new Date().toISOString(),
      date: localDateString(),
      cwd: this.cwd,
    });
  }

  recordGuard(blocked: boolean): void {
    this.recordStatEventFn({
      type: 'guard',
      blocked,
      timestamp: new Date().toISOString(),
      date: localDateString(),
      cwd: this.cwd,
    });
  }

  recordGoal(status: 'complete' | 'blocked' | 'paused'): void {
    this.recordStatEventFn({
      type: 'goal',
      status,
      timestamp: new Date().toISOString(),
      date: localDateString(),
      cwd: this.cwd,
    });
  }

  setTodayBriefing(briefing: TodayBriefing | null): void {
    this.todayBriefing = briefing;
  }

  getState(): ChromeState {
    const uiMode = this.deriveUiMode();
    return {
      uiMode,
      loopPhase: this.buildLoopPhase(uiMode),
      goal: this.goal,
      lastVerify: this.lastVerify,
      lastProof: this.lastProof,
      todayBriefing: this.todayBriefing,
    };
  }

  private deriveUiMode(): UIMode {
    if (this.goal === null) return 'idle';
    if (this.goal.status === 'blocked') return 'blocked';
    if (this.goal.status === 'active' || this.goal.status === 'paused') return 'active';
    return 'idle';
  }

  private buildLoopPhase(uiMode: UIMode): LoopPhaseState | null {
    if (uiMode === 'idle') return null;

    const goal = this.goal!;
    const isBlocked = uiMode === 'blocked';
    const loop = parseLoopTerminalReason(goal.terminalReason);

    let phase: LoopPhaseState['phase'] = 'waiting';
    if (isBlocked) {
      phase = 'blocked';
    } else if (goal.status === 'paused') {
      phase = 'paused';
    } else if (goal.stopCondition === 'proof-pass') {
      phase = this.lastProof?.status === 'blocked' ? 'writing' : 'verifying';
    } else if (goal.stopCondition === 'verify-pass') {
      phase = this.lastVerify?.status === 'failed' ? 'writing' : 'verifying';
    } else if (goal.stopCondition === 'scan-clean') {
      phase = 'verifying';
    } else if (goal.stopCondition === 'judge-pass') {
      phase = 'judging';
    }

    return {
      phase,
      iteration: goal.iteration,
      maxIterations: goal.maxIterations,
      // GoalSnapshot.wallClockMs is already live for active goals (agent-core
      // liveWallClockMs); do not add a second local elapsed delta.
      elapsedMs: goal.wallClockMs,
      blockedReason: isBlocked
        ? this.lastVerify?.detail ?? loop?.summary ?? goal.terminalReason ?? undefined
        : undefined,
      objective: goal.objective,
      nextAction: isBlocked ? this.blockedNextAction() : undefined,
      warning: isBlocked,
    };
  }

  private blockedNextAction(): string {
    const loop = parseLoopTerminalReason(this.goal?.terminalReason);
    if (loop !== null) return loopNextAction(loop.reasonCode);
    if (this.lastProof?.status === 'blocked') return 'review proof blockers';
    if (this.lastVerify?.status === 'failed') return 'inspect failures or steer';
    return '/goal resume or /loop stop';
  }

  private applyEvent(event: StatEvent): void {
    switch (event.type) {
      case 'verify':
        this.lastVerify = {
          status: event.status,
          timestamp: new Date(event.timestamp).getTime(),
        };
        break;
      case 'proof':
        this.lastProof = {
          status: event.status,
          summary: event.summary,
          timestamp: new Date(event.timestamp).getTime(),
        };
        break;
      case 'goal':
      case 'guard':
      case 'scan':
        break;
    }
  }
}

function localDateString(date = new Date()): string {
  return date.toLocaleDateString('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}
