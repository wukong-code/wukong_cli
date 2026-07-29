import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  SourceSnapshotSelectorComponent,
} from '#/tui/components/dialogs/source-snapshot-selector';

const ANSI = /\u001B\[[0-9;]*m/gu;

describe('Source Snapshot selector', () => {
  it('selects only eligible untracked files and returns canonical path order', () => {
    const onDone = vi.fn();
    const selector = new SourceSnapshotSelectorComponent({
      candidates: [
        candidate('src/z-new.ts', 'eligible', null, 2048),
        candidate('.env', 'excluded', 'secret_or_credential', 64),
        candidate('src/a-new.ts', 'eligible', null, 128),
      ],
      selectedPaths: ['src/z-new.ts', '.env'],
      onDone,
      onCancel: vi.fn(),
    });
    selector.focused = true;

    const initial = selector.render(90).join('\n').replaceAll(ANSI, '');
    expect(initial).toContain('src/z-new.ts ✓ selected');
    expect(initial).toContain('.env blocked · secret_or_credential');
    expect(initial).toContain('1 selected');

    selector.handleInput('\u001B[B');
    selector.handleInput(' ');
    selector.handleInput('\u001B[B');
    selector.handleInput(' ');
    selector.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith([
      'src/a-new.ts',
      'src/z-new.ts',
    ]);
    for (const line of selector.render(39)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(39);
    }
  });

  it('clears search before cancelling', () => {
    const onCancel = vi.fn();
    const selector = new SourceSnapshotSelectorComponent({
      candidates: [candidate('src/new.ts', 'eligible', null, 10)],
      selectedPaths: [],
      onDone: vi.fn(),
      onCancel,
    });

    selector.handleInput('n');
    selector.handleInput('\u001B');
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

function candidate(
  pathProjection: string,
  eligibility: 'eligible' | 'excluded',
  exclusionReason:
    | 'secret_or_credential'
    | null,
  sizeBytes: number,
) {
  return {
    pathProjection,
    sizeBytes,
    selected: false,
    eligibility,
    exclusionReason,
    candidateDigest: `sha256:${pathProjection === '.env' ? '2' : pathProjection.includes('a-') ? '1' : '3'}`.padEnd(71, pathProjection === '.env' ? '2' : pathProjection.includes('a-') ? '1' : '3'),
  } as const;
}
