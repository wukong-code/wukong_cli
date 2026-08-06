import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'pathe';

import { ErrorCodes, WukongError } from '#/errors';

export function resolveWukongHome(homeDir?: string | undefined): string {
  if (homeDir !== undefined) return homeDir;
  const primary = nonEmptyEnv('WUKONG_CODE_HOME');
  const legacy = nonEmptyEnv('WUKONG_HOME');
  if (
    primary !== undefined
    && legacy !== undefined
    && resolve(primary) !== resolve(legacy)
  ) {
    throw new WukongError(
      ErrorCodes.CONFIG_INVALID,
      'WUKONG_CODE_HOME and deprecated WUKONG_HOME point to different directories. Unset WUKONG_HOME or make both values identical.',
    );
  }
  return primary ?? legacy ?? join(homedir(), '.wukong');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveWukongHome(input.homeDir), 'config.toml');
}

export function ensureWukongHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}

function nonEmptyEnv(name: 'WUKONG_CODE_HOME' | 'WUKONG_HOME'): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
