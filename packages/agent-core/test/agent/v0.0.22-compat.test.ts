import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { testAgent } from './harness/agent';

const FROZEN_SESSION_FIXTURE = new URL(
  '../fixtures/compat/v0.0.22/session-records.json',
  import.meta.url,
);

describe('v0.0.22 direct-upgrade compatibility', () => {
  it('replays the immutable released session without rewriting proof or causing side effects', async () => {
    const fixture = JSON.parse(await readFile(FROZEN_SESSION_FIXTURE, 'utf8')) as AgentRecord[];
    const appended: AgentRecord[] = [];
    const persistence = new InMemoryAgentRecordPersistence(fixture, {
      onRecord: (record) => appended.push(record),
    });
    const execWithEnv = vi.fn().mockRejectedValue(new Error('must not execute during replay'));
    const ctx = testAgent({
      persistence,
      kaos: createFakeKaos({ execWithEnv }),
    });

    await ctx.agent.resume();

    const completion = ctx.agent.replayBuilder.buildResult().find(
      (entry) => entry.type === 'goal_updated' && entry.change?.kind === 'completion',
    );
    expect(completion).toMatchObject({
      snapshot: {
        objective: 'Ship an explicit Finish Line',
        completionCriterion: 'The frozen gate and reviewer both pass',
        status: 'complete',
        loopContract: {
          schemaVersion: 2,
          acceptanceCriteria: [
            { id: 'objective', source: 'objective' },
            { id: 'completion-criterion', source: 'completion_criterion' },
          ],
        },
        loopTerminal: {
          status: 'PASS',
          reasonCode: 'passed',
        },
      },
    });
    expect(ctx.llmCalls).toHaveLength(0);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(persistence.records).toEqual(fixture);
  });
});
