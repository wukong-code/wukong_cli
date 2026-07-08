import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isWukongError: vi.fn(),
  WUKONG_ERROR_INFO: {} as Record<string, { readonly title: string }>,
}));

vi.mock('@wukong/wukong-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wukong/wukong-sdk')>();
  return {
    ...actual,
    isWukongError: mocks.isWukongError,
    WUKONG_ERROR_INFO: mocks.WUKONG_ERROR_INFO,
  };
});

import { formatStartupError } from '#/cli/startup-error';

describe('formatStartupError', () => {
  beforeEach(() => {
    mocks.isWukongError.mockReset();
    mocks.WUKONG_ERROR_INFO['E_AUTH'] = { title: 'Authentication failed' };
  });

  it('formats a plain error with the default operation', () => {
    mocks.isWukongError.mockReturnValue(false);

    const output = formatStartupError(new Error('network down'));

    expect(output).toContain('failed to start shell');
    expect(output).toContain('network down');
  });

  it('uses a custom operation when provided', () => {
    mocks.isWukongError.mockReturnValue(false);

    const output = formatStartupError('boom', { operation: 'load config' });

    expect(output).toContain('failed to load config');
    expect(output).toContain('boom');
  });

  it('formats a Wukong error using the error info title', () => {
    const error = { code: 'E_AUTH', message: 'token expired' };
    mocks.isWukongError.mockReturnValue(true);

    const output = formatStartupError(error);

    expect(output).toContain('Authentication failed');
    expect(output).toContain('token expired');
  });

  it('accepts a custom error style', () => {
    mocks.isWukongError.mockReturnValue(false);

    const output = formatStartupError('plain error', {
      errorStyle: (text) => `[styled]${text}[/styled]`,
    });

    expect(output).toContain('[styled]');
  });
});
