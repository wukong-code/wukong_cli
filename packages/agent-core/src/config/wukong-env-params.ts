import {
  type ChatProvider,
  type GenerationKwargs,
  WukongChatProvider,
  type ThinkingEffort,
} from '@wukong/kosong';

import { parseFloatEnv } from '#/config/resolve';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Apply Wukong sampling params (`WUKONG_MODEL_TEMPERATURE`, `WUKONG_MODEL_TOP_P`) from
 * the environment to a chat provider. Applied at provider construction
 * (`ConfigState.provider`) so every request built from `config.provider` — the
 * main loop AND full-history compaction — carries them, matching wukong-cli where
 * these live on the shared `create_llm` provider. Applies globally to any Wukong
 * provider (not tied to `WUKONG_MODEL_NAME`).
 *
 * Non-Wukong providers — and Wukong providers with neither var set — are returned
 * unchanged. `max_tokens` is intentionally NOT handled here: `WUKONG_MODEL_MAX_TOKENS`
 * already flows through the completion-budget path (`resolveCompletionBudget`).
 */
export function applyWukongEnvSamplingParams(
  provider: ChatProvider,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof WukongChatProvider)) return provider;

  const kwargs: GenerationKwargs = {};
  const temperature = parseFloatEnv(env['WUKONG_MODEL_TEMPERATURE'], 'WUKONG_MODEL_TEMPERATURE');
  if (temperature !== undefined) kwargs.temperature = temperature;
  const topP = parseFloatEnv(env['WUKONG_MODEL_TOP_P'], 'WUKONG_MODEL_TOP_P');
  if (topP !== undefined) kwargs.top_p = topP;

  return Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;
}

/**
 * Apply the Wukong preserved-thinking passthrough (`WUKONG_MODEL_THINKING_KEEP`
 * -> `thinking.keep`) to a chat provider. Applied in `ConfigState.provider` after
 * `withThinking`, and only while thinking is on — otherwise the API would
 * receive a `thinking.keep` with no accompanying `thinking.type` it honors.
 * (Compaction uses a raw provider with thinking off, so it correctly skips this.)
 *
 * Non-Wukong providers — and an unset/blank value — are returned unchanged.
 */
export function applyWukongEnvThinkingKeep(
  provider: ChatProvider,
  thinkingLevel: ThinkingEffort,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof WukongChatProvider)) return provider;
  const keep = env['WUKONG_MODEL_THINKING_KEEP']?.trim();
  if (keep === undefined || keep.length === 0 || thinkingLevel === 'off') return provider;
  return provider.withExtraBody({ thinking: { keep } });
}
