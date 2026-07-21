import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleTransformCommand } from '#/tui/commands/role';
import { findBuiltInSlashCommand } from '#/tui/commands/registry';

function makeHost() {
  const session = {
    listRoles: vi.fn(async () => [
      { selection: 'security', source: 'builtin', description: 'Security review' },
    ]),
    getActiveRole: vi.fn(async () => ({ active: false })),
    setRole: vi.fn(async (role?: string) =>
      role === undefined
        ? { active: false, model: 'default' }
        : {
            active: true,
            model: 'fast',
            role: { selection: role, source: 'builtin', description: 'Security review' },
          },
    ),
  };
  const host = {
    session,
    requireSession: () => session,
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    setAppState: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('/transform', () => {
  it('is gated by the role_profiles experiment', () => {
    expect(findBuiltInSlashCommand('transform')).toMatchObject({
      aliases: [],
      availability: 'idle-only',
      experimentalFlag: 'role_profiles',
      visibleWhenDisabled: true,
    });
    expect(findBuiltInSlashCommand('role')).toBeUndefined();
  });

  it('applies a role and updates the visible model', async () => {
    const { host, session } = makeHost();

    await handleTransformCommand(host, 'security');

    expect(session.setRole).toHaveBeenCalledWith('security');
    expect(host.setAppState).toHaveBeenCalledWith({ model: 'fast' });
    expect(host.showNotice).toHaveBeenCalledWith(
      'Transformed into security',
      expect.stringContaining('Source: builtin'),
    );
  });

  it('turns the active role off', async () => {
    const { host, session } = makeHost();

    await handleTransformCommand(host, 'off');

    expect(session.setRole).toHaveBeenCalledWith(undefined);
    expect(host.showStatus).toHaveBeenCalledWith('Transform: off');
  });
});
