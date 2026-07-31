import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  listRoles,
  resolveRole,
  resolveWukongHome,
  roleTemplate,
  type RoleSummary,
} from '@wukong/wukong-sdk';
import type { Command } from 'commander';

interface RolesDeps {
  readonly cwd: () => string;
  readonly homeDir: () => string;
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

const DEFAULT_DEPS: RolesDeps = {
  cwd: () => process.cwd(),
  homeDir: () => resolveWukongHome(),
  stdout: process.stdout,
};

export function registerRolesCommand(parent: Command, overrides?: Partial<RolesDeps>): void {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const roles = parent
    .command('roles')
    .description('List, inspect, or create agent role profiles.')
    .usage('[options] [command]')
    .allowExcessArguments(true);

  const printRoles = async (): Promise<void> => {
    const items = await listRoles({ cwd: deps.cwd(), wukongHomeDir: deps.homeDir() });
    deps.stdout.write(formatRoleList(items));
  };

  roles.action(async () => {
    const [command] = roles.args;
    if (command !== undefined) {
      roles.error(
        `unknown command '${command}'. Valid commands: list, show, init. See 'wukong roles --help'.`,
      );
      return;
    }
    await printRoles();
  });

  roles
    .command('list')
    .description('List built-in, user, and project roles.')
    .action(printRoles);

  roles
    .command('show')
    .argument('<name>', 'Role name, or project:<name>.')
    .description('Show a role profile.')
    .action(async (name: string) => {
      const role = await resolveRole(name, { cwd: deps.cwd(), wukongHomeDir: deps.homeDir() });
      deps.stdout.write([
        `${role.selection} (${role.source})`,
        role.description,
        role.model === undefined ? undefined : `model: ${role.model}`,
        role.tools === undefined ? undefined : `tools: ${role.tools.join(', ')}`,
        role.verifyProfile === undefined ? undefined : `verify profile: ${role.verifyProfile}`,
        '',
        role.prompt,
        '',
      ].filter((line): line is string => line !== undefined).join('\n'));
    });

  roles
    .command('init')
    .argument('<name>', 'New lowercase role name.')
    .option('--project', 'Create under .wukong/roles for this project.', false)
    .option('--force', 'Replace an existing role file.', false)
    .description('Create a custom role template.')
    .action(async (name: string, options: { project: boolean; force: boolean }) => {
      const dir = options.project
        ? join(deps.cwd(), '.wukong', 'roles')
        : join(deps.homeDir(), 'roles');
      const path = join(dir, `${name}.md`);
      await mkdir(dir, { recursive: true });
      await writeFile(path, roleTemplate(name), { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
      deps.stdout.write(`Created ${path}\n`);
    });
}

function formatRoleList(roles: readonly RoleSummary[]): string {
  if (roles.length === 0) return 'No roles found.\n';
  const width = Math.max(...roles.map((role) => role.selection.length));
  return `${roles.map((role) => `${role.selection.padEnd(width)}  ${role.source.padEnd(7)}  ${role.description}`).join('\n')}\n`;
}
