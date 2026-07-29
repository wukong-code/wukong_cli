import {
  createProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type ModelCapability,
  type ProviderConfig,
} from '@wukong/kosong';

import { applyWukongEnvSamplingParams, applyWukongEnvThinkingKeep } from '#/config/wukong-env-params';

import type { Agent } from '..';
import { ErrorCodes, WukongError } from '../../errors';
import type { AgentConfigData, AgentConfigUpdateData } from './types';
import { resolveThinkingEffort, type ThinkingEffort } from './thinking';
import type { ResolvedRuntimeProvider } from '../../session/provider-manager';

export * from './types';
export { resolveThinkingEffort, type ThinkingEffort } from './thinking';

export class ConfigState {
  private _cwd: string;
  private _modelAlias: string | undefined;
  private _profileName: string | undefined;
  private _thinkingLevel: ThinkingEffort = 'off';
  private _systemPrompt: string = '';

  constructor(protected readonly agent: Agent) {
    this._cwd = agent.kaos.getcwd();
    this._modelAlias = agent.modelProvider?.defaultModel;
  }

  update(changed: AgentConfigUpdateData): void {
    if (Object.keys(changed).length === 0) return;

    this.agent.records.logRecord({
      type: 'config.update',
      ...changed,
    });
    this.agent.replayBuilder.push({
      type: 'config_updated',
      config: changed,
    });
    this.apply(changed);
  }

  /** Apply invocation-only config without adding replay or persistence records. */
  updateTransient(changed: AgentConfigUpdateData): void {
    if (Object.keys(changed).length === 0) return;
    this.apply(changed);
  }

  private apply(changed: AgentConfigUpdateData): void {
    if (changed.cwd) {
      this.agent.assertCwdAllowed(changed.cwd);
      this._cwd = changed.cwd;
      void this.agent.kaos.chdir(changed.cwd);
    }
    if ('modelAlias' in changed) {
      this._modelAlias = changed.modelAlias;
    }
    if (changed.profileName) {
      this._profileName = changed.profileName;
    }
    if (changed.thinkingLevel !== undefined) {
      this._thinkingLevel = resolveThinkingEffort(
        changed.thinkingLevel,
        this.agent.wukongConfig?.thinking,
      );
    }
    if (changed.systemPrompt !== undefined) {
      this._systemPrompt = changed.systemPrompt;
    }
    if (this.hasProvider && (changed.cwd !== undefined || changed.modelAlias !== undefined)) {
      this.agent.tools.initializeBuiltinTools();
    }
    this.agent.emitStatusUpdated();
  }

  data(): AgentConfigData {
    const resolved = this.tryResolvedProviderConfig();
    return {
      cwd: this.cwd,
      provider: resolved?.provider,
      modelAlias: this._modelAlias,
      modelCapabilities: resolved?.modelCapabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
    };
  }

  get cwd(): string {
    return this._cwd;
  }

  get hasModel(): boolean {
    return this._modelAlias !== undefined;
  }

  get hasProvider(): boolean {
    return this.tryResolvedProviderConfig() !== undefined;
  }

  get providerConfig(): ProviderConfig {
    const provider = this.resolvedProviderConfig?.provider;
    if (provider === undefined) {
      throw new WukongError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    return provider;
  }

  get provider(): ChatProvider {
    // All provider-level request config is applied here so every request built
    // from config.provider — the main loop AND full-history compaction — carries it:
    //   - withThinking: preserve thinking during compaction (#464)
    //   - sampling params: WUKONG_MODEL_TEMPERATURE / WUKONG_MODEL_TOP_P
    //   - thinking.keep: WUKONG_MODEL_THINKING_KEEP (only while thinking is on)
    const provider = createProvider(this.providerConfig).withThinking(this.thinkingLevel);
    return applyWukongEnvThinkingKeep(applyWukongEnvSamplingParams(provider), this.thinkingLevel);
  }

  get model(): string {
    if (this._modelAlias === undefined) {
      throw new WukongError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return this._modelAlias;
  }

  get modelAlias(): string | undefined {
    return this._modelAlias;
  }

  get thinkingLevel(): ThinkingEffort {
    // Always-thinking models cannot run with thinking disabled. Clamping in
    // the getter (rather than in update()) keeps the request builder, status
    // events, and subagent inheritance consistent, and re-applies after a
    // later model switch onto an always-thinking alias.
    if (this._thinkingLevel === 'off' && this.alwaysThinkingModel) {
      return resolveThinkingEffort('on', this.agent.wukongConfig?.thinking);
    }
    return this._thinkingLevel;
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolvedProviderConfig()?.alwaysThinking === true;
  }

  get profileName(): string | undefined {
    return this._profileName;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get modelCapabilities(): ModelCapability {
    return this.tryResolvedProviderConfig()?.modelCapabilities ?? UNKNOWN_CAPABILITY;
  }

  get maxOutputSize(): number | undefined {
    return this.tryResolvedProviderConfig()?.maxOutputSize;
  }

  private get resolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    if (this._modelAlias === undefined) return undefined;
    return this.agent.modelProvider?.resolveProviderConfig(this._modelAlias);
  }

  private tryResolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    try {
      return this.resolvedProviderConfig;
    } catch {
      return undefined;
    }
  }
}
