import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { createWukongDeviceId, WUKONG_CODE_PROVIDER_NAME } from '@wukong/wukong-oauth';
import {
  WukongAuthFacade,
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveWukongHome,
  type WukongConfig,
  type WukongHarness,
  type TelemetryClient,
} from '@wukong/wukong-sdk';
import {
  initializeTelemetry,
  setTelemetryContext,
  track,
  withTelemetryContext,
} from '@wukong/wukong-telemetry';

import { CLI_USER_AGENT_PRODUCT, WEB_UI_MODE } from '#/constant/app';

import { createWukongCodeHostIdentity } from './version';

export interface CliTelemetryBootstrap {
  readonly homeDir: string;
  readonly deviceId: string;
  readonly firstLaunch: boolean;
}

export interface InitializeCliTelemetryOptions {
  readonly harness: WukongHarness;
  readonly bootstrap: CliTelemetryBootstrap;
  readonly config: Pick<WukongConfig, 'defaultModel' | 'telemetry'>;
  readonly version: string;
  readonly uiMode: string;
  readonly model?: string;
}

export function createCliTelemetryBootstrap(): CliTelemetryBootstrap {
  let firstLaunch = false;
  const homeDir = resolveWukongHome();
  const deviceId = createWukongDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  const installerMarker = join(homeDir, 'install_first_run_pending');
  if (!firstLaunch && existsSync(installerMarker)) {
    firstLaunch = true;
    try {
      unlinkSync(installerMarker);
    } catch {
      // Best effort: a read-only home must not block startup.
    }
  }
  return { homeDir, deviceId, firstLaunch };
}

export function initializeCliTelemetry(options: InitializeCliTelemetryOptions): void {
  initializeTelemetry({
    homeDir: options.harness.homeDir,
    deviceId: options.bootstrap.deviceId,
    enabled: options.config.telemetry !== false,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: options.uiMode,
    model: options.model ?? options.config.defaultModel,
    getAccessToken: async () =>
      (await options.harness.auth.getCachedAccessToken(WUKONG_CODE_PROVIDER_NAME)) ?? null,
  });
  if (options.bootstrap.firstLaunch) {
    options.harness.track('first_run');
  }
}

export interface InitializeServerTelemetryOptions {
  readonly version: string;
}

/**
 * Bootstrap telemetry for the `wukong web` / `wukong server run` host.
 *
 * Mirrors {@link initializeCliTelemetry}: mints the device id, reads config to
 * honor the `telemetry` toggle and pick up the default model, attaches the
 * sink with `ui_mode = "web"`, and returns a {@link TelemetryClient} the
 * caller hands to `startServer` via `coreProcessOptions.telemetry`. That wires
 * the same real client into `WukongCore`, so agent-core events emitted inside the
 * server process (`mcp_connected`, `session_load_failed`, plan-mode / cron
 * events, …) actually leave the process carrying the enriched context
 * (`app_name` / `version` / `ui_mode` / `model` / platform fields).
 *
 * The returned client wraps the `@wukong/wukong-telemetry` module
 * functions, so the module-level `track` / `withTelemetryContext` (used to
 * fire the startup event) share the same underlying client + sink.
 */
export function initializeServerTelemetry(
  options: InitializeServerTelemetryOptions,
): TelemetryClient {
  const bootstrap = createCliTelemetryBootstrap();
  const configPath = resolveConfigPath({ homeDir: bootstrap.homeDir });
  const config = readServerTelemetryConfig(configPath);
  const auth = new WukongAuthFacade({
    homeDir: bootstrap.homeDir,
    configPath,
    identity: createWukongCodeHostIdentity(options.version),
  });

  initializeTelemetry({
    homeDir: bootstrap.homeDir,
    deviceId: bootstrap.deviceId,
    enabled: config.telemetry !== false,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: WEB_UI_MODE,
    model: config.defaultModel,
    getAccessToken: async () => (await auth.getCachedAccessToken(WUKONG_CODE_PROVIDER_NAME)) ?? null,
  });

  return {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
}

function readServerTelemetryConfig(
  configPath: string,
): Pick<WukongConfig, 'telemetry' | 'defaultModel'> {
  try {
    const { config, fileError } = loadRuntimeConfigSafe(configPath);
    // A broken config fails the server on its own inside WukongCore; for
    // telemetry just degrade to "enabled, no model" so we never block startup.
    if (fileError !== undefined) return {};
    return config;
  } catch {
    return {};
  }
}
