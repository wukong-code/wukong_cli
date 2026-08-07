import { describe, expect, it } from 'vitest';

import { buildGoalCompletionMessage } from '#/tui/utils/goal-completion';
import type { GoalSnapshot } from '@wukong/wukong-sdk';

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    objective: 'work',
    status: 'complete',
    turnsUsed: 3,
    tokensUsed: 12_500,
    wallClockMs: 260_000,
    terminalReason: 'all tests pass',
    ...overrides,
  } as GoalSnapshot;
}

describe('buildGoalCompletionMessage', () => {
  it('includes the reason, exact turns, tokens, and time', () => {
    const text = buildGoalCompletionMessage(snapshot());
    expect(text).toContain('Goal complete — all tests pass.');
    expect(text).toContain('3 turns');
    expect(text).toContain('12.5k tokens');
    expect(text).toContain('4m20s');
  });

  it('omits the dash when there is no reason and singularizes one turn', () => {
    const text = buildGoalCompletionMessage(
      snapshot({ terminalReason: undefined, turnsUsed: 1, tokensUsed: 800, wallClockMs: 5000 }),
    );
    expect(text).toContain('Goal complete.');
    expect(text).not.toContain('—');
    expect(text).toContain('1 turn ');
    expect(text).toContain('800 tokens');
    expect(text).toContain('5s');
  });

  it('renders the public Loop PASS result without the encoded reason', () => {
    const text = buildGoalCompletionMessage(snapshot({
      terminalReason: 'loop:PASS:passed:Delivery gate passed.',
      loopResult: {
        schemaVersion: 2,
        status: 'PASS',
        reasonCode: 'passed',
        summary: 'Delivery gate passed.',
        iterations: 2,
        checks: [],
        blockers: [],
      },
    }));

    expect(text).toContain('Outcome     PASS');
    expect(text).toContain('Reason      Delivery gate passed.');
    expect(text).toContain('Writer      2 iteration(s)');
    expect(text).toContain('Gate        attempts unavailable');
    expect(text).toContain('Time        4m20s · Writer tokens 12.5k · Reviewer tokens unavailable · Cost unavailable');
    expect(text).toContain('Checks      not run');
    expect(text).toContain('Evidence    verification not_run; reviewer not_run');
    expect(text).toContain('Blockers    0');
    expect(text).toContain('Next        Review the diff');
    expect(text).not.toContain('loop:PASS');
  });

  it('shows exact writer/reviewer calls and remaining token budget', () => {
    const text = buildGoalCompletionMessage(snapshot({
      providerUsage: {
        writerCalls: 3,
        reviewerCalls: 2,
        writerRetries: 1,
        reviewerRetries: 1,
        writerCallLimit: 12,
        reviewerCallLimit: 4,
        remainingWriterCalls: 9,
        remainingReviewerCalls: 2,
      },
      budget: {
        tokenBudget: 50_000,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: 37_500,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'checks_failed',
        summary: 'Checks failed.',
        iterations: 3,
        checks: [],
        blockers: [],
      },
    }));

    expect(text).toContain(
      'Usage       Writer calls 3/12 (9 remaining) · Reviewer calls 2/4 (2 remaining) · Retries 2 · Tokens 12.5k/50.0k (37.5k remaining)',
    );
  });

  it('separates pre-existing, modified, introduced, deleted, and unknown paths', () => {
    const text = buildGoalCompletionMessage(snapshot({
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'checks_failed',
        summary: 'Checks failed.',
        iterations: 2,
        checks: [],
        blockers: [],
        changedFiles: [
          {
            path: 'src/dirty.ts', status: 'M', attribution: 'pre_existing_or_modified',
            preExisting: true,
          },
          {
            path: 'src/modified.ts', status: 'M', attribution: 'modified_by_loop',
            preExisting: true, touchedByLoop: true,
          },
          {
            path: 'src/new.ts', status: '??', attribution: 'introduced_by_loop',
            preExisting: false, touchedByLoop: true,
          },
          {
            path: 'src/deleted.ts', status: 'D', attribution: 'deleted_by_loop',
            preExisting: false, touchedByLoop: true,
          },
          { path: 'src/unknown.ts', status: 'M', attribution: 'unknown' },
        ],
      },
    }));

    expect(text).toContain('M src/dirty.ts [pre-existing; Loop touch unknown]');
    expect(text).toContain('M src/modified.ts [pre-existing; modified by Loop]');
    expect(text).toContain('?? src/new.ts [introduced by Loop]');
    expect(text).toContain('D src/deleted.ts [deleted by Loop]');
    expect(text).toContain('M src/unknown.ts [attribution unavailable]');
  });

  it('shows Gate completeness, freshness, and missing producers', () => {
    const text = buildGoalCompletionMessage(snapshot({
      status: 'blocked',
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'reviewer_invalid',
        summary: 'Reviewer output was invalid.',
        iterations: 1,
        checks: [],
        blockers: [],
        evidence: {
          verification: 'fresh',
          reviewer: 'not_run',
          completeness: 'partial',
          fresh: false,
          expectedProducers: ['required-checks', 'fresh-reviewer', 'workspace-freshness'],
          observedProducers: ['required-checks'],
          missingProducers: ['fresh-reviewer', 'workspace-freshness'],
        },
      },
    }));

    expect(text).toContain(
      'Evidence    completeness partial; fresh no; verification fresh; reviewer not_run; missing fresh-reviewer, workspace-freshness',
    );
    expect(text).toContain(
      'Unverified  Missing Gate producers: fresh-reviewer, workspace-freshness.',
    );
  });

  it('shows a blocker and its fix for a Loop that needs work', () => {
    const text = buildGoalCompletionMessage(snapshot({
      status: 'blocked',
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'checks_failed',
        summary: 'Checks failed.',
        iterations: 3,
        checks: [],
        blockers: [{
          id: 'test_failed',
          kind: 'check',
          summary: 'Auth fixture still fails.',
          nextAction: 'Fix the fixture and continue the Loop.',
        }],
      },
    }));

    expect(text).toContain('Outcome     NEEDS_WORK');
    expect(text).toContain('Reason      Checks failed.');
    expect(text).toContain('Writer      3 iteration(s)');
    expect(text).toContain('Blockers    1');
    expect(text).toContain('Blocker 1   Auth fixture still fails.');
    expect(text).toContain('Fix       Fix the fixture and continue the Loop.');
    expect(text).toContain('Next        Fix the fixture and continue the Loop.');
  });

  it('shows reviewer-specific recovery instead of a doctor hint when the Gate budget is exhausted', () => {
    const text = buildGoalCompletionMessage(snapshot({
      status: 'blocked',
      loopResult: {
        schemaVersion: 2,
        status: 'ERROR',
        reasonCode: 'reviewer_limit_exceeded',
        summary: 'Fresh reviewer reached its dedicated Gate budget.',
        iterations: 4,
        checks: [],
        blockers: [],
      },
    }));

    expect(text).toContain('Outcome     ERROR');
    expect(text).toContain('Writer      4 iteration(s)');
    expect(text).toContain('Blockers    0');
    expect(text).toContain('Next        Retry the Gate with the same contract; if the limit repeats, narrow the review scope or choose a faster reviewer model.');
    expect(text).not.toContain('wukong doctor');
  });

  it('shows three blockers, the overflow count, and the durable same-contract next action', () => {
    const text = buildGoalCompletionMessage(snapshot({
      status: 'blocked',
      loopRunId: 'run-current',
      gateAttempts: 2,
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-current',
        contractId: 'contract-1',
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        continuationPolicy: {
          mode: 'same-contract',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: ['one', 'two', 'three', 'four'],
        terminalDigest: 'terminal-digest',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'max_iterations',
        summary: 'Iteration ceiling reached.',
        iterations: 4,
        checks: [],
        blockers: [
          { id: 'one', kind: 'check', summary: 'First blocker.', nextAction: 'Fix first.' },
          { id: 'two', kind: 'review', summary: 'Second blocker.', nextAction: 'Fix second.' },
          { id: 'three', kind: 'workspace', summary: 'Third blocker.', nextAction: 'Fix third.' },
          { id: 'four', kind: 'risk', summary: 'Fourth blocker.', nextAction: 'Fix fourth.' },
        ],
      },
    }));

    expect(text).toContain('Gate        2 attempt(s)');
    expect(text).toContain('Blockers    4');
    expect(text).toContain('Blocker 1   First blocker.');
    expect(text).toContain('Blocker 2   Second blocker.');
    expect(text).toContain('Blocker 3   Third blocker.');
    expect(text).not.toContain('Fourth blocker.');
    expect(text).toContain('More      1 additional blocker(s)');
    expect(text).toContain('Continue    same-contract');
    expect(text).toContain('Next        Address every blocker, then run `/loop resume`');
  });

  it('does not offer resume when the durable continuation policy is blocked', () => {
    const text = buildGoalCompletionMessage(snapshot({
      status: 'blocked',
      loopRunId: 'run-current',
      loopTerminal: {
        schemaVersion: 1,
        runId: 'run-current',
        contractId: 'contract-1',
        status: 'ERROR',
        reasonCode: 'runtime_error',
        continuationPolicy: {
          mode: 'blocked',
          automaticRetry: false,
          requiresPreflightRevalidation: true,
        },
        blockerKeys: ['runtime'],
        terminalDigest: 'terminal-digest',
        createdAt: 1,
      },
      loopResult: {
        schemaVersion: 2,
        status: 'ERROR',
        reasonCode: 'runtime_error',
        summary: 'Runtime state is not recoverable.',
        iterations: 1,
        checks: [],
        blockers: [{
          id: 'runtime',
          kind: 'workspace',
          summary: 'Runtime state is not recoverable.',
          nextAction: 'Unsafe legacy hint: resume.',
        }],
      },
    }));

    expect(text).toContain('Continue    blocked');
    expect(text).toContain('Next        This run cannot resume; cancel it or start an explicitly revised/new Loop.');
    expect(text).not.toContain('Next        Unsafe legacy hint: resume.');
    expect(text).not.toContain('/loop resume');
  });
});
