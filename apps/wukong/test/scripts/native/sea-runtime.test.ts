import { describe, expect, it } from 'vitest';

import { injectionModeForTarget } from '../../../scripts/native/03-inject.mjs';
import { officialNodeVersion } from '../../../scripts/native/sea-node.mjs';

describe('native SEA runtime selection', () => {
  it('uses the Node 24 postject fallback for Intel macOS', () => {
    expect(officialNodeVersion('darwin-x64')).toBe('v24.18.0');
    expect(injectionModeForTarget('darwin-x64')).toBe('legacy-postject');
  });

  it('keeps the Node 26 direct SEA builder for the other release targets', () => {
    for (const target of [
      'darwin-arm64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]) {
      expect(officialNodeVersion(target)).toBe('v26.4.0');
      expect(injectionModeForTarget(target)).toBe('node-build-sea');
    }
  });
});
