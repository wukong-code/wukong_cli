import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverVerificationCriteriaCatalog } from '@wukong/verification';

import { VerificationCriteriaSelectorComponent } from '#/tui/components/dialogs/verification-criteria-selector';

const paths: string[] = [];
const ANSI = /\u001B\[[0-9;]*m/gu;

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Verification Criteria selector', () => {
  it('keeps suggestions unselected, toggles explicitly, and confirms flat order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-criteria-selector-'));
    paths.push(cwd);
    const root = join(cwd, '.wukong', 'skills');
    await writeSkill(root, 'review-api', 'src/api/**');
    await writeSkill(root, 'review-ui', 'src/ui/**');
    const catalog = await discoverVerificationCriteriaCatalog({
      workspaceRoot: cwd,
      roots: [{
        kind: 'project',
        root,
        workspaceIdentityDigest: 'sha256:workspace',
      }],
      changedPaths: ['src/api/users.ts'],
    });
    const onDone = vi.fn();
    const selector = new VerificationCriteriaSelectorComponent({
      catalog,
      selected: [],
      onDone,
      onCancel: vi.fn(),
    });
    selector.focused = true;

    const initial = selector.render(90).join('\n').replaceAll(ANSI, '');
    expect(initial).toContain('○ suggested');
    expect(initial).not.toContain('1 selected');
    expect(initial).toContain('Trust: workspace');
    expect(initial).toContain(catalog.entries[0]!.ref.provenanceDigest);
    expect(initial).toContain('Criterion complete');
    expect(initial).toContain('Model hints: none');
    selector.handleInput(' ');
    selector.handleInput('\u001B[B');
    selector.handleInput(' ');
    selector.handleInput('\u001B[D');
    selector.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith([
      expect.objectContaining({ selectionId: expect.stringContaining('review-ui') }),
      expect.objectContaining({ selectionId: expect.stringContaining('review-api') }),
    ]);
    for (const line of selector.render(39)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(39);
    }
  });

  it('clears search before cancelling', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wukong-criteria-selector-search-'));
    paths.push(cwd);
    const root = join(cwd, '.wukong', 'skills');
    await writeSkill(root, 'review-api', 'src/**');
    const catalog = await discoverVerificationCriteriaCatalog({
      workspaceRoot: cwd,
      roots: [{
        kind: 'project',
        root,
        workspaceIdentityDigest: 'sha256:workspace',
      }],
    });
    const onCancel = vi.fn();
    const selector = new VerificationCriteriaSelectorComponent({
      catalog,
      selected: [],
      onDone: vi.fn(),
      onCancel,
    });
    selector.handleInput('a');
    selector.handleInput('\u001B');
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

async function writeSkill(root: string, name: string, path: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(join(dir, 'verification'), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: Review a focused area.',
    'metadata:',
    '  wukong.verification.criteria: verification/criteria.v1.json',
    '---',
    '',
    'Human instructions.',
  ].join('\n'));
  await writeFile(join(dir, 'verification', 'criteria.v1.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'wukong.verification-criteria',
    id: name,
    description: 'Review a focused area.',
    scope: { kind: 'project', paths: [path] },
    criteria: [{
      id: 'complete',
      text: 'The focused behavior is complete.',
      evidence: 'Cite the changed implementation.',
    }],
  }));
}
