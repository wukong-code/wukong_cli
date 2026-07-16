import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { load as loadYaml } from 'js-yaml';

import { resolveWukongHome } from '../config/path';
import { BUILTIN_ROLES } from './builtins';
import type { RoleCatalogOptions, RoleDefinition, RoleSource, RoleSummary } from './types';

const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface RoleFrontmatter {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly model?: unknown;
  readonly tools?: unknown;
  readonly verify_profile?: unknown;
}

export async function listRoles(options: RoleCatalogOptions): Promise<readonly RoleSummary[]> {
  const [userRoles, projectRoles] = await Promise.all([
    loadRolesFromDir(join(resolveWukongHome(options.wukongHomeDir), 'roles'), 'user'),
    loadRolesFromDir(join(options.cwd, '.wukong', 'roles'), 'project'),
  ]);
  const builtinNames = new Set(BUILTIN_ROLES.map((role) => role.name));
  return [
    ...BUILTIN_ROLES,
    ...userRoles.filter((role) => !builtinNames.has(role.name)),
    ...projectRoles.filter((role) => !builtinNames.has(role.name)),
  ].map(roleSummary);
}

export async function resolveRole(
  selection: string,
  options: RoleCatalogOptions,
): Promise<RoleDefinition> {
  const normalized = selection.trim().toLowerCase();
  if (normalized.length === 0) throw new Error('Role name cannot be empty.');

  const builtin = BUILTIN_ROLES.find((role) => role.name === normalized);
  if (builtin !== undefined) return builtin;

  const projectPrefix = 'project:';
  const explicitProject = normalized.startsWith(projectPrefix);
  const name = explicitProject ? normalized.slice(projectPrefix.length) : normalized;
  assertRoleName(name);
  const source: RoleSource = explicitProject ? 'project' : 'user';
  const dir = explicitProject
    ? join(options.cwd, '.wukong', 'roles')
    : join(resolveWukongHome(options.wukongHomeDir), 'roles');
  const role = await loadRoleFile(join(dir, `${name}.md`), source);
  if (role === undefined) {
    const hint = explicitProject
      ? `Project role "${name}" was not found under .wukong/roles/.`
      : `Role "${name}" was not found. Use project:${name} to select a project role.`;
    throw new Error(hint);
  }
  return role;
}

export function roleTemplate(name: string): string {
  assertRoleName(name);
  return `---\ndescription: Describe when this role should be used\n# model: provider/model-alias\n# tools:\n#   - Read\n#   - Grep\n# verify_profile: default\n---\n\nDescribe how the agent should behave while this role is active.\n`;
}

export function assertRoleName(name: string): void {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new Error('Role names must use lowercase letters, numbers, hyphens, or underscores.');
  }
}

async function loadRolesFromDir(dir: string, source: RoleSource): Promise<RoleDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const roles = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.md'))
      .toSorted()
      .map((entry) => loadRoleFile(join(dir, entry), source)),
  );
  return roles.filter((role): role is RoleDefinition => role !== undefined);
}

async function loadRoleFile(path: string, source: RoleSource): Promise<RoleDefinition | undefined> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const name = basename(path, '.md').toLowerCase();
  assertRoleName(name);
  const { frontmatter, body } = parseRoleMarkdown(content, path);
  const declaredName = optionalString(frontmatter.name)?.toLowerCase();
  if (declaredName !== undefined && declaredName !== name) {
    throw new Error(`Role name "${declaredName}" does not match filename "${name}.md".`);
  }
  const description = optionalString(frontmatter.description) ?? firstBodyLine(body) ?? `Custom ${source} role`;
  const tools = optionalStringArray(frontmatter.tools, path);
  return {
    name,
    selection: source === 'project' ? `project:${name}` : name,
    source,
    description,
    prompt: body,
    model: optionalString(frontmatter.model),
    tools,
    verifyProfile: optionalString(frontmatter.verify_profile),
    path,
  };
}

function parseRoleMarkdown(content: string, path: string): { frontmatter: RoleFrontmatter; body: string } {
  if (!content.startsWith('---\n')) {
    const body = content.trim();
    if (body.length === 0) throw new Error(`Role file is empty: ${path}`);
    return { frontmatter: {}, body };
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`Role frontmatter is not closed: ${path}`);
  let parsed: unknown;
  try {
    parsed = loadYaml(content.slice(4, end));
  } catch (error) {
    throw new Error(
      `Invalid role frontmatter at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed) && parsed !== undefined) throw new Error(`Role frontmatter must be an object: ${path}`);
  if (isRecord(parsed)) {
    const allowed = new Set(['name', 'description', 'model', 'tools', 'verify_profile']);
    const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`Unsupported role field at ${path}: ${unknown.join(', ')}`);
  }
  const body = content.slice(end + 5).trim();
  if (body.length === 0) throw new Error(`Role prompt is empty: ${path}`);
  return { frontmatter: (parsed ?? {}) as RoleFrontmatter, body };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalStringArray(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`Role tools must be a list of tool names: ${path}`);
  }
  return value.map((entry) => (entry as string).trim());
}

function firstBodyLine(body: string): string | undefined {
  return body.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
}

export function roleSummary(role: RoleDefinition): RoleSummary {
  const { prompt: _prompt, ...summary } = role;
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}
