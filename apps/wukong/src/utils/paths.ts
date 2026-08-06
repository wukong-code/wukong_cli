/**
 * CLI-owned data path helpers.
 *
 * These paths are for local app data such as logs and input history. Config
 * files are owned by Core/SDK and intentionally do not live behind this module.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { resolveWukongHome } from '@wukong/wukong-sdk';

import {
  WUKONG_CODE_BANNER_DIR_NAME,
  WUKONG_CODE_BANNER_STATE_FILE_NAME,
  WUKONG_CODE_BIN_DIR_NAME,
  WUKONG_CODE_CACHE_DIR_NAME,
  WUKONG_CODE_INPUT_HISTORY_DIR_NAME,
  WUKONG_CODE_LOG_DIR_NAME,
  WUKONG_CODE_STATS_DIR_NAME,
  WUKONG_CODE_STATS_EVENTS_FILE_NAME,
  WUKONG_CODE_TODAY_DIR_NAME,
  WUKONG_CODE_TODAY_FOCUS_FILE_NAME,
  WUKONG_CODE_UPDATE_DIR_NAME,
  WUKONG_CODE_UPDATE_INSTALL_LOCK_FILE_NAME,
  WUKONG_CODE_UPDATE_INSTALL_STATE_FILE_NAME,
  WUKONG_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME,
  WUKONG_CODE_UPDATE_STATE_FILE_NAME,
} from '#/constant/app';

/**
 * Return the root data directory for Wukong.
 *
 * Priority: `WUKONG_CODE_HOME` > deprecated `WUKONG_HOME` > `~/.wukong`.
 * Conflicting primary and legacy values fail closed in the shared resolver.
 */
export function getDataDir(): string {
  return resolveWukongHome();
}

/**
 * Return the diagnostic log directory: `<dataDir>/logs/`.
 */
export function getLogDir(): string {
  return join(getDataDir(), WUKONG_CODE_LOG_DIR_NAME);
}

/**
 * Return the CLI cache directory: `<dataDir>/cache/`.
 */
export function getCacheDir(): string {
  return join(getDataDir(), WUKONG_CODE_CACHE_DIR_NAME);
}

/**
 * Return the managed tools directory: `<dataDir>/bin/`.
 */
export function getBinDir(): string {
  return join(getDataDir(), WUKONG_CODE_BIN_DIR_NAME);
}

/**
 * Return the update cache file: `<dataDir>/updates/latest.json`.
 */
export function getUpdateStateFile(): string {
  return join(getDataDir(), WUKONG_CODE_UPDATE_DIR_NAME, WUKONG_CODE_UPDATE_STATE_FILE_NAME);
}

/**
 * Return the update install state file: `<dataDir>/updates/install.json`.
 */
export function getUpdateInstallStateFile(): string {
  return join(getDataDir(), WUKONG_CODE_UPDATE_DIR_NAME, WUKONG_CODE_UPDATE_INSTALL_STATE_FILE_NAME);
}

/**
 * Return the update install lock file: `<dataDir>/updates/install.lock`.
 */
export function getUpdateInstallLockFile(): string {
  return join(getDataDir(), WUKONG_CODE_UPDATE_DIR_NAME, WUKONG_CODE_UPDATE_INSTALL_LOCK_FILE_NAME);
}

/**
 * Return the rollout decision log: `<dataDir>/updates/rollout.log`.
 */
export function getUpdateRolloutLogFile(): string {
  return join(getDataDir(), WUKONG_CODE_UPDATE_DIR_NAME, WUKONG_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME);
}

/**
 * Return the banner display state file: `<dataDir>/cache/banner/state.json`.
 */
export function getBannerStateFile(): string {
  return join(getCacheDir(), WUKONG_CODE_BANNER_DIR_NAME, WUKONG_CODE_BANNER_STATE_FILE_NAME);
}

/**
 * Return the stats directory: `<dataDir>/stats/`.
 */
export function getStatsDir(): string {
  return join(getDataDir(), WUKONG_CODE_STATS_DIR_NAME);
}

/**
 * Return the stats event log: `<dataDir>/stats/events.jsonl`.
 */
export function getStatsEventsFile(): string {
  return join(getStatsDir(), WUKONG_CODE_STATS_EVENTS_FILE_NAME);
}

/**
 * Return the today directory: `<dataDir>/today/`.
 */
export function getTodayDir(): string {
  return join(getDataDir(), WUKONG_CODE_TODAY_DIR_NAME);
}

/**
 * Return the today focus file: `<dataDir>/today/focus.json`.
 */
export function getTodayFocusFile(): string {
  return join(getTodayDir(), WUKONG_CODE_TODAY_FOCUS_FILE_NAME);
}

/**
 * Return the user input history file for a given working directory.
 * Layout: `<dataDir>/user-history/<md5(cwd)>.jsonl`.
 */
export function getInputHistoryFile(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), WUKONG_CODE_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
