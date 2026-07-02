

import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveWukongHome } from '@wukong/agent-core';


export const WUKONG_SERVER_LABEL = 'ai.wukong.wukong-server';


export const WUKONG_SERVER_PLIST_FILENAME = `${WUKONG_SERVER_LABEL}.plist`;


export const WUKONG_SERVER_SYSTEMD_UNIT = 'wukong-server.service';


export const WUKONG_SERVER_TASK_NAME = 'WukongServer';


export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', WUKONG_SERVER_PLIST_FILENAME);
}


export function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', WUKONG_SERVER_SYSTEMD_UNIT);
}


export function supervisorLogPath(): string {
  return join(resolveWukongHome(), 'server', 'server.log');
}


export function installPlanPath(): string {
  return join(resolveWukongHome(), 'server', 'install.json');
}


export function guiDomain(uid: number = process.getuid?.() ?? 0): string {
  return `gui/${uid}`;
}
