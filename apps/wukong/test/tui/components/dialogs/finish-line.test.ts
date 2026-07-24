import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFinishLine } from '@wukong/verification';

import { FinishLineEditorComponent } from '#/tui/components/dialogs/finish-line-editor';
import { FinishLineReviewComponent } from '#/tui/components/dialogs/finish-line-review';

const paths: string[] = [];
const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (lines: readonly string[]): string => lines.join('\n').replaceAll(ANSI, '');

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Finish Line TUI dialogs', () => {
  it('renders all editor fields, supports keyboard traversal, and cancels without persisting', () => {
    const onDone = vi.fn();
    const editor = new FinishLineEditorComponent({
      objective: 'Ship Loop V2',
      completionCriterion: 'All checks pass',
      constraints: ['Do not weaken checks'],
    }, onDone);
    editor.focused = true;

    const initial = strip(editor.render(72));
    expect(initial).toContain('Goal');
    expect(initial).toContain('Done when (optional)');
    expect(initial).toContain('Must not (optional)');
    expect(initial).toContain('Ship Loop V2');

    editor.handleInput('\t');
    editor.handleInput('\t');
    expect(strip(editor.render(72))).toContain('Enter submit');
    editor.handleInput('\u001B');
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });

  it('shows warnings, checks, advanced settings, and keeps the dialog within width', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-finish-line-tui-'));
    paths.push(cwd);
    const built = await buildFinishLine({
      cwd,
      objective: 'Ship Loop V2',
      includeDiscoveredChecks: true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const onSelect = vi.fn();
    const review = new FinishLineReviewComponent({
      proposal: built.proposal,
      maxIterations: 10,
      onSelect,
      onCancel: vi.fn(),
    });
    review.focused = true;

    const rendered = strip(review.render(72));
    expect(rendered).toContain('Acknowledge warnings and start');
    expect(rendered).toContain('Review checks');
    expect(rendered).toContain('Advanced settings');
    expect(rendered).toContain('current OS account permissions');
    for (const line of review.render(39)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(39);
    }
  });
});
