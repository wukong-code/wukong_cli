import type { SlashCommandHost } from './dispatch';

export async function handleTransformCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.requireSession();
  const input = args.trim();

  if (input === 'list') {
    const roles = await session.listRoles();
    host.showNotice(
      'Role profiles',
      roles.map((role) => `${role.selection} [${role.source}] — ${role.description}`).join('\n'),
    );
    return;
  }

  if (input.length === 0 || input === 'status') {
    const active = await session.getActiveRole();
    if (!active.active || active.role === undefined) {
      host.showStatus('Transform: off');
      return;
    }
    host.showStatus(`Transform: ${active.role.selection} [${active.role.source}] · ${active.model ?? 'no model'}`);
    return;
  }

  const active = await session.setRole(input === 'off' ? undefined : input);
  if (!active.active || active.role === undefined) {
    host.showStatus('Transform: off');
  } else {
    host.showNotice(
      `Transformed into ${active.role.selection}`,
      `${active.role.description}\nSource: ${active.role.source}${active.model === undefined ? '' : `\nModel: ${active.model}`}`,
    );
  }
  if (active.model !== undefined) host.setAppState({ model: active.model });
  host.track('role_transform', {
    active: active.active,
    role: active.role?.selection,
    source: active.role?.source,
  });
}
