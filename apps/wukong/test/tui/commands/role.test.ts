import type { ActiveRole } from '@wukong/wukong-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleTransformCommand } from '#/tui/commands/role';
import { findBuiltInSlashCommand } from '#/tui/commands/registry';

function makeHost() {
  const session = {
    listRoles: vi.fn(async () => [
      { selection: 'security', source: 'builtin', description: 'Security review' },
      { selection: 'qa', source: 'user', description: 'User QA role' },
      { selection: 'project:backend', source: 'project', description: 'Project backend role' },
    ]),
    getActiveRole: vi.fn(async (): Promise<ActiveRole> => ({ active: false })),
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
      argumentHint: '<role|list|status|off>',
      experimentalFlag: 'role_profiles',
      visibleWhenDisabled: false,
    });
    expect(findBuiltInSlashCommand('role')).toBeUndefined();
  });

  it('lists built-in, user, and project roles', async () => {
    const { host } = makeHost();

    await handleTransformCommand(host, 'list');

    expect(host.showNotice).toHaveBeenCalledWith(
      'Role profiles',
      expect.stringContaining('security [builtin]'),
    );
    const detail = vi.mocked(host.showNotice).mock.calls[0]?.[1];
    expect(detail).toContain('qa [user]');
    expect(detail).toContain('project:backend [project]');
  });

  it('shows the active role and model', async () => {
    const { host, session } = makeHost();
    session.getActiveRole.mockResolvedValueOnce({
      active: true,
      model: 'fast',
      role: {
        name: 'security',
        selection: 'security',
        source: 'builtin',
        description: 'Security review',
      },
    });

    await handleTransformCommand(host, 'status');

    expect(host.showStatus).toHaveBeenCalledWith('Transform: security [builtin] · fast');
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
