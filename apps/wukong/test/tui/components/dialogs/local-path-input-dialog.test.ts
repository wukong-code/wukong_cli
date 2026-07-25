import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  LocalPathInputDialogComponent,
  type LocalPathInputResult,
} from '#/tui/components/dialogs/local-path-input-dialog';

describe('LocalPathInputDialogComponent', () => {
  it('explains the exact local-only trust boundary and stays width-safe', () => {
    const dialog = new LocalPathInputDialogComponent(() => {});
    const rendered = dialog.render(48);
    const wide = dialog.render(100).join('\n');
    expect(wide).toContain('exact local directory');
    expect(wide).toContain('Remote URLs are rejected');
    expect(rendered.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it('submits a trimmed path and supports cancel', () => {
    const submitted: LocalPathInputResult[] = [];
    const dialog = new LocalPathInputDialogComponent((result) => {
      submitted.push(result);
    });
    for (const character of ' /tmp/review-skills ') dialog.handleInput(character);
    dialog.handleInput('\r');
    expect(submitted).toEqual([{ kind: 'ok', value: '/tmp/review-skills' }]);

    const cancelled: LocalPathInputResult[] = [];
    const second = new LocalPathInputDialogComponent((result) => {
      cancelled.push(result);
    });
    second.handleInput(String.fromCodePoint(27));
    expect(cancelled).toEqual([{ kind: 'cancel' }]);
  });
});
