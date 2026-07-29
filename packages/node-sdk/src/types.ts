import type {
  ExportSessionManifest,
  LoopContractV3Input,
  LoopContractV2Input,
  LoopRunReviewSettingsInput,
  IsolatedLoopCandidateIterationPublicResultV1,
  IsolatedLoopPromotionProposalPublicResultV1,
  IsolatedLoopPromotionPublicResultV1,
  PrepareIsolatedLoopPromotionPayloadV1,
  PromoteIsolatedLoopCandidatePayloadV1,
  RunIsolatedLoopCandidateIterationPayloadV1,
  ResumeSessionResult,
  ShellEnvironment,
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
} from '@wukong/agent-core';
import type { Kaos } from '@wukong/kaos';
import type { WukongHostIdentity, OAuthRefreshOutcome } from '@wukong/wukong-oauth';
import type { ContentPart } from '@wukong/kosong';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type {
  AgentReplayRecord,
  AgentBackgroundTaskInfo,
  BackgroundConfig,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ConfigDiagnostics,
  ContextMessage,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  ActiveRole,
  RoleDefinition,
  RoleSource,
  RoleSummary,
  ExportSessionManifest,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  LoopResult,
  LoopResultBlocker,
  LoopResultCheck,
  LoopContract,
  LoopContractV2,
  LoopContractV2Input,
  LoopContractV3,
  LoopContractV3Input,
  WukongConfig,
  WukongConfigPatch,
  LoopControl,
  McpServerInfo,
  McpStartupMetrics,
  ModelAlias,
  WukongServiceConfig,
  OAuthRef,
  PluginGithubMetadata,
  PluginGithubRef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSource,
  PluginSummary,
  ProcessBackgroundTaskInfo,
  PromptOrigin,
  ProviderConfig,
  ProviderType,
  QuestionBackgroundTaskInfo,
  ReloadSummary,
  ResumedAgentState,
  ServicesConfig,
  ShellEnvironment,
  SkillSummary,
  ThinkingConfig,
  ToolInfo,
  IsolatedLoopCandidateIterationPublicResultV1,
  IsolatedLoopPromotionProposalPublicResultV1,
  IsolatedLoopPromotionPublicResultV1,
  PrepareIsolatedLoopPromotionPayloadV1,
  PromoteIsolatedLoopCandidatePayloadV1,
  RunIsolatedLoopCandidateIterationPayloadV1,
} from '@wukong/agent-core';

export type { WukongHostIdentity, OAuthRefreshOutcome };
export type { TelemetryClient, TelemetryContextPatch, TelemetryProperties };
export type { ContentPart, Role, ToolCall } from '@wukong/kosong';

export type PermissionMode = 'yolo' | 'manual' | 'auto';

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
  readonly stopCondition?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly reviewModel?: string;
  readonly maxIterations?: number;
  readonly minIntervalMs?: number;
  readonly loopContract?: LoopContractV2Input | LoopContractV3Input;
}

export interface ResumeGoalInput {
  readonly reviewSettings?: LoopRunReviewSettingsInput;
}

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export interface WukongHarnessOptions {
  readonly identity?: WukongHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly autoLoadConfig?: boolean | undefined;
  readonly uiMode?: string;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface CreateSessionOptions {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly planMode?: boolean;
  readonly metadata?: JsonObject | undefined;
  readonly kaos?: Kaos | undefined;
  readonly persistenceKaos?: Kaos | undefined;
  readonly additionalDirs?: readonly string[];
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface RenameSessionInput {
  readonly id: string;
  readonly title: string;
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly kaos?: Kaos | undefined;
  readonly persistenceKaos?: Kaos | undefined;
  readonly additionalDirs?: readonly string[];
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface ReloadSessionInput extends ResumeSessionInput {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface AddAdditionalDirInput {
  readonly id: string;
  readonly path: string;
  readonly persist: boolean;
}

export interface AddAdditionalDirOptions {
  readonly persist: boolean;
}

export interface ForkSessionInput {
  readonly id: string;
  readonly forkId?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
}

export interface ExportSessionInput {
  readonly id: string;
  readonly outputPath?: string | undefined;
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ListSessionsOptions {
  readonly workDir?: string;
  readonly sessionId?: string;
}

export interface GetConfigOptions {
  readonly reload?: boolean | undefined;
}

export interface CompactOptions {
  readonly instruction?: string | undefined;
}

export interface ReloadSessionOptions {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface PlanInfo {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export type SessionPlan = PlanInfo | null;

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsage {
  readonly byModel?: Record<string, TokenUsage> | undefined;
  readonly currentTurn?: TokenUsage | undefined;
  readonly total?: TokenUsage | undefined;
}

export interface SessionStatus {
  readonly model?: string;
  readonly thinkingLevel: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode?: boolean | undefined;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: SessionUsage;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

export type ResumedSessionState = Pick<ResumeSessionResult, 'sessionMetadata' | 'agents' | 'warning'>;

export interface ResumedSessionSummary extends SessionSummary, ResumedSessionState { }
