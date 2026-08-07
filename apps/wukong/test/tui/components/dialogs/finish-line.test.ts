import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFinishLine } from '@wukong/verification';

import { FinishLineEditorComponent } from '#/tui/components/dialogs/finish-line-editor';
import { FinishLineReviewComponent } from '#/tui/components/dialogs/finish-line-review';
import { LoopRuntimeEditorComponent } from '#/tui/components/dialogs/loop-runtime-editor';

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
      summary: [
        'Goal         Ship Loop V2 with a deliberately long explanation that must wrap safely in narrow terminals',
        'Done when    project checks and the fresh review pass',
        'Must not 1   Do not weaken checks or overwrite pre-existing workspace changes',
        'Verification 0 required project checks · none approved',
        'Writer       writer-model',
        'Reviewer     reviewer-model',
        'Provider     openai → https://api.openai.com:443',
        'Permission   yolo · current OS account · no OS sandbox',
        'Workspace    /workspace · 7 pre-existing changed files',
        'Dirty 1       M src/very-long-existing-file-name.ts',
        'Provider calls no separate cap configured',
        'Token budget no separate cap configured',
        'Outbound     bounded changed/scope files and redacted Gate evidence',
      ].join('\n'),
      maxIterations: 10,
      permissionMode: 'yolo',
      missingUsageCaps: true,
      workspaceGit: {
        isRepo: true,
        changedFileCount: 7,
        changedFiles: [
          { status: 'M', path: 'src/very-long-existing-file-name.ts' },
          { status: '??', path: 'test/new-file.test.ts' },
        ],
      },
      onSelect,
      onCancel: vi.fn(),
    });
    review.focused = true;

    const rendered = strip(review.render(72));
    expect(rendered).toContain('Fix finish line warnings');
    expect(rendered).toContain('Continue anyway to approvals');
    expect(rendered).not.toContain('Review checks');
    expect(rendered).toContain('Review pre-existing workspace changes');
    expect(rendered).toContain('Edit run limits');
    expect(rendered).toContain('current OS account');
    expect(rendered).toContain('no OS sandbox');
    expect(rendered).toContain('Workspace');
    expect(rendered.indexOf('Cancel')).toBeLessThan(rendered.indexOf('Continue anyway to approvals'));
    review.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('edit');
    for (const line of review.render(39)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(39);
    }
  });

  it('shows configured usage ceilings without claiming they are missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-finish-line-caps-'));
    paths.push(cwd);
    const built = await buildFinishLine({
      cwd,
      objective: 'Ship within explicit limits',
      includeDiscoveredChecks: true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const review = new FinishLineReviewComponent({
      proposal: built.proposal,
      summary: 'Writer calls 12\nReviewer calls 4\nToken budget 50000',
      maxIterations: 10,
      missingUsageCaps: false,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = strip(review.render(72));
    expect(rendered).toContain('Edit run limits');
    expect(rendered).not.toContain('not separately configured');
  });

  it('edits every runtime ceiling in Preflight and submits one validated draft', () => {
    const onDone = vi.fn();
    const editor = new LoopRuntimeEditorComponent({
      maxIterations: 10,
      writerModel: 'writer-model',
      writerProviderCallLimit: 12,
      reviewerProviderCallLimit: 4,
      tokenBudget: 50_000,
      reviewModel: 'reviewer-model',
      minIntervalMs: 1_000,
    }, onDone);
    editor.focused = true;

    const rendered = strip(editor.render(72));
    expect(rendered).toContain('Maximum iterations');
    expect(rendered).toContain('Writer model');
    expect(rendered).toContain('Writer provider calls');
    expect(rendered).toContain('Reviewer provider calls');
    expect(rendered).toContain('Token budget');
    expect(rendered).toContain('Reviewer model');
    expect(rendered).toContain('Minimum interval (ms)');
    for (let index = 0; index < 6; index += 1) editor.handleInput('\t');
    editor.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({
      kind: 'submit',
      draft: {
        maxIterations: 10,
        writerModel: 'writer-model',
        writerProviderCallLimit: 12,
        reviewerProviderCallLimit: 4,
        tokenBudget: 50_000,
        reviewModel: 'reviewer-model',
        minIntervalMs: 1_000,
      },
    });
  });
});
