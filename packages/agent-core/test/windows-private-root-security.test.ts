import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

import {
  assertExactWindowsPrivateRootSddl,
  assertWindowsPrivateRootSecurityProof,
  attestWindowsPrivateRootSecurity,
  inspectWindowsPrivateRootSecurityBackendCapability,
  type WindowsPrivateRootSecurityObservationV1,
} from '../src/windows-private-root-security';

const exactObservation: WindowsPrivateRootSecurityObservationV1 = {
  openedHandleRelative: true,
  finalPathMatches: true,
  fileType: 'directory',
  reparsePoint: false,
  ownerSidMatchesCurrentUser: true,
  daclPresent: true,
  daclNull: false,
  daclProtected: true,
  allowedPrincipals: ['CURRENT_USER', 'LOCAL_SYSTEM'],
  inheritableToChildren: true,
};
const currentUserSid = 'S-1-5-21-1000-1001-1002-1003';
const exactSddl =
  `O:${currentUserSid}D:P`
  + `(A;OICI;FA;;;${currentUserSid})`
  + '(A;CIOI;FA;;;SY)';
const exactRoot = resolve(
  'test-fixtures/windows-private-root/isolated-loop',
);
const otherRoot = resolve(
  'test-fixtures/windows-private-root/target-promotions',
);

describe('Windows private durable root security', () => {
  it('resolves native ACL primitives without touching a path', () => {
    const resolveNative = vi.fn();

    expect(inspectWindowsPrivateRootSecurityBackendCapability({
      platform: 'win32',
      resolveNative,
    })).toEqual({
      available: true,
      platform: 'win32',
      backend: 'windows-protected-owner-dacl-v1',
      reasonCode: null,
    });
    expect(resolveNative).toHaveBeenCalledOnce();
  });

  it('fails closed when native ACL primitives are unavailable', () => {
    expect(inspectWindowsPrivateRootSecurityBackendCapability({
      platform: 'win32',
      resolveNative: () => {
        throw new Error('advapi32 unavailable');
      },
    })).toEqual({
      available: false,
      platform: 'win32',
      backend: null,
      reasonCode: 'windows_private_root_native_unavailable',
    });
  });

  it('does not attempt native resolution on a non-Windows platform', () => {
    const resolveNative = vi.fn();

    expect(inspectWindowsPrivateRootSecurityBackendCapability({
      platform: 'linux',
      resolveNative,
    })).toEqual({
      available: false,
      platform: 'linux',
      backend: null,
      reasonCode: 'windows_private_root_platform_unsupported',
    });
    expect(resolveNative).not.toHaveBeenCalled();
  });

  it('binds an exact protected owner DACL observation to one root', () => {
    const proof = attestWindowsPrivateRootSecurity(
      exactRoot,
      exactObservation,
    );

    expect(() => {
      assertWindowsPrivateRootSecurityProof(
        proof,
        exactRoot,
      );
    }).not.toThrow();
    expect(() => {
      assertWindowsPrivateRootSecurityProof(
        proof,
        otherRoot,
      );
    }).toThrow(/does not bind/u);
    expect(proof.toJSON()).toEqual({
      schemaVersion: 'windows-private-root-security-proof-v1',
      rootPath: '[REDACTED]',
    });
  });

  it('accepts only the protected current-user and LocalSystem SDDL', () => {
    expect(() => {
      assertExactWindowsPrivateRootSddl({
        sddl: exactSddl,
        currentUserSid,
        ownerSid: currentUserSid,
        daclPresent: true,
      });
    }).not.toThrow();
    expect(() => {
      assertExactWindowsPrivateRootSddl({
        sddl: exactSddl.replace('D:P', 'D:PAI'),
        currentUserSid,
        ownerSid: currentUserSid,
        daclPresent: true,
      });
    }).not.toThrow();
  });

  it.each([
    ['missing DACL', {
      daclPresent: false,
    }],
    ['foreign owner pointer', {
      ownerSid: 'S-1-5-21-9-9-9-9',
    }],
    ['unprotected DACL', {
      sddl: exactSddl.replace('D:P', 'D:'),
    }],
    ['inherited ACE', {
      sddl: exactSddl.replace('OICI', 'OICIID'),
    }],
    ['write-only ACE', {
      sddl: exactSddl.replace('FA', 'FW'),
    }],
    ['extra administrators', {
      sddl: `${exactSddl}(A;OICI;FA;;;BA)`,
    }],
    ['deny ACE', {
      sddl: exactSddl.replace('(A;OICI', '(D;OICI'),
    }],
    ['duplicate user', {
      sddl: exactSddl.replace(
        '(A;CIOI;FA;;;SY)',
        `(A;OICI;FA;;;${currentUserSid})`,
      ),
    }],
  ])('rejects %s in an exact private-root SDDL', (_name, patch) => {
    expect(() => {
      assertExactWindowsPrivateRootSddl({
        sddl: exactSddl,
        currentUserSid,
        ownerSid: currentUserSid,
        daclPresent: true,
        ...patch,
      });
    }).toThrow(/descriptor is invalid/u);
  });

  it.each([
    ['path-based open', { openedHandleRelative: false }],
    ['path mismatch', { finalPathMatches: false }],
    ['reparse point', { reparsePoint: true }],
    ['foreign owner', { ownerSidMatchesCurrentUser: false }],
    ['missing DACL', { daclPresent: false }],
    ['null DACL', { daclNull: true }],
    ['inherited DACL', { daclProtected: false }],
    ['extra principal', {
      allowedPrincipals: [
        'CURRENT_USER',
        'LOCAL_SYSTEM',
        'BUILTIN_ADMINISTRATORS',
      ],
    }],
    ['non-inheritable ACL', { inheritableToChildren: false }],
  ])('rejects an unsafe %s observation', (_name, patch) => {
    expect(() => attestWindowsPrivateRootSecurity(
      exactRoot,
      {
        ...exactObservation,
        ...patch,
      } as WindowsPrivateRootSecurityObservationV1,
    )).toThrow(/observation is invalid/u);
  });
});
