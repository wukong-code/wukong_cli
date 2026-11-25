import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { collectNativeAssets } from '../../../scripts/native/assets.mjs';
import {
  nativeDeps,
  resolveTargetDeps,
  isSupportedTarget,
  SUPPORTED_TARGETS,
} from '../../../scripts/native/native-deps.mjs';
import { appRoot, targetTriple } from '../../../scripts/native/paths.mjs';

describe('SUPPORTED_TARGETS', () => {
  it('contains the six published targets', () => {
    expect([...SUPPORTED_TARGETS].toSorted()).toEqual(
      [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'win32-arm64',
        'win32-x64',
      ].toSorted(),
    );
  });
});

describe('isSupportedTarget', () => {
  it('accepts every supported target', () => {
    for (const t of SUPPORTED_TARGETS) {
      expect(isSupportedTarget(t)).toBe(true);
    }
  });

  it('rejects unknown targets', () => {
    expect(isSupportedTarget('linux-x64-musl')).toBe(false);
    expect(isSupportedTarget('darwin-arm')).toBe(false);
  });
});

describe('resolveTargetDeps', () => {
  it('returns one descriptor per package for darwin-arm64', () => {
    const deps = resolveTargetDeps('darwin-arm64');
    const names = deps.map((d) => d.resolvedName);
    expect(names).toContain('@mariozechner/clipboard');
    expect(names).toContain('@mariozechner/clipboard-darwin-universal');
    expect(names).toContain('koffi');
    expect(names).toContain('@koromix/koffi-darwin-arm64');
  });

  it('picks the right clipboard subpackage per target', () => {
    expect(
      resolveTargetDeps('linux-x64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-linux-x64-gnu');
    expect(
      resolveTargetDeps('win32-x64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-win32-x64-msvc');
    expect(
      resolveTargetDeps('win32-arm64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-win32-arm64-msvc');
  });

  it('picks the right koffi subpackage per target', () => {
    expect(
      resolveTargetDeps('linux-arm64').map((d) => d.resolvedName),
    ).toContain('@koromix/koffi-linux-arm64');
    expect(
      resolveTargetDeps('darwin-x64').map((d) => d.resolvedName),
    ).toContain('@koromix/koffi-darwin-x64');
    expect(
      resolveTargetDeps('win32-arm64').map((d) => d.resolvedName),
    ).toContain('@koromix/koffi-win32-arm64');
    expect(
      resolveTargetDeps('linux-x64').map((d) => d.resolvedName),
    ).toContain('@koromix/koffi-linux-x64');
    expect(
      resolveTargetDeps('win32-x64').map((d) => d.resolvedName),
    ).toContain('@koromix/koffi-win32-x64');
  });

  it('throws on unsupported target', () => {
    expect(() => resolveTargetDeps('linux-x64-musl')).toThrow(/unsupported/i);
  });
});

describe('nativeDeps registry shape', () => {
  it('has clipboard host (collect=js-only)', () => {
    const host = nativeDeps.find((d) => d.id === 'clipboard-host');
    expect(host?.collect).toBe('js-only');
  });

  it('has clipboard-target (collect=native-files, parent=clipboard-host)', () => {
    const target = nativeDeps.find((d) => d.id === 'clipboard-target');
    expect(target?.collect).toBe('native-files');
    expect(target?.parent).toBe('clipboard-host');
  });

  it('has koffi host (collect=js-only, parent=null)', () => {
    const koffi = nativeDeps.find((d) => d.id === 'koffi');
    expect(koffi?.collect).toBe('js-only');
    expect(koffi?.parent).toBeNull();
  });

  it('has koffi-target (collect=native-files, parent=koffi)', () => {
    const target = nativeDeps.find((d) => d.id === 'koffi-target');
    expect(target?.collect).toBe('native-files');
    expect(target?.parent).toBe('koffi');
  });
});

describe('collectNativeAssets integration', () => {
  it('resolves all native dependency packages and .node binaries for the host target', async () => {
    const target = targetTriple();
    const { manifest, assets } = await collectNativeAssets({ appRoot, target });
    const names = manifest.packages.map((pkg) => pkg.name);
    expect(names).toContain('@mariozechner/clipboard');
    expect(names).toContain('koffi');
    expect(names).toContain('@wukong/reference-verification-skills');

    const nativeSubpackages = resolveTargetDeps(target).filter((dep) => dep.collect === 'native-files');
    for (const dep of nativeSubpackages) {
      const pkg = manifest.packages.find((entry) => entry.name === dep.resolvedName);
      expect(pkg, dep.resolvedName).toBeDefined();
      expect(pkg?.files.some((file) => file.relativePath.endsWith('.node'))).toBe(true);
    }

    for (const filePath of Object.values(assets)) {
      expect(existsSync(filePath), filePath).toBe(true);
    }
  });
});
