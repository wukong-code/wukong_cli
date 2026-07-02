import type { WukongErrorCode } from './codes';

export interface WukongErrorOptions {
  /** JSON-serializable structured details. */
  readonly details?: Record<string, unknown>;
  /** Original error or value. Local-only; never serialized to the wire. */
  readonly cause?: unknown;
}

/**
 * The single Wukong error class.
 *
 * Discrimination is always by `code`. Cross-process consumers receive
 * `WukongErrorPayload` and must branch on `code` rather than class identity.
 */
export class WukongError extends Error {
  readonly code: WukongErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: WukongErrorCode, message: string, options: WukongErrorOptions = {}) {
    super(message);
    this.name = 'WukongError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}
