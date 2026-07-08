import { ErrorCodes } from '@wukong/wukong-sdk';

export const PRODUCT_NAME = 'Wukong Code';
// Short product name used in model-provider labels and the /status header.
export const PRODUCT_NAME_SHORT = 'Wukong';
export const CLI_COMMAND_NAME = 'wukong';
export const PROCESS_NAME = 'wukong';

// Used in telemetry app names and HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'wukong-code';
export const CLI_UI_MODE = 'shell';
// Telemetry ui_mode for the `wukong web` / `wukong server run` host. Same product
// as the CLI (CLI_USER_AGENT_PRODUCT); the surface is distinguished by ui_mode.
export const WEB_UI_MODE = 'web';

// Give telemetry a short flush window without making CLI exit feel stuck.
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

// Published npm package name; this can differ from the executable command.
export const NPM_PACKAGE_NAME = '@wukong.today/code';

// App-owned data paths. SDK/core runtime config is intentionally not routed here.
export const WUKONG_CODE_HOME_ENV = 'WUKONG_CODE_HOME';
export const WUKONG_CODE_DATA_DIR_NAME = '.wukong';
export const WUKONG_CODE_LOG_DIR_NAME = 'logs';
export const WUKONG_CODE_CACHE_DIR_NAME = 'cache';
export const WUKONG_CODE_UPDATE_DIR_NAME = 'updates';
export const WUKONG_CODE_BIN_DIR_NAME = 'bin';
export const WUKONG_CODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const WUKONG_CODE_UPDATE_INSTALL_STATE_FILE_NAME = 'install.json';
export const WUKONG_CODE_UPDATE_INSTALL_LOCK_FILE_NAME = 'install.lock';
export const WUKONG_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME = 'rollout.log';
export const WUKONG_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const WUKONG_CODE_BANNER_DIR_NAME = 'banner';
export const WUKONG_CODE_BANNER_STATE_FILE_NAME = 'state.json';

// Managed Wukong auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:wukong';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Derived from sdk's ErrorCodes so a future rename in core
// auto-propagates instead of silently breaking the startup recovery path.
export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

export const FEEDBACK_ISSUE_URL = 'https://github.com/mutnpc/wukong-code/issues';

// Sent in the feedback `version` field so the backend can distinguish this
// TypeScript client from clients that send a bare version.
export const FEEDBACK_VERSION_PREFIX = 'wukong-';

// Telemetry event name; keep stable for dashboard queries.
export const FEEDBACK_TELEMETRY_EVENT = 'feedback_submitted';

// CDN source of truth for version checks and plugin metadata.
export const WUKONG_CODE_CDN_BASE = 'https://wukong.today';
export const WUKONG_CODE_CDN_LATEST_URL = `${WUKONG_CODE_CDN_BASE}/latest`;
// Rollout manifest consumed by update checks; the plain-text `/latest` above
// stays unchanged forever — already-shipped clients hard-fail on non-semver
// bodies, and the CDN install scripts read it for fresh installs.
export const WUKONG_CODE_CDN_LATEST_JSON_URL = `${WUKONG_CODE_CDN_BASE}/latest.json`;
export const WUKONG_CODE_TIPS_BANNER_URL = 'https://cdn.wukong.today/wukong-tips/tips.json';
export const WUKONG_CODE_PLUGIN_MARKETPLACE_URL = `${WUKONG_CODE_CDN_BASE}/plugins/marketplace.json`;
export const WUKONG_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'WUKONG_CODE_PLUGIN_MARKETPLACE_URL';
