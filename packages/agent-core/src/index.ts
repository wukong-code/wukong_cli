export * from './agent';
export * from './session';
export * from './rpc';
export * from './config';
export * from './flags';
export * from './role';
export * from './session/export';
export * from './telemetry';
export * from './errors';
export * from './plugin';
export { buildReplay } from './agent/replay/build';
export {
  flushDiagnosticLogs,
  getRootLogger,
  log,
  redact,
  resolveGlobalLogPath,
} from './logging/logger';
export { resolveLoggingConfig } from './logging/resolve-config';
export type { ResolveLoggingInput } from './logging/resolve-config';
export { installGlobalProxyDispatcher } from './utils/proxy';
export type {
  LogContext,
  LogEntry,
  LogLevel,
  LogPayload,
  Logger,
  LoggingConfig,
  RootLogger,
  SessionAttachInput,
  SessionLogHandle,
} from './logging/types';
export { USER_PROMPT_ORIGIN } from './agent/context';
export type {
  AgentContextData,
  ContextMessage,
  PromptOrigin,
  UserPromptOrigin,
} from './agent/context';
export type {
  AgentBackgroundTaskInfo,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ProcessBackgroundTaskInfo,
  QuestionBackgroundTaskInfo,
} from './agent/background';
export type { ToolServices } from './tools/support/services';
export { SingleModelProvider } from './session/provider-manager';
export type {
  BearerTokenProvider,
  ModelProvider,
  OAuthTokenProviderResolver,
  ResolvedRuntimeProvider,
} from './session/provider-manager';
export * from './snapshot-blob-lease-store';
export * from './snapshot-candidate-materializer';
export * from './worktree-lease-store';
export * from './windows-private-root-security';
export * from './windows-handle-relative-layout';
export * from './trusted-executable';
export * from './trusted-runtime-bundle';
export * from './bootstrap-private-input-store';
export * from './candidate-bootstrap-preflight';
export * from './candidate-bootstrap-plan-builder';
export * from './candidate-bootstrap-orchestrator';
export * from './candidate-bootstrap-state-store';
export * from './candidate-bootstrap-executor';
export * from './candidate-workspace-backend-capability';
export * from './candidate-agent-writer';
export * from './candidate-gate-executor';
export * from './candidate-delta-store';
export * from './candidate-review-plan';
export * from './candidate-review-broker';
export * from './candidate-gate-attempt-store';
export * from './candidate-fresh-reviewer';
export * from './candidate-gate-orchestrator';
export * from './target-promotion-lease-store';
export * from './promotion-apply-journal-store';
export * from './promotion-change-applier';
export * from './target-promotion-apply-orchestrator';
export * from './target-final-gate-attempt-store';
export * from './target-final-gate-audit-bridge';
export * from './target-final-gate-orchestrator';
export * from './target-completion-seal-store';
export * from './target-loop-terminal-finalizer';
export * from './isolated-loop-candidate-preparer';
export * from './isolated-loop-candidate-iteration';
export * from './isolated-loop-runtime';
export * from './isolated-loop-runtime-types';

// ─── Wire records (for in-monorepo consumers like apps/vis) ────────────────
export type {
  AgentRecord,
  AgentRecordEvents,
  AgentRecordOf,
  AgentRecordPersistence,
} from './agent/records';
export { AGENT_WIRE_PROTOCOL_VERSION } from './agent/records';
export type { AgentConfigUpdateData } from './agent/config';
export type { CompactionBeginData, CompactionResult } from './agent/compaction';
export type {
  PermissionApprovalResultRecord,
  PermissionMode,
} from './agent/permission';
export type { UsageRecordScope } from './agent/usage';
export type { ToolStoreUpdate } from './tools/store';
export type {
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopContentPartEvent,
  LoopToolCallEvent,
  LoopToolResultEvent,
} from './loop';
export type {
  ExecutableToolResult,
  ExecutableToolSuccessResult,
  ExecutableToolErrorResult,
} from './loop/types';

// ─── Dependency injection container ────────────────────────────────────────
export * from './di';

// ─── Base — Event<T> / Emitter<T> ──────────────────────────────────────────
// NOTE: only `Emitter` is re-exported from the top-level barrel — the new
// VSCode-style `Event<T>` symbol collides with `./rpc`'s `Event` (agent-core
// protocol Event union, exported via `export * from './rpc'` above). Callers
// that need the emitter `Event<T>` type import it from the explicit sub-path
// `@wukong/agent-core/base/common/event` (declared in `package.json`
// `exports`). This keeps the existing top-level `Event` semantics stable for
// consumers like `services/src/event/event.ts` while letting new code reach
// for the emitter type without naming clashes.
export { Emitter } from './base/common/event';

// ─── In-process services (merged from @wukong/services) ─────────────────
// Re-exports the `IXxxService` contracts, default `XxxService` implementations,
// `toProtocol*` translators and error classes. Importing this barrel triggers
// the `registerSingleton(...)` side-effects at the bottom of each `*Service.ts`,
// populating the DI registry consumed by `getSingletonServiceDescriptors()`.
//
// NOTE: `ApprovalRequest` / `ApprovalResponse` / `QuestionRequest` /
// `QuestionResult` are intentionally NOT re-exported here — they are the
// canonical protocol shapes already exported via `./rpc` (`rpc/sdk-api.ts`),
// and re-exporting them again would collide (TS2308).
export * from './services';
