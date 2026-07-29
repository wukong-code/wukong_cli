import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CandidateBootstrapStateStore } from '../src/candidate-bootstrap-state-store';
import {
  candidateBootstrapSignalFixture,
  SIGNAL_FIXTURE_IDS,
} from './fixtures/candidate-bootstrap-signal-fixture';

const roots: string[] = [];
type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
const signals: readonly TerminationSignal[] =
  process.platform === 'win32'
    ? ['SIGKILL']
    : ['SIGINT', 'SIGTERM'];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe('candidate bootstrap hard-signal recovery', () => {
  it.each(signals)(
    'retains unknown usage after %s instead of replaying or guessing success',
    async (signal) => {
      const root = await mkdtemp(join(
        tmpdir(),
        'wukong-bootstrap-hard-signal-',
      ));
      roots.push(root);
      const workerPath = new URL(
        './fixtures/candidate-bootstrap-signal-worker.ts',
        import.meta.url,
      );
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(workerPath), root],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      const lines = createInterface({ input: child.stdout });
      const [line] = await once(lines, 'line');
      expect(line).toBe('step-running');
      expect(child.kill(signal)).toBe(true);
      const [exitCode, exitSignal] = await once(child, 'exit');
      if (process.platform !== 'win32') {
        expect(exitCode).toBeNull();
        expect(exitSignal).toBe(signal);
      }

      const value = candidateBootstrapSignalFixture();
      const store = new CandidateBootstrapStateStore({
        rootDirectory: root,
      });
      const crashed = await store.inspect(value.lease, value.plan);
      expect(crashed.journal.state).toBe('step_running');
      expect(crashed.journalEvents.some((event) =>
        event.eventType === 'observed'
        || event.eventType === 'reconciled'
        || event.eventType === 'failed')).toBe(false);
      expect(crashed.reservations).toMatchObject([{
        reservationId: SIGNAL_FIXTURE_IDS.reservation,
        state: 'running',
      }]);

      const retained = await store.retainUnknown({
        worktreeLease: value.lease,
        bootstrapPlan: value.plan,
        step: value.step,
        reservationId: SIGNAL_FIXTURE_IDS.reservation,
        budgetEventId: SIGNAL_FIXTURE_IDS.retainBudget,
      });
      expect(retained.reservations).toMatchObject([{
        reservationId: SIGNAL_FIXTURE_IDS.reservation,
        state: 'retained_unknown',
        actualWallClockMs: null,
        actualGeneratedBytes: null,
        actualOutputBytes: null,
      }]);
      expect(retained.journal.state).toBe('step_running');
    },
    30_000,
  );
});
