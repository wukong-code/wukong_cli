import { describe, expect, it, vi } from 'vitest';

import {
  inspectCandidateWorkspaceBackendCapability,
} from '../src/candidate-workspace-backend-capability';

describe('candidate workspace backend capability', () => {
  it('blocks Windows when protected private-root ACL primitives are unavailable', () => {
    const resolveNative = vi.fn();
    const resolveWindowsHandleNative = vi.fn();

    expect(inspectCandidateWorkspaceBackendCapability({
      platform: 'win32',
      resolveNative,
      resolveWindowsPrivateRootSecurity: () => {
        throw new Error('advapi32 unavailable');
      },
      resolveWindowsHandleNative,
    })).toEqual({
      available: false,
      platform: 'win32',
      backend: null,
      reasonCode:
        'candidate_atomic_backend_windows_private_root_unavailable',
    });
    expect(resolveNative).not.toHaveBeenCalled();
    expect(resolveWindowsHandleNative).not.toHaveBeenCalled();
  });

  it('blocks Windows when handle-relative primitives are unavailable', () => {
    expect(inspectCandidateWorkspaceBackendCapability({
      platform: 'win32',
      resolveWindowsPrivateRootSecurity: () => {},
      resolveWindowsHandleNative: () => {
        throw new Error('ntdll unavailable');
      },
    })).toEqual({
      available: false,
      platform: 'win32',
      backend: null,
      reasonCode:
        'candidate_atomic_backend_windows_handle_unavailable',
    });
  });

  it('freezes the Windows capability contract only after both preflights', () => {
    expect(inspectCandidateWorkspaceBackendCapability({
      platform: 'win32',
      resolveWindowsPrivateRootSecurity: () => {},
      resolveWindowsHandleNative: () => {},
    })).toEqual({
      available: true,
      platform: 'win32',
      backend: 'windows-nt-handle-v1',
      reasonCode: null,
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
