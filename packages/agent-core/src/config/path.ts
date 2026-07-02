import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

export function resolveWukongHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['WUKONG_CODE_HOME'] ?? join(homedir(), '.wukong');
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
