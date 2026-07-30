import { describe, expect, it } from 'vitest';

import {
  inspectCandidateWorkspaceBackendCapability,
} from '../src/candidate-workspace-backend-capability';

describe('candidate workspace backend capability', () => {
  it('keeps the experimental backend fail-closed on Windows', () => {
    expect(inspectCandidateWorkspaceBackendCapability({
      platform: 'win32',
    })).toEqual({
      available: false,
      platform: 'win32',
      backend: null,
      reasonCode: 'candidate_atomic_backend_platform_unsupported',
    });
  });

  it('fails closed when the native syscall set cannot be resolved', () => {
    expect(inspectCandidateWorkspaceBackendCapability({
      platform: 'linux',
      resolveNative: () => {
        throw new Error('koffi unavailable');
      },
    })).toEqual({
      available: false,
      platform: 'linux',
      backend: null,
      reasonCode: 'candidate_atomic_backend_native_unavailable',
    });
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'resolves the real packaged POSIX syscall set',
    () => {
      expect(inspectCandidateWorkspaceBackendCapability())
        .toMatchObject({
          available: true,
          platform: process.platform,
          backend: 'posix-openat-v1',
          reasonCode: null,
        });
    },
  );
});
