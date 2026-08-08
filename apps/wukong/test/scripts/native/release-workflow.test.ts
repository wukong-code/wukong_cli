import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../../../');
const workflowPaths = [
  '.github/workflows/ci.yml',
  '.github/workflows/_native-build.yml',
  '.github/workflows/publish-binary.yml',
  '.github/workflows/promote-stable.yml',
  '.github/workflows/verify-stable-surfaces.yml',
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

  it('applies the Windows suite timeout directly to Vitest without forwarding an extra separator', async () => {
    const source = await workflow('.github/workflows/ci.yml');
    const windowsIndex = source.indexOf('test-windows:');
    const nextJobIndex = source.indexOf('\n  verification-criteria-cross-platform:', windowsIndex);
    const windowsJob = source.slice(windowsIndex, nextJobIndex);

    expect(windowsIndex).toBeGreaterThan(0);
    expect(nextJobIndex).toBeGreaterThan(windowsIndex);
    expect(windowsJob).toContain('pnpm exec vitest run --testTimeout=30000');
    expect(windowsJob).not.toContain('pnpm run test -- --testTimeout=30000');
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

  it('builds every release target from one shared catalog snapshot', async () => {
    const source = await workflow('.github/workflows/_native-build.yml');
    const prepareIndex = source.indexOf('prepare-release-catalog:');
    const matrixIndex = source.indexOf('native-bundle:');

    expect(prepareIndex).toBeGreaterThan(0);
    expect(matrixIndex).toBeGreaterThan(prepareIndex);
    expect(source.match(/update-catalog\.mjs/gmu)).toHaveLength(1);
    expect(source.slice(prepareIndex, matrixIndex)).toContain('--metadata-out');
    expect(source.slice(matrixIndex)).toContain('name: wukong-release-catalog');
    expect(source.slice(matrixIndex)).toContain(
      'WUKONG_CODE_BUILT_IN_CATALOG_METADATA_FILE',
    );
  });

  it('resolves a mutable source ref once and aggregates all six identities before success', async () => {
    const source = await workflow('.github/workflows/_native-build.yml');
    const validateIndex = source.indexOf('validate-release-contract:');
    const prepareIndex = source.indexOf('prepare-release-catalog:');
    const matrixIndex = source.indexOf('native-bundle:');
    const aggregateIndex = source.indexOf('verify-release-identity:');

    expect(validateIndex).toBeGreaterThan(0);
    expect(prepareIndex).toBeGreaterThan(validateIndex);
    expect(matrixIndex).toBeGreaterThan(prepareIndex);
    expect(aggregateIndex).toBeGreaterThan(matrixIndex);
    expect(source.slice(validateIndex, prepareIndex)).toContain(
      "ref: ${{ inputs.source-ref != '' && inputs.source-ref || github.sha }}",
    );
    expect(source.match(/inputs\.source-ref !=/gmu)).toHaveLength(1);
    expect(source.match(/ref: \$\{\{ needs\.validate-release-contract\.outputs\.source_sha \}\}/gmu))
      .toHaveLength(3);
    expect(source.slice(aggregateIndex)).toContain('pattern: ${{ inputs.upload-artifact-prefix }}-*');
    expect(source.slice(aggregateIndex)).toContain('merge-multiple: true');
    expect(source.slice(aggregateIndex)).toContain('verify-release-staging.mjs');
    expect(source.slice(aggregateIndex)).toContain('"$EXPECT_MACOS_SIGNING"');
  });

  it('publishes only byte-verified staged assets and verifies the public release without rebuilding', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const nativeBuildIndex = source.indexOf('native-artifacts:');
    const draftIndex = source.indexOf('Create or verify private draft release');
    const publishIndex = source.indexOf(
      'Publish immutable prerelease or keep stable assets in draft',
    );
    const publicVerifyIndex = source.indexOf(
      'Re-download and verify published or draft release assets',
    );
    expect(draftIndex).toBeGreaterThan(0);
    expect(nativeBuildIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(draftIndex);
    expect(publicVerifyIndex).toBeGreaterThan(publishIndex);

    const afterDraft = source.slice(draftIndex);
    expect(afterDraft).not.toContain('build:native');
    expect(afterDraft).not.toContain('package:native');
    expect(afterDraft).toContain('cmp "$FILE" "remote-draft/$(basename "$FILE")"');
    expect(afterDraft).toContain('gh release download "$RELEASE_TAG"');
    expect(afterDraft).not.toContain('gh attestation verify');
    expect(source).not.toContain('actions/attest-build-provenance');

    const nativeBuild = source.slice(nativeBuildIndex, source.indexOf('finalize-release:'));
    expect(nativeBuild).toContain('sign-macos: false');
    expect(nativeBuild).not.toContain('APPLE_');
    expect(source.slice(nativeBuildIndex, draftIndex)).toContain(
      'staging "$RELEASE_TAG" "$SOURCE_SHA" release-assets false',
    );
  });

  it('keeps immutable prereleases and stable drafts off latest after six-platform smoke', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const publishIndex = source.indexOf(
      'Publish immutable prerelease or keep stable assets in draft',
    );
    const publicSmokeIndex = source.indexOf('public-native-smoke:');
    const finalizeChannelIndex = source.indexOf('finalize-release-channel:');
    expect(publishIndex).toBeGreaterThan(0);
    expect(publicSmokeIndex).toBeGreaterThan(publishIndex);
    expect(finalizeChannelIndex).toBeGreaterThan(publicSmokeIndex);
    expect(source.slice(publishIndex, publicSmokeIndex)).toContain(
      '--draft=false --latest=false',
    );
    expect(source.slice(publishIndex, publicSmokeIndex)).not.toContain('--latest\n');

    const publicSmoke = source.slice(publicSmokeIndex, finalizeChannelIndex);
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
    expect(publicSmoke).toContain('Download and checksum anonymous prerelease archive');
    expect(publicSmoke).toContain('Download and checksum authenticated stable draft archive');
    expect(publicSmoke).toContain(
      'Replace v0.0.22 with the authenticated stable draft archive',
    );
    expect(publicSmoke).toContain(
      "needs.validate-source.outputs.is_prerelease == 'true' && runner.os != 'Windows'",
    );

    const finalizeChannel = source.slice(finalizeChannelIndex);
    expect(finalizeChannel).toContain('- public-native-smoke');
    expect(finalizeChannel).toContain('if [[ "$IS_PRERELEASE" = "true" ]]');
    expect(finalizeChannel).toContain('isPrerelease --jq .isPrerelease)" = "true"');
    expect(finalizeChannel).toContain('isPrerelease --jq .isPrerelease)" = "false"');
    expect(finalizeChannel).toContain(
      'tagName --jq .tagName)" = "$PREVIOUS_LATEST_TAG"',
    );
    expect(finalizeChannel).toContain('tagName --jq .tagName)" != "$RELEASE_TAG"');
    expect(finalizeChannel).not.toContain('gh release edit "$RELEASE_TAG"');
    expect(finalizeChannel).not.toMatch(/--latest(?:\s|$)/mu);
  });

  it('publishes prerelease tags on the prerelease channel without replacing stable latest', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const validateIndex = source.indexOf('Validate tag, package, and release notes');
    const draftIndex = source.indexOf('Create or verify private draft release');
    const publicSmokeIndex = source.indexOf('public-native-smoke:');

    expect(source.slice(validateIndex, draftIndex)).toContain('is_prerelease=$IS_PRERELEASE');
    expect(source.slice(validateIndex, draftIndex)).toContain('previous_latest_tag=$PREVIOUS_LATEST_TAG');
    const draftStep = source.slice(draftIndex, publicSmokeIndex);
    expect(draftStep).toContain('PRERELEASE_ARGS=(--prerelease)');
    expect(draftStep).toContain('"${PRERELEASE_ARGS[@]}"');
    expect(draftStep).toContain('--json isPrerelease');
  });

  it('requires stable publication to use exact staged public SHAs from the exact tag ref', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const validateIndex = source.indexOf('Validate tag, package, and release notes');
    const nativeBuildIndex = source.indexOf('native-artifacts:');
    const contract = source.slice(validateIndex, nativeBuildIndex);

    expect(source.slice(0, validateIndex)).toContain("- 'v*-*'");
    expect(source.slice(0, validateIndex)).toContain('distribution_sha:');
    expect(source.slice(0, validateIndex)).toContain('website_sha:');
    expect(contract).toContain('test "$GITHUB_SHA" = "$SOURCE_SHA"');
    expect(contract).toContain('test "$GITHUB_REF_NAME" = "$RELEASE_TAG"');
    expect(contract).toContain('Stable publication requires exact staged');
    expect(contract).toContain('DISTRIBUTION_SHA_INPUT');
    expect(contract).toContain('WEBSITE_SHA_INPUT');
    expect(source).toContain(
      'ref: ${{ needs.validate-source.outputs.distribution_sha }}',
    );
    expect(source).not.toContain('repository: mutnpc/wukong-code\n          ref: main');
    expect(source).not.toContain('repository: mutnpc/wukong_web');
  });

  it('rejects stable commits already on production main before creating a draft', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const gateIndex = source.indexOf(
      'Require staged public commits and old production before stable draft mutation',
    );
    const createDraftIndex = source.indexOf('Create or verify private draft release');
    const gate = source.slice(gateIndex, createDraftIndex);

    expect(gateIndex).toBeGreaterThan(0);
    expect(createDraftIndex).toBeGreaterThan(gateIndex);
    expect(gate).toContain("if: needs.validate-source.outputs.is_prerelease == 'false'");
    expect(gate).toContain('GH_TOKEN: ${{ github.token }}');
    expect(gate).not.toContain('WUKONG_PUBLIC_RELEASE_TOKEN');
    expect(gate).toContain('assert-stable-promotion.mjs');
    expect(gate).toContain('"$RELEASE_TAG" "$CURRENT_LATEST_TAG"');
    expect(gate).toContain(
      'compare/${DISTRIBUTION_MAIN_BEFORE}...${DISTRIBUTION_SHA}',
    );
    expect(gate.match(/--jq \.status\)" = "ahead"/gmu)).toHaveLength(1);
    expect(gate).toContain('https://wukong.today/latest?draft-gate=');
    expect(gate).toContain('https://wukong.today/_release.json?draft-gate=');
    expect(gate).toContain('https://docs.wukong.today/_release.json?draft-gate=');
    expect(gate).toContain('--arg commitSha "$WEBSITE_MAIN_BEFORE"');
    expect(gate).toContain('--arg commitSha "$DISTRIBUTION_MAIN_BEFORE"');
    expect(gate).toContain('test "$DISTRIBUTION_MAIN_AFTER" = "$DISTRIBUTION_MAIN_BEFORE"');
    expect(gate).toContain('test "$WEBSITE_MAIN_AFTER" = "$WEBSITE_MAIN_BEFORE"');
  });

  it('serializes public releases and preserves the exact previous latest tag for every channel', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const finalizeChannelIndex = source.indexOf('finalize-release-channel:');

    expect(source).toContain('group: publish-binary-release');
    expect(source).toContain('PREVIOUS_LATEST_TAG="$(gh release view');
    expect(source.slice(finalizeChannelIndex)).toContain(
      'tagName --jq .tagName)" = "$PREVIOUS_LATEST_TAG"',
    );
  });

  it('uses the public token only for distribution identity and the exact Website input', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const validateIndex = source.indexOf('Validate tag, package, and release notes');
    const nativeIndex = source.indexOf('native-artifacts:');
    const validate = source.slice(validateIndex, nativeIndex);

    expect(validateIndex).toBeGreaterThan(0);
    expect(nativeIndex).toBeGreaterThan(validateIndex);
    expect(validate).toContain(
      'GH_TOKEN: ${{ secrets.WUKONG_PUBLIC_RELEASE_TOKEN }}',
    );
    expect(validate).not.toContain('GH_TOKEN: ${{ github.token }}');
    expect(validate).toContain('gh release view --repo "$RELEASE_REPO"');
    expect(validate).toContain('WEBSITE_SHA="$WEBSITE_SHA_INPUT"');
    expect(validate).not.toContain('repos/${WEBSITE_REPO}/commits/');
  });

  it('validates a draft release target without requiring a not-yet-created Git tag', async () => {
    for (const path of [
      '.github/workflows/publish-binary.yml',
      '.github/workflows/promote-stable.yml',
    ]) {
      const source = await workflow(path);
      expect(source).toContain('--json targetCommitish --jq .targetCommitish');
      const promoteIndex = source.indexOf(
        'Publish verified stable draft as immutable latest',
      );
      expect(source.slice(0, promoteIndex < 0 ? source.length : promoteIndex)).not.toContain(
        'repos/${RELEASE_REPO}/commits/${RELEASE_TAG}',
      );
    }
  });

  it('publishes only prereleases as immutable and leaves stable assets in a mutable draft', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const uploadIndex = source.indexOf('gh release upload "$RELEASE_TAG"');
    const publishIndex = source.indexOf(
      'Publish immutable prerelease or keep stable assets in draft',
    );
    const immutableIndex = source.indexOf('--json isImmutable --jq .isImmutable');

    expect(uploadIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(uploadIndex);
    expect(immutableIndex).toBeGreaterThan(publishIndex);
    const publish = source.slice(publishIndex, source.indexOf('public-native-smoke:'));
    expect(publish).toContain('if [[ "$IS_PRERELEASE" = "true" ]]');
    expect(publish).toContain('--draft=false --latest=false');
    expect(publish).toContain('isImmutable --jq .isImmutable)" = "true"');
    expect(publish).toContain('isDraft --jq .isDraft)" = "true"');
    expect(publish).toContain('isImmutable --jq .isImmutable)" = "false"');
    expect(publish).toContain('Immutable releases can only change their title and notes');
    expect(publish).toContain('repos/${RELEASE_REPO}/immutable-releases');
  });

  it('scopes the public release token away from checked-out validator scripts', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const finalizeIndex = source.indexOf('finalize-release:');
    const stepsIndex = source.indexOf('\n    steps:', finalizeIndex);
    const finalizeJobHeader = source.slice(finalizeIndex, stepsIndex);
    const validatorIndex = source.indexOf('Block publishing when public truth is not aligned');
    const createDraftIndex = source.indexOf('Create or verify private draft release');

    expect(finalizeIndex).toBeGreaterThan(0);
    expect(stepsIndex).toBeGreaterThan(finalizeIndex);
    expect(finalizeJobHeader).not.toContain('GH_TOKEN:');
    expect(source.slice(validatorIndex, createDraftIndex)).not.toContain(
      'WUKONG_PUBLIC_RELEASE_TOKEN',
    );
    expect(source.slice(createDraftIndex)).toContain(
      'GH_TOKEN: ${{ secrets.WUKONG_PUBLIC_RELEASE_TOKEN }}',
    );
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('publishes stable assets first and defers production-surface completion', async () => {
    const source = await workflow('.github/workflows/promote-stable.yml');
    const validateRunIndex = source.indexOf(
      'Validate stable inputs, private tag, and successful publish run',
    );
    const validateSourceIndex = source.indexOf(
      'Validate source, distribution, and installer identity',
    );
    const validateReleaseIndex = source.indexOf(
      'Validate stable candidate, assets, tag, and provenance',
    );
    const verifyCandidateIndex = source.indexOf(
      'Verify candidate bytes and provenance before immutable publication',
    );
    const promoteIndex = source.indexOf('Publish verified stable draft as immutable latest');
    const anonymousVerifyIndex = source.indexOf(
      'Anonymously re-download and verify promoted assets and installer',
    );
    const followUpIndex = source.indexOf('Record the required production-surface follow-up');

    expect(validateRunIndex).toBeGreaterThan(0);
    expect(validateSourceIndex).toBeGreaterThan(validateRunIndex);
    expect(validateReleaseIndex).toBeGreaterThan(validateSourceIndex);
    expect(verifyCandidateIndex).toBeGreaterThan(validateReleaseIndex);
    expect(promoteIndex).toBeGreaterThan(verifyCandidateIndex);
    expect(anonymousVerifyIndex).toBeGreaterThan(promoteIndex);
    expect(followUpIndex).toBeGreaterThan(anonymousVerifyIndex);

    for (const input of [
      'release_tag:',
      'source_sha:',
      'publish_run_id:',
      'distribution_sha:',
      'website_sha:',
    ]) {
      expect(source.slice(0, validateRunIndex)).toContain(input);
    }
    expect(source).toContain('permissions:\n  actions: read\n  contents: read');
    expect(source).toContain('group: publish-binary-release');
    expect(source).toContain('.github/workflows/publish-binary.yml@*');
    expect(source).toContain('test "$GITHUB_SHA" = "$SOURCE_SHA"');
    expect(source).toContain('test "$GITHUB_REF_NAME" = "$RELEASE_TAG"');
    expect(source).toContain('.head_sha <<<"$RUN_JSON")" = "$SOURCE_SHA"');
    expect(source).toContain('.head_branch <<<"$RUN_JSON")" = "$RELEASE_TAG"');
    expect(source).toContain('git -C source rev-list -n 1 "$RELEASE_TAG"');

    for (const target of [
      'linux-x64',
      'linux-arm64',
      'darwin-x64',
      'darwin-arm64',
      'win32-x64',
      'win32-arm64',
    ]) {
      expect(source.slice(validateRunIndex, validateSourceIndex)).toContain(target);
    }

    expect(source.slice(validateSourceIndex, validateReleaseIndex)).toContain(
      'node scripts/validate-release-truth.mjs "$VERSION"',
    );
    expect(source.slice(validateSourceIndex, validateReleaseIndex)).toContain(
      'cmp source/install.sh distribution/install.sh',
    );

    const publicRelease = source.slice(validateReleaseIndex, verifyCandidateIndex);
    expect(publicRelease).toContain('--json tagName,isDraft,isPrerelease,isImmutable,assets');
    expect(publicRelease).toContain("test \"$(jq '.assets | length'");
    expect(publicRelease).toContain('--json targetCommitish --jq .targetCommitish');
    expect(publicRelease).toContain('release-provenance.json');
    expect(publicRelease).toContain('.publicTruth.distributionSha == $distributionSha');
    expect(publicRelease).toContain('.publicTruth.websiteSha == $websiteSha');
    expect(publicRelease).toContain(
      'all(.artifacts[]; .build.macosSignedAndNotarized == false)',
    );
    expect(publicRelease).toContain(
      '"$IS_DRAFT" = "true" && "$IS_IMMUTABLE" = "false"',
    );
    expect(publicRelease).toContain(
      '"$IS_DRAFT" = "false" && "$IS_IMMUTABLE" = "true"',
    );
    expect(publicRelease).toContain('test "$CURRENT_LATEST_TAG" = "$RELEASE_TAG"');
    expect(publicRelease).toContain('assert-stable-promotion.mjs');

    const candidateVerification = source.slice(verifyCandidateIndex, promoteIndex);
    expect(candidateVerification).not.toContain('WUKONG_PUBLIC_RELEASE_TOKEN');
    expect(candidateVerification).toContain('verify-archive.mjs');
    expect(candidateVerification).toContain('sha256sum "draft-release/${ARCHIVE}"');
    expect(candidateVerification).toContain('.sha256 == $sha256');
    expect(candidateVerification).not.toContain('gh attestation verify');

    const promote = source.slice(promoteIndex, anonymousVerifyIndex);
    expect(source).toContain('immutable_policy_verified:');
    expect(source).toContain('IMMUTABLE_POLICY_VERIFIED: ${{ inputs.immutable_policy_verified }}');
    expect(source).toContain('if [[ "$IMMUTABLE_POLICY_VERIFIED" != "true" ]]');
    expect(promote).not.toContain('repos/${RELEASE_REPO}/immutable-releases');
    expect(promote).toContain('CURRENT_LATEST_TAG="$(gh release view');
    expect(promote).toContain('https://wukong.today/latest?');
    expect(promote).toContain('releases/tag/${CURRENT_LATEST_TAG}');
    expect(promote).toContain('gh release download "$RELEASE_TAG"');
    expect(promote).toContain('cmp "$DRAFT_FILE" "final-draft-release/');
    expect(promote).toContain('--json isImmutable --jq .isImmutable)" = "true"');
    expect(promote).toContain('gh release edit "$RELEASE_TAG"');
    expect(promote).toContain('--draft=false --latest');
    expect(promote).toContain(
      'An immutable published release cannot later change its latest',
    );
    expect(promote).toContain(
      '"$IS_DRAFT" = "false" && "$IS_PRERELEASE" = "false"',
    );
    expect(promote).toContain('"$CURRENT_LATEST_TAG" = "$RELEASE_TAG"');
    expect(promote).toContain('already immutable latest; rerunning anonymous release smoke');
    expect(promote).toContain('assert-stable-promotion.mjs');

    const anonymousVerify = source.slice(anonymousVerifyIndex);
    expect(anonymousVerify).not.toContain('GH_TOKEN:');
    expect(anonymousVerify).toContain('for DRAFT_FILE in draft-release/*');
    expect(anonymousVerify).toContain('cmp "$DRAFT_FILE" "public-release/${ASSET}"');
    expect(anonymousVerify).toContain('= "13"');
    expect(anonymousVerify).toContain('WUKONG_VERSION="$RELEASE_TAG"');
    expect(anonymousVerify).toContain('sh public-release/install.sh');
    expect(source).not.toContain('Wait for exact stable Website and Docs production truth');
    expect(source).not.toContain('https://wukong.today/download?verification=');
    expect(source.slice(followUpIndex)).toContain(
      'separate Verify stable production surfaces workflow',
    );
    expect(source).not.toMatch(/git push|git update-ref|gh api .*git\/refs/imu);
  });

  it('completes stable release only after exact deployed Website and Docs truth passes', async () => {
    const source = await workflow('.github/workflows/verify-stable-surfaces.yml');
    const validateIdentityIndex = source.indexOf(
      'Validate stable identity and successful asset promotion',
    );
    const validateSourceIndex = source.indexOf(
      'Validate source, distribution, and installer identity',
    );
    const validateReleaseIndex = source.indexOf(
      'Revalidate immutable latest release and provenance',
    );
    const productionIndex = source.indexOf(
      'Wait for exact stable Website and Docs production truth',
    );
    const completeIndex = source.indexOf('Record completed two-stage stable release');

    expect(validateIdentityIndex).toBeGreaterThan(0);
    expect(validateSourceIndex).toBeGreaterThan(validateIdentityIndex);
    expect(validateReleaseIndex).toBeGreaterThan(validateSourceIndex);
    expect(productionIndex).toBeGreaterThan(validateReleaseIndex);
    expect(completeIndex).toBeGreaterThan(productionIndex);

    for (const input of [
      'release_tag:',
      'source_sha:',
      'promotion_run_id:',
      'distribution_sha:',
      'website_sha:',
    ]) {
      expect(source.slice(0, validateIdentityIndex)).toContain(input);
    }
    expect(source).toContain('permissions:\n  actions: read\n  contents: read');
    expect(source).toContain('test "$GITHUB_SHA" = "$SOURCE_SHA"');
    expect(source).toContain('test "$GITHUB_REF_NAME" = "$RELEASE_TAG"');
    expect(source).toContain('.github/workflows/promote-stable.yml@*');
    expect(source).toContain('.head_sha <<<"$RUN_JSON")" = "$SOURCE_SHA"');
    expect(source).toContain('.head_branch <<<"$RUN_JSON")" = "$RELEASE_TAG"');
    expect(source).toContain(
      'Publish immutable stable assets and verify installation\\tsuccess',
    );

    const sourceTruth = source.slice(validateSourceIndex, validateReleaseIndex);
    expect(sourceTruth).toContain('node scripts/validate-release-truth.mjs "$VERSION"');
    expect(sourceTruth).toContain('cmp source/install.sh distribution/install.sh');

    const releaseTruth = source.slice(validateReleaseIndex, productionIndex);
    expect(releaseTruth).toContain('isDraft <<<"$RELEASE_JSON")" = "false"');
    expect(releaseTruth).toContain('isImmutable <<<"$RELEASE_JSON")" = "true"');
    expect(releaseTruth).toContain("test \"$(jq '.assets | length'");
    expect(releaseTruth).toContain('= "13"');
    expect(releaseTruth).toContain('repos/${RELEASE_REPO}/commits/${RELEASE_TAG}');
    expect(releaseTruth).toContain('.publicTruth.distributionSha == $distributionSha');
    expect(releaseTruth).toContain('.publicTruth.websiteSha == $websiteSha');
    expect(releaseTruth).toContain(
      'all(.artifacts[]; .build.macosSignedAndNotarized == false)',
    );

    const production = source.slice(productionIndex, completeIndex);
    for (const url of [
      'https://wukong.today/latest?',
      'https://wukong.today/latest.json?',
      'https://wukong.today/_release.json?',
      'https://wukong.today/?',
      'https://wukong.today/download?',
      'https://wukong.today/today?',
      'https://wukong.today/changelog?',
      'https://wukong.today/cli/announcements.json?',
      'https://wukong.today/install.sh?',
      'https://docs.wukong.today/?',
      'https://docs.wukong.today/_release.json?',
      'https://docs.wukong.today/getting-started/?',
    ]) {
      expect(production).toContain(url);
    }
    expect(production).toContain('VERSION: v${VERSION}');
    expect(production).toContain('${VERSION} · CURRENT_RELEASE');
    expect(production).toContain('/releases/download/${RELEASE_TAG}/');
    expect(production).toContain('v<!-- -->${VERSION}');
    expect(production).toContain('--arg repository "$WEBSITE_REPO"');
    expect(production).toContain('--arg commitSha "$WEBSITE_SHA"');
    expect(production).toContain('--arg repository "$RELEASE_REPO"');
    expect(production).toContain('--arg commitSha "$DISTRIBUTION_SHA"');
    expect(production).toContain('and .commitSha == $commitSha');
    expect(production).toContain('cmp distribution/install.sh production/install.sh');
    expect(source.slice(completeIndex)).toContain('Stable release complete');
    expect(source).not.toContain('gh release edit');
    expect(source).not.toMatch(/git push|git update-ref|gh api .*git\/refs/imu);
  });

  it('runs a checksum-verified Windows v0.0.22 in-place upgrade after the old process exits', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const stepIndex = source.indexOf('Direct Windows upgrade from v0.0.22 after process exit');
    expect(stepIndex).toBeGreaterThan(0);
    const step = source.slice(stepIndex, source.indexOf('\n  finalize-release-channel:', stepIndex));

    expect(step).toContain("if: runner.os == 'Windows'");
    expect(step).toContain('shell: pwsh');
    expect(step).toContain('releases/download/v0.0.22');
    expect(step).toContain('Invoke-WebRequest');
    expect(step).toContain('verify-archive.mjs');
    expect(step).toContain('Expand-Archive');
    expect(step).toContain("Select-String -Quiet -SimpleMatch '0.0.22'");
    expect(step).toContain("throw 'Installed baseline did not report 0.0.22'");
    expect(step).toContain('Move-Item -LiteralPath $installedExe -Destination $backupExe');
    expect(step).toContain('Move-Item -LiteralPath $backupExe -Destination $installedExe');
    expect(step).toContain('WUKONG_CODE_HOME');
    expect(step).toContain('Select-String -Quiet -SimpleMatch $env:VERSION');
    expect(step).toContain('throw "Stable candidate did not report $env:VERSION"');
    expect(step).toContain('throw "Replaced Windows binary did not report $env:VERSION"');
  });

  it('binds the public release tag to verified distribution truth and records both public SHAs', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const truthIndex = source.indexOf('Block publishing when public truth is not aligned');
    const createIndex = source.indexOf('Create or verify private draft release');

    expect(source.slice(truthIndex, createIndex)).toContain(
      'distribution_sha=$(git -C distribution rev-parse HEAD)',
    );
    expect(source.slice(truthIndex, createIndex)).toContain(
      'website_sha=$EXPECTED_WEBSITE_SHA',
    );
    expect(source.slice(createIndex)).toContain('--target "$DISTRIBUTION_SHA"');
    expect(source.slice(createIndex)).toContain(
      '--json targetCommitish --jq .targetCommitish',
    );
  });

  it('runs explicit candidate fresh-install and old-state upgrade smoke', async () => {
    const source = await workflow('.github/workflows/publish-binary.yml');
    const publicSmokeIndex = source.indexOf('public-native-smoke:');
    const finalizeChannelIndex = source.indexOf('finalize-release-channel:');
    const publicSmoke = source.slice(publicSmokeIndex, finalizeChannelIndex);

    expect(publicSmoke).toContain('Fresh install candidate through the canonical installer');
    expect(publicSmoke).toContain('curl -fsSL https://wukong.today/install.sh');
    expect(publicSmoke).toContain('WUKONG_VERSION="$RELEASE_TAG"');
    expect(publicSmoke).toContain('Fresh install Windows candidate from the public archive');
    expect(publicSmoke).toContain('STATE_DIR="$RUNNER_TEMP/wukong-upgrade/state"');
    expect(publicSmoke).toContain('provider list --json >/dev/null');
    expect(publicSmoke).toContain('config-before-upgrade.toml');
  });
});
