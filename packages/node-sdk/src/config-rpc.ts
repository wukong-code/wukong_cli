import {
  createRPC,
  ErrorCodes,
  WukongError,
  parseConfigString,
  resolveConfigPath,
  type RPCMethods,
} from '@wukong/agent-core';
import { z } from 'zod';

export type WukongConfigValidationPathSegment = string | number;

export interface WukongConfigValidationIssue {
  readonly path: readonly WukongConfigValidationPathSegment[];
  readonly message: string;
}

export interface ResolveWukongConfigPathInput {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}

export interface ValidateWukongConfigTomlInput {
  readonly text: string;
  readonly filePath?: string | undefined;
}

export interface WukongConfigRpc {
  resolveConfigPath(input?: ResolveWukongConfigPathInput): Promise<string>;
  validateConfigToml(input: ValidateWukongConfigTomlInput): Promise<void>;
}

interface WukongConfigCoreRpc {
  resolveConfigPath(input: ResolveWukongConfigPathInput): string;
  validateConfigToml(input: ValidateWukongConfigTomlInput): void;
}

interface WukongConfigClientRpc {}

class WukongConfigCoreRpcImpl implements WukongConfigCoreRpc {
  resolveConfigPath(input: ResolveWukongConfigPathInput): string {
    return resolveConfigPath(input);
  }

  validateConfigToml(input: ValidateWukongConfigTomlInput): void {
    try {
      parseConfigString(input.text, input.filePath);
    } catch (error) {
      const validationIssues = extractValidationIssues(error);
      if (validationIssues !== undefined) {
        throw toConfigValidationError(error, validationIssues);
      }
      throw error;
    }
  }
}

export class WukongConfigRpcClient implements WukongConfigRpc {
  private readonly ready: Promise<RPCMethods<WukongConfigCoreRpc>>;

  constructor() {
    const [coreRpc, clientRpc] = createRPC<WukongConfigCoreRpc, WukongConfigClientRpc>();
    void coreRpc(new WukongConfigCoreRpcImpl());
    this.ready = clientRpc({});
  }

  async resolveConfigPath(input: ResolveWukongConfigPathInput = {}): Promise<string> {
    const rpc = await this.ready;
    return rpc.resolveConfigPath(input);
  }

  async validateConfigToml(input: ValidateWukongConfigTomlInput): Promise<void> {
    const rpc = await this.ready;
    await rpc.validateConfigToml(input);
  }
}

export function createWukongConfigRpc(): WukongConfigRpc {
  return new WukongConfigRpcClient();
}

function toConfigValidationError(
  error: unknown,
  validationIssues: readonly WukongConfigValidationIssue[],
): WukongError {
  const details =
    error instanceof WukongError && error.details !== undefined
      ? { ...error.details, validationIssues }
      : { validationIssues };

  if (error instanceof WukongError) {
    return new WukongError(error.code, error.message, { details });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new WukongError(ErrorCodes.CONFIG_INVALID, message, { details });
}

function extractValidationIssues(error: unknown): readonly WukongConfigValidationIssue[] | undefined {
  const zodError = findZodError(error);
  if (zodError === undefined) return undefined;
  return zodError.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}
