import { describe, expect, it, vi } from 'vitest';

import { PlatformSelectorComponent } from '#/tui/components/dialogs/platform-selector';

const ANSI = /\u001B\[[0-9;]*m/g;

function text(component: PlatformSelectorComponent, width = 100): string {
  return component.render(width).join('\n').replaceAll(ANSI, '');
}

describe('PlatformSelectorComponent', () => {
  it('keeps login focused on OAuth instead of API-key platforms', () => {
    const picker = new PlatformSelectorComponent({
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);

    expect(out).toContain('Wukong (OAuth)');
    expect(out).not.toContain('Wukong Platform');
    expect(out).not.toContain('platform.wukong.today');
    expect(out).not.toContain('platform.wukong.ai');
  });
});
