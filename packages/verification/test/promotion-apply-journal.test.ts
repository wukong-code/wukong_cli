import { describe, expect, it } from 'vitest';

import {
  adoptPromotionApplyJournalOwnership,
  appendPromotionChangeEvent,
  canonicalDigest,
  completePromotionApplyJournal,
  createPromotionApplyJournal,
  createPromotionPathState,
  validatePromotionApplyJournal,
} from '../src';

const JOURNAL_ID = '019f8cd0-0000-7abc-8def-0123456789ab';
const PROMOTION_ID = '019f8cd0-0001-7abc-8def-0123456789ab';
const LEASE_ID = '019f8cd0-0002-7abc-8def-0123456789ab';
const CANDIDATE_ID = '019f8cd0-0003-7abc-8def-0123456789ab';

describe('PromotionApplyJournalV1', () => {
  it('requires prepared-before-applied and seals complete coverage', () => {
    const before = state('file.txt', 'before');
    const after = state('file.txt', 'after');
    const journal = fixture(1);
    const prepared = appendPromotionChangeEvent(journal, {
      eventId: '019f8cd0-0004-7abc-8def-0123456789ab',
      changeIndex: 0,
      operation: 'update',
      eventType: 'prepared',
      expectedPreimages: [before],
      expectedPostimages: [after],
      observedStates: [before],
      targetFencingTokenDigest: digest('fencing'),
      idempotencyKey: digest('change-0'),
      occurredAt: '2026-07-29T15:00:00.000Z',
    });
    const applied = appendPromotionChangeEvent(prepared, {
      eventId: '019f8cd0-0005-7abc-8def-0123456789ab',
      changeIndex: 0,
      operation: 'update',
      eventType: 'applied',
      expectedPreimages: [before],
      expectedPostimages: [after],
      observedStates: [after],
      targetFencingTokenDigest: digest('fencing'),
      idempotencyKey: digest('change-0'),
      occurredAt: '2026-07-29T15:00:01.000Z',
    });
    const complete = completePromotionApplyJournal(
      applied,
      digest('target-after'),
    );

    expect(complete.state).toBe('applied');
    expect(complete.events).toHaveLength(2);
    expect(validatePromotionApplyJournal(complete)).toBe(true);
  });

  it('fails closed on skipped ordering, stale fencing, and tampering', () => {
    const journal = fixture(1);
    const before = state('file.txt', 'before');
    const after = state('file.txt', 'after');
    expect(() => appendPromotionChangeEvent(journal, {
      eventId: '019f8cd0-0004-7abc-8def-0123456789ab',
      changeIndex: 0,
      operation: 'update',
      eventType: 'applied',
      expectedPreimages: [before],
      expectedPostimages: [after],
      observedStates: [after],
      targetFencingTokenDigest: digest('fencing'),
      idempotencyKey: digest('change-0'),
      occurredAt: '2026-07-29T15:00:00.000Z',
    })).toThrow(/ordering/u);
    expect(() => appendPromotionChangeEvent(journal, {
      eventId: '019f8cd0-0004-7abc-8def-0123456789ab',
      changeIndex: 0,
      operation: 'update',
      eventType: 'prepared',
      expectedPreimages: [before],
      expectedPostimages: [after],
      observedStates: [before],
      targetFencingTokenDigest: digest('stale'),
      idempotencyKey: digest('change-0'),
      occurredAt: '2026-07-29T15:00:00.000Z',
    })).toThrow(/accept/u);
    expect(validatePromotionApplyJournal({
      ...journal,
      candidateDeltaDigest: digest('tampered'),
    })).toBe(false);
  });

  it('supports an empty, verified no-op delta', () => {
    const complete = completePromotionApplyJournal(
      fixture(0),
      digest('target-after'),
    );
    expect(complete.state).toBe('applied');
  });

  it('rotates the current fencing owner without rewriting provenance', () => {
    const journal = fixture(1);
    const nextFencing = digest('next-fencing');
    const adopted = adoptPromotionApplyJournalOwnership(journal, {
      expectedTargetFencingTokenDigest:
        journal.currentTargetFencingTokenDigest,
      nextTargetFencingTokenDigest: nextFencing,
    });

    expect(adopted).toMatchObject({
      createdByTargetFencingTokenDigest: digest('fencing'),
      currentTargetFencingTokenDigest: nextFencing,
      targetFencingTokenLineage: [
        digest('fencing'),
        nextFencing,
      ],
    });
    expect(() => appendPromotionChangeEvent(adopted, {
      eventId: '019f8cd0-0006-7abc-8def-0123456789ab',
      changeIndex: 0,
      operation: 'update',
      eventType: 'prepared',
      expectedPreimages: [state('file.txt', 'before')],
      expectedPostimages: [state('file.txt', 'after')],
      observedStates: [state('file.txt', 'before')],
      targetFencingTokenDigest: digest('fencing'),
      idempotencyKey: digest('change-0'),
      occurredAt: '2026-07-29T15:00:02.000Z',
    })).toThrow(/accept/u);
  });
});

function fixture(changeCount: number) {
  return createPromotionApplyJournal({
    journalId: JOURNAL_ID,
    promotionId: PROMOTION_ID,
    targetPromotionLeaseId: LEASE_ID,
    targetRegistryKey: digest('registry'),
    createdByTargetFencingTokenDigest: digest('fencing'),
    candidateId: CANDIDATE_ID,
    candidateDeltaDigest: digest('delta'),
    orderedChangeManifestDigest: digest('manifest'),
    changeCount,
    targetBeforeFingerprintDigest: digest('target-before'),
    targetBeforeContentDigest: digest('source-content'),
    materializedSourceDigest: digest('source-content'),
    agentDeltaDigest: digest('agent-delta'),
  });
}

function state(path: string, content: string) {
  return createPromotionPathState({
    candidateRelativePath: path,
    presence: 'present',
    fileType: 'regular',
    mode: 0o644,
    contentDigest: digest(content),
  });
}

function digest(label: string): string {
  return canonicalDigest('wukong/test/promotion-journal/v1', label);
}
