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

    expect(text).toContain('Gate        PASS');
    expect(text).toContain('Iterations  2');
    expect(text).toContain('Blocker     None');
    expect(text).toContain('Next        Ready to ship.');
    expect(text).not.toContain('loop:PASS');
    expect(text).not.toContain('tokens');
  });

  it('shows only the primary blocker and next action for a Loop that needs work', () => {
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

    expect(text).toBe([
      'Gate        NEEDS_WORK',
      'Iterations  3',
      'Blocker     Auth fixture still fails.',
      'Next        Fix the fixture and continue the Loop.',
    ].join('\n'));
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

    expect(text).toBe([
      'Gate        ERROR',
      'Iterations  4',
      'Blocker     Fresh reviewer reached its dedicated Gate budget.',
      'Next        Retry the Gate with the same contract; if the limit repeats, narrow the review scope or choose a faster reviewer model.',
    ].join('\n'));
    expect(text).not.toContain('wukong doctor');
  });
});
