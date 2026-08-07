import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../../');
const workflowPaths = [
  '.github/workflows/ci.yml',
  '.github/workflows/_native-build.yml',
  '.github/workflows/publish-binary.yml',
] as const;

async function workflow(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), 'utf-8');
}

function checkoutStepBlocks(source: string): string[] {
  return source
    .split(/\n(?=\s{6}- )/u)
    .filter((block) => block.includes('uses: actions/checkout@'));
}

describe('native release workflow contract', () => {
  it('disables persisted checkout credentials in every workflow checkout', async () => {
    for (const path of workflowPaths) {
      const blocks = checkoutStepBlocks(await workflow(path));
      expect(blocks.length, path).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block, path).toContain('persist-credentials: false');
      }
    }
  });

  it('builds the exact six native targets on matching runner architectures', async () => {
    const source = await workflow('.github/workflows/_native-build.yml');
    const targets = [...source.matchAll(/^\s+target: (\S+)$/gmu)].map((match) => match[1]);
    expect(targets).toEqual([
      'linux-x64',
      'linux-arm64',
      'darwin-x64',
      'darwin-arm64',
      'win32-x64',
      'win32-arm64',
    ]);
    expect(source).toContain('windows-11-arm');
    expect(source).toContain("Smoke test final ZIP without catalog network access");
    expect(source).toContain('Cross-platform Resume, cancellation, quoting, and process lifecycle tests');
    expect(source).toContain('apps/wukong/test/cli/run-prompt.test.ts');
    expect(source).toContain('packages/agent-core/test/tools/shell-cancel.test.ts');
    expect(source).toContain('packages/agent-core/test/tools/shell-quoting.test.ts');
    expect(source).toContain('packages/agent-core/test/tools/bash-windows-kill.test.ts');
    expect(source).toContain('packages/kaos/test/e2e/process-lifecycle.test.ts');
  });

  it('publishes only byte-verified staged assets and verifies the public release without rebuilding', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const draftIndex = source.indexOf('Create or verify private draft release');
    const publishIndex = source.indexOf('Publish verified release without changing latest');
    const publicVerifyIndex = source.indexOf('Re-download and verify public release assets');
    expect(draftIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(draftIndex);
    expect(publicVerifyIndex).toBeGreaterThan(publishIndex);

    const afterDraft = source.slice(draftIndex);
    expect(afterDraft).not.toContain('build:native');
    expect(afterDraft).not.toContain('package:native');
    expect(afterDraft).toContain('cmp "$FILE" "remote-draft/$(basename "$FILE")"');
    expect(afterDraft).toContain('gh release download "$RELEASE_TAG"');
    expect(afterDraft).toContain('gh attestation verify "$FILE"');
    expect(afterDraft).toContain('--source-digest "$SOURCE_SHA"');
  });

  it('keeps the previous latest release until all six public native archives pass functional smoke', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const publishIndex = source.indexOf('Publish verified release without changing latest');
    const publicSmokeIndex = source.indexOf('public-native-smoke:');
    const promoteIndex = source.indexOf('promote-latest:');
    expect(publishIndex).toBeGreaterThan(0);
    expect(publicSmokeIndex).toBeGreaterThan(publishIndex);
    expect(promoteIndex).toBeGreaterThan(publicSmokeIndex);
    expect(source.slice(publishIndex, publicSmokeIndex)).toContain('--draft=false --latest=false');
    expect(source.slice(publishIndex, publicSmokeIndex)).not.toContain('--latest\n');

    const publicSmoke = source.slice(publicSmokeIndex, promoteIndex);
    for (const target of [
      'linux-x64',
      'linux-arm64',
      'darwin-x64',
      'darwin-arm64',
      'win32-x64',
      'win32-arm64',
    ]) {
      expect(publicSmoke).toContain(`target: ${target}`);
    }
    expect(publicSmoke).toContain('verify-archive.mjs');
    expect(publicSmoke).toContain('WUKONG_CODE_NATIVE_SMOKE_ARCHIVE');
    expect(publicSmoke).toContain('scripts/native/smoke.mjs');
    expect(publicSmoke).toContain('WUKONG_VERSION=v0.0.22');
    expect(publicSmoke).toContain('WUKONG_VERSION="$RELEASE_TAG"');

    const promote = source.slice(promoteIndex);
    expect(promote).toContain('- public-native-smoke');
    expect(promote).toContain('gh release edit "$RELEASE_TAG"');
    expect(promote).toContain('--latest');
  });

  it('runs a checksum-verified Windows v0.0.22 in-place upgrade after the old process exits', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const stepIndex = source.indexOf('Direct Windows upgrade from v0.0.22 after process exit');
    expect(stepIndex).toBeGreaterThan(0);
    const step = source.slice(stepIndex, source.indexOf('\n  promote-latest:', stepIndex));

    expect(step).toContain("if: runner.os == 'Windows'");
    expect(step).toContain('shell: pwsh');
    expect(step).toContain('gh release download v0.0.22');
    expect(step).toContain('verify-archive.mjs');
    expect(step).toContain('Expand-Archive');
    expect(step).toContain("Select-String -SimpleMatch '0.0.22'");
    expect(step).toContain('Move-Item -LiteralPath $installedExe -Destination $backupExe');
    expect(step).toContain('Move-Item -LiteralPath $backupExe -Destination $installedExe');
    expect(step).toContain('WUKONG_CODE_HOME');
    expect(step).toContain("Select-String -SimpleMatch $env:VERSION");
  });
});
