import { describe, expect, it, vi } from 'vitest';

import { handleAutoCommand, handleYoloCommand } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(permissionMode: 'manual' | 'auto' | 'yolo' = 'manual') {
  const session = { setPermission: vi.fn(async () => {}) };
  const host = {
    session,
    state: { appState: { permissionMode } },
    setAppState: vi.fn(),
    showNotice: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('permission mode slash commands', () => {
  it('rejects invalid /yolo arguments without changing permissions', async () => {
    const { host, session } = makeHost();

    await handleYoloCommand(host, 'onn');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('Usage: /yolo [on|off]');
  });

  it('rejects invalid /auto arguments without changing permissions', async () => {
    const { host, session } = makeHost();

    await handleAutoCommand(host, 'status');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('Usage: /auto [on|off]');
  });

  it('still allows bare commands to toggle their mode', async () => {
    const yolo = makeHost();
    await handleYoloCommand(yolo.host, '');
    expect(yolo.session.setPermission).toHaveBeenCalledWith('yolo');

    const auto = makeHost();
    await handleAutoCommand(auto.host, '');
    expect(auto.session.setPermission).toHaveBeenCalledWith('auto');
  });
});
