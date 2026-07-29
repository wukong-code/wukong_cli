import { describe, expect, it } from 'vitest';

import {
  adoptBootstrapJournalOwnership,
  appendBootstrapStepEvent,
  canonicalDigest,
  createBootstrapExecutionJournal,
  validateBootstrapExecutionEvent,
  validateBootstrapExecutionJournal,
  validateBootstrapExecutionJournalTransition,
} from '../src';

const JOURNAL_ID = '019f8bc0-0000-7abc-8def-0123456789ab';
const LEASE_ID = '019f8bc0-0001-7abc-8def-0123456789ab';
const RESERVATION_ID = '019f8bc0-0002-7abc-8def-0123456789ab';

function digest(label: string): string {
  return canonicalDigest('wukong/test/bootstrap-journal/v1', label);
}

function journal() {
  return createBootstrapExecutionJournal({
    journalId: JOURNAL_ID,
    bootstrapPlanDigest: digest('plan'),
    leaseId: LEASE_ID,
    worktreeFencingTokenDigest: digest('fencing-1'),
  });
}

function stepInput(
  eventId: string,
  eventType: 'prepared' | 'started' | 'observed' | 'reconciled' | 'failed',
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId,
    eventType,
    worktreeFencingTokenDigest: digest('fencing-1'),
    stepId: 'step_1',
    reservationId: RESERVATION_ID,
    argvDigest: digest('argv'),
    effectiveEnvironmentDigest: digest('environment'),
    idempotencyKey: `${eventType}_step_1`,
    ...overrides,
  };
}

describe('BootstrapExecutionJournalV1', () => {
  it('records prepared, started and observed before returning ready', () => {
    const initial = journal();
    const prepared = appendBootstrapStepEvent(
      initial,
      stepInput(
        '019f8bc0-0010-7abc-8def-0123456789ab',
        'prepared',
      ),
    );
    const started = appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0011-7abc-8def-0123456789ab',
        'started',
      ),
    );
    const observed = appendBootstrapStepEvent(
      started.journal,
      stepInput(
        '019f8bc0-0012-7abc-8def-0123456789ab',
        'observed',
        {
          generatedScopeFingerprint: digest('generated'),
          exitCode: 0,
        },
      ),
    );

    expect(prepared.journal).toMatchObject({
      state: 'step_prepared',
      activeStepId: 'step_1',
    });
    expect(started.journal.state).toBe('step_running');
    expect(observed.journal).toMatchObject({
      state: 'ready',
      activeStepId: null,
    });
    expect(validateBootstrapExecutionJournalTransition(
      started.journal,
      observed.event,
      observed.journal,
    )).toBe(true);
  });

  it('allows same-owner reconciliation of a prepared or running step', () => {
    const prepared = appendBootstrapStepEvent(
      journal(),
      stepInput(
        '019f8bc0-0010-7abc-8def-0123456789ab',
        'prepared',
      ),
    );
    const reconciled = appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0011-7abc-8def-0123456789ab',
        'reconciled',
        {
          generatedScopeFingerprint: digest('generated'),
          exitCode: 0,
        },
      ),
    );

    expect(reconciled.journal.state).toBe('ready');
  });

  it('blocks the journal after a failed step', () => {
    const prepared = appendBootstrapStepEvent(
      journal(),
      stepInput(
        '019f8bc0-0010-7abc-8def-0123456789ab',
        'prepared',
      ),
    );
    const failed = appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0011-7abc-8def-0123456789ab',
        'failed',
        {
          generatedScopeFingerprint: digest('generated'),
          exitCode: 1,
        },
      ),
    );

    expect(failed.journal.state).toBe('blocked');
    expect(() => appendBootstrapStepEvent(
      failed.journal,
      stepInput(
        '019f8bc0-0012-7abc-8def-0123456789ab',
        'prepared',
      ),
    )).toThrow(/out of order/u);
  });

  it('adopts ownership only when no step is in flight', () => {
    const initial = journal();
    const adopted = adoptBootstrapJournalOwnership(initial, {
      eventId: '019f8bc0-0010-7abc-8def-0123456789ab',
      previousWorktreeFencingTokenDigest: digest('fencing-1'),
      currentWorktreeFencingTokenDigest: digest('fencing-2'),
      observedGeneratedScopeFingerprint: digest('generated'),
      idempotencyKey: 'adopt_run_2',
    });
    expect(adopted.journal).toMatchObject({
      state: 'ready',
      currentWorktreeFencingTokenDigest: digest('fencing-2'),
    });

    const prepared = appendBootstrapStepEvent(
      initial,
      stepInput(
        '019f8bc0-0011-7abc-8def-0123456789ab',
        'prepared',
      ),
    );
    expect(() => adoptBootstrapJournalOwnership(prepared.journal, {
      eventId: '019f8bc0-0012-7abc-8def-0123456789ab',
      previousWorktreeFencingTokenDigest: digest('fencing-1'),
      currentWorktreeFencingTokenDigest: digest('fencing-2'),
      observedGeneratedScopeFingerprint: digest('generated'),
      idempotencyKey: 'adopt_run_2',
    })).toThrow(TypeError);
  });

  it('rejects stale fencing tokens and a different active step', () => {
    const prepared = appendBootstrapStepEvent(
      journal(),
      stepInput(
        '019f8bc0-0010-7abc-8def-0123456789ab',
        'prepared',
      ),
    );
    expect(() => appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0011-7abc-8def-0123456789ab',
        'started',
        { worktreeFencingTokenDigest: digest('fencing-2') },
      ),
    )).toThrow(TypeError);
    expect(() => appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0012-7abc-8def-0123456789ab',
        'started',
        { stepId: 'step_2' },
      ),
    )).toThrow(/out of order/u);
  });

  it('rejects incomplete observations and success with nonzero exit', () => {
    const prepared = appendBootstrapStepEvent(
      journal(),
      stepInput(
        '019f8bc0-0010-7abc-8def-0123456789ab',
        'prepared',
      ),
    );
    expect(() => appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0011-7abc-8def-0123456789ab',
        'observed',
        { exitCode: 0 },
      ),
    )).toThrow(TypeError);
    expect(() => appendBootstrapStepEvent(
      prepared.journal,
      stepInput(
        '019f8bc0-0012-7abc-8def-0123456789ab',
        'observed',
        {
          generatedScopeFingerprint: digest('generated'),
          exitCode: 1,
        },
      ),
    )).toThrow(TypeError);
  });

  it('fails validation after event or journal digest tampering', () => {
    const prepared = appendBootstrapStepEvent(
      journal(),
      stepInput(
        '019f8bc0-0010-7abc-8def-0123456789ab',
        'prepared',
      ),
    );

    expect(validateBootstrapExecutionEvent({
      ...prepared.event,
      argvDigest: digest('changed-argv'),
    })).toBe(false);
    expect(validateBootstrapExecutionJournal({
      ...prepared.journal,
      activeStepId: 'step_2',
    })).toBe(false);
  });
});
