import {
  ErrorCodes,
  ProviderManager,
  WukongError,
  resolveWukongHome,
  type OAuthRef,
  type WukongConfig,
} from '@wukong/agent-core';
import {
  createProvider,
  createUserMessage,
  extractText,
  generate,
  inputTotal,
  type ProviderRequestAuth,
} from '@wukong/kosong';
import {
  createWukongDefaultHeaders,
  parseWukongCustomHeaders,
  type WukongHostIdentity,
} from '@wukong/wukong-oauth';

const DEFAULT_ISOLATED_REVIEW_TIMEOUT_MS = 90_000;

export interface IsolatedReviewTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export type IsolatedReviewOAuthResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => IsolatedReviewTokenProvider | undefined;

export interface IsolatedReviewCompletionOptions {
  readonly config: WukongConfig;
  readonly modelAlias?: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly homeDir?: string;
  readonly identity?: WukongHostIdentity;
  readonly resolveOAuthTokenProvider?: IsolatedReviewOAuthResolver;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface IsolatedReviewCompletionResult {
  readonly modelAlias: string;
  readonly providerId: string;
  readonly text: string;
  readonly finishReason: string | null;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export async function runIsolatedReviewCompletion(
  options: IsolatedReviewCompletionOptions,
): Promise<IsolatedReviewCompletionResult> {
  const modelAlias = nonEmpty(options.modelAlias) ?? nonEmpty(options.config.defaultModel);
  if (modelAlias === undefined) {
    throw new WukongError(
      ErrorCodes.CONFIG_INVALID,
      'No reviewer model configured. Set default_model in config.toml or pass --model <alias>.',
    );
  }

  const wukongRequestHeaders: Record<string, string> = {
    ...parseWukongCustomHeaders(),
    ...(options.identity === undefined
      ? {}
      : createWukongDefaultHeaders({
          homeDir: resolveWukongHome(options.homeDir),
          ...options.identity,
        })),
  };

  const manager = new ProviderManager({
    config: options.config,
    wukongRequestHeaders,
    resolveOAuthTokenProvider: options.resolveOAuthTokenProvider,
  });
  const resolved = manager.resolveProviderConfig(modelAlias);
  const authorize = manager.resolveAuth(modelAlias);
  const chatProvider = createProvider(resolved.provider);

  const timeoutMs = options.timeoutMs ?? DEFAULT_ISOLATED_REVIEW_TIMEOUT_MS;
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Isolated review timed out after ${String(timeoutMs)}ms.`));
  }, timeoutMs);

  try {
    const executeGenerate = (auth: ProviderRequestAuth | undefined) =>
      generate(
        chatProvider,
        options.systemPrompt,
        [],
        [createUserMessage(options.userPrompt)],
        undefined,
        {
          signal: controller.signal,
          auth,
        },
      );

    const generated = authorize === undefined
      ? await executeGenerate(undefined)
      : await authorize(executeGenerate);

    return {
      modelAlias,
      providerId: resolved.providerName,
      text: extractText(generated.message),
      finishReason: generated.finishReason,
      usage: generated.usage === null
        ? undefined
        : {
            inputTokens: inputTotal(generated.usage),
            outputTokens: generated.usage.output,
          },
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
