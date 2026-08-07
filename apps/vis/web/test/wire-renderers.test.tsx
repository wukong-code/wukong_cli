import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { rendererFor } from '../src/components/wire/renderers';
import type { AgentRecordOf } from '../src/types';

describe('workspace path touch wire renderers', () => {
  it('shows the first observed state for a workspace path', () => {
    const record: AgentRecordOf<'goal.workspace-path-touch.create'> = {
      type: 'goal.workspace-path-touch.create',
      goalId: 'goal-1',
      path: '/workspace/result.txt',
      before: { kind: 'missing' },
    };
    const renderer = rendererFor(record.type);

    expect(renderer?.label).toBe('touch+');
    expect(renderToStaticMarkup(renderer!.headline(record).main)).toContain(
      '/workspace/result.txt',
    );
    expect(renderToStaticMarkup(renderer!.headline(record).main)).toContain('missing');
  });

  it('shows the tool and resulting file state after a write', () => {
    const record: AgentRecordOf<'goal.workspace-path-touch.update'> = {
      type: 'goal.workspace-path-touch.update',
      goalId: 'goal-1',
      path: '/workspace/result.txt',
      toolCallId: 'tool-write-result',
      after: { kind: 'file', size: 42, digest: 'a'.repeat(64) },
    };
    const renderer = rendererFor(record.type);
    const markup = renderToStaticMarkup(renderer!.headline(record).main);

    expect(renderer?.label).toBe('touch');
    expect(markup).toContain('/workspace/result.txt');
    expect(markup).toContain('file · 42 B');
    expect(markup).toContain('tool-write-result');
  });
});
