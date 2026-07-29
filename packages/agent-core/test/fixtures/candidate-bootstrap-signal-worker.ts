import { resolve } from 'node:path';

import { CandidateBootstrapStateStore } from '../../src/candidate-bootstrap-state-store';
import {
  candidateBootstrapSignalFixture,
  SIGNAL_FIXTURE_IDS,
} from './candidate-bootstrap-signal-fixture';
import {
  protectWindowsPrivateRootSecurity,
} from '../../src/windows-private-root-security';

const rootDirectory = process.argv[2];
if (rootDirectory === undefined) {
  throw new Error('A bootstrap state root is required.');
}
const value = candidateBootstrapSignalFixture();
if (process.platform === 'win32') {
  protectWindowsPrivateRootSecurity(resolve(rootDirectory));
}
const store = new CandidateBootstrapStateStore({
  rootDirectory: resolve(rootDirectory),
});

await store.initialize({
  worktreeLease: value.lease,
  bootstrapPlan: value.plan,
  bootstrapBudget: value.budget,
  journalId: SIGNAL_FIXTURE_IDS.journal,
});
await store.prepareStep({
  worktreeLease: value.lease,
  bootstrapPlan: value.plan,
  step: value.step,
  reservationId: SIGNAL_FIXTURE_IDS.reservation,
  budgetEventId: SIGNAL_FIXTURE_IDS.reserveBudget,
  journalEventId: SIGNAL_FIXTURE_IDS.prepareJournal,
  reservedWallClockMs: 50_000,
  reservedGeneratedBytes: 900_000,
  reservedOutputBytes: 90_000,
  idempotencyKey: 'signal-step',
});
await store.startStep({
  worktreeLease: value.lease,
  bootstrapPlan: value.plan,
  step: value.step,
  reservationId: SIGNAL_FIXTURE_IDS.reservation,
  budgetEventId: SIGNAL_FIXTURE_IDS.startBudget,
  journalEventId: SIGNAL_FIXTURE_IDS.startJournal,
  idempotencyKey: 'signal-step',
});
process.stdout.write('step-running\n');
setInterval(() => {}, 60_000);
