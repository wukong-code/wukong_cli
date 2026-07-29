import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/session';
import type { SDKRpcClientBase } from '#/rpc';
import type {
  PrepareIsolatedLoopPromotionPayloadV1,
  PromoteIsolatedLoopCandidatePayloadV1,
  RunIsolatedLoopCandidateIterationPayloadV1,
} from '#/types';

function makeSession() {
  const rpc = {
    createGoal: vi.fn(async () => ({ goalId: 'g1' })),
    runIsolatedLoopCandidateIteration: vi.fn(async () => ({
      schemaVersion: 1,
      candidateId: 'candidate',
      iteration: 1,
    })),
    prepareIsolatedLoopPromotion: vi.fn(async () => ({
      schemaVersion: 1,
      candidateId: 'candidate',
      proposalDigest: 'sha256:proposal',
    })),
    promoteIsolatedLoopCandidate: vi.fn(async () => ({
      schemaVersion: 1,
      candidateId: 'candidate',
      outcome: 'PASS',
    })),
    getGoal: vi.fn(async () => ({ goal: null })),
    pauseGoal: vi.fn(async () => ({ goalId: 'g1' })),
    resumeGoal: vi.fn(async () => ({ goalId: 'g1' })),
    cancelGoal: vi.fn(async () => ({ goalId: 'g1' })),
    clearSessionHandlers: vi.fn(),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_goal', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

describe('Session goal methods', () => {
  it('createGoal forwards the supported payload with sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.createGoal({
      objective: 'Ship feature X',
      replace: true,
    });
    expect(rpc.createGoal).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      objective: 'Ship feature X',
      replace: true,
    });
  });

  it('getGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.getGoal();
    expect(rpc.getGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('forwards an isolated Loop candidate iteration through the SDK only', async () => {
    const { session, rpc } = makeSession();
    const payload: RunIsolatedLoopCandidateIterationPayloadV1 = {
      schemaVersion: 1,
      sourceRepositoryRoot: '/tmp/repository',
      sourceSnapshotCwd: '/tmp/repository/package',
      sourceSnapshot: {} as RunIsolatedLoopCandidateIterationPayloadV1[
        'sourceSnapshot'
      ],
    };

    await session.runIsolatedLoopCandidateIteration(payload);

    expect(rpc.runIsolatedLoopCandidateIteration).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      ...payload,
    });
  });

  it('forwards an isolated Loop promotion challenge without applying it', async () => {
    const { session, rpc } = makeSession();
    const payload: PrepareIsolatedLoopPromotionPayloadV1 = {
      schemaVersion: 1,
      sourceRepositoryRoot: '/tmp/repository',
      sourceSnapshotCwd: '/tmp/repository/package',
      sourceSnapshot: {} as PrepareIsolatedLoopPromotionPayloadV1[
        'sourceSnapshot'
      ],
    };

    await session.prepareIsolatedLoopPromotion(payload);

    expect(rpc.prepareIsolatedLoopPromotion).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      ...payload,
    });
  });

  it('forwards only an exact reviewed promotion digest for Apply', async () => {
    const { session, rpc } = makeSession();
    const payload: PromoteIsolatedLoopCandidatePayloadV1 = {
      schemaVersion: 1,
      sourceRepositoryRoot: '/tmp/repository',
      sourceSnapshotCwd: '/tmp/repository/package',
      sourceSnapshot: {} as PromoteIsolatedLoopCandidatePayloadV1[
        'sourceSnapshot'
      ],
      proposalDigest: `sha256:${'a'.repeat(64)}`,
    };

    await session.promoteIsolatedLoopCandidate(payload);

    expect(rpc.promoteIsolatedLoopCandidate).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      ...payload,
    });
  });

  it('pauseGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.pauseGoal();
    expect(rpc.pauseGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('resumeGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.resumeGoal();
    expect(rpc.resumeGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('cancelGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.cancelGoal();
    expect(rpc.cancelGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('does not expose a public clearGoal or updateGoal method', () => {
    const { session } = makeSession();
    expect((session as unknown as { clearGoal?: unknown }).clearGoal).toBeUndefined();
    expect((session as unknown as { updateGoal?: unknown }).updateGoal).toBeUndefined();
  });
});
