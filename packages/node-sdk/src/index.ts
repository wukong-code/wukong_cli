export { WukongHarness } from '#/wukong-harness';
export type { WukongHarnessRuntimeOptions } from '#/wukong-harness';
export { Session } from '#/session';
export { WukongAuthFacade } from '#/auth';
export { createWukongHarness, SDKRpcClient, type SDKRpcClientOptions } from '#/sdk-rpc-client';
export {
  createWukongConfigRpc,
  WukongConfigRpcClient,
  type WukongConfigRpc,
  type WukongConfigValidationIssue,
  type WukongConfigValidationPathSegment,
  type ResolveWukongConfigPathInput,
  type ValidateWukongConfigTomlInput,
} from '#/config-rpc';
export { SDKRpcClientBase } from '#/rpc';
export { WukongProvider } from '#/wukong-model-provider';
export type { WukongProviderOptions } from '#/wukong-model-provider';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  estimateUsageCost,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogModel,
  CatalogModelCost,
  CatalogModelEntry,
  CatalogProviderEntry,
} from '#/catalog';

export {
  ErrorCodes,
  WukongError,
  type WukongErrorCode,
  type WukongErrorInfo,
  type WukongErrorOptions,
  type WukongErrorPayload,
  WUKONG_ERROR_INFO,
  fromWukongErrorPayload,
  isWukongError,
  toWukongErrorPayload,
} from '@wukong/agent-core';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay inside agent-core.
export {
  flushDiagnosticLogs,
  log,
  redact,
  resolveGlobalLogPath,
  resolveWukongHome,
} from '@wukong/agent-core';
export type { LogContext, LogLevel, LogPayload, Logger } from '@wukong/agent-core';

// Host-side config helpers — safe config reader + config path resolution, used
// by hosts (e.g. the CLI's server telemetry bootstrap) that need to inspect
// config without spinning up a full WukongCore.
export { loadRuntimeConfigSafe, resolveConfigPath } from '@wukong/agent-core';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '@wukong/agent-core';

export {
  assertRoleName,
  BUILTIN_ROLES,
  listRoles,
  resolveRole,
  roleTemplate,
} from '@wukong/agent-core';

// Experimental feature flags — types only. Resolved values come from
// `WukongHarness.getExperimentalFeatures()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@wukong/agent-core';

export type {
  WukongAuthLoginResult,
  WukongAuthLogoutResult,
  WukongAuthSubmitFeedbackInput,
} from '#/auth';

export * from '#/events';
export type * from '#/types';
