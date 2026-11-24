import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  detectProjectToolchain,
  type DetectedToolchain,
} from '@wukong/verification';
import { createWukongHarness, type WukongHarness } from '@wukong/wukong-sdk';
import type { Command } from 'commander';

import {
  formatProviderTestResults,
  testConfiguredProviders,
  type ProviderTestResult,
} from '#/cli/lib/provider-test';
import { createWukongCodeHostIdentity } from '#/cli/version';
import { initializeReviewPolicy } from '#/utils/review-feedback';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface InitDeps {
  readonly cwd: () => string;
  readonly getHarness: () => WukongHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

export interface InitCliOptions {
  readonly cwd?: string;
  readonly force?: boolean;
  readonly build?: boolean;
  readonly testProvider?: boolean | string;
  readonly offline?: boolean;
  readonly json?: boolean;
}

export interface InitFileOutcome {
  readonly path: '.wukong/checks.json' | '.wukong/review-policy.md';
  readonly action: 'created' | 'overwritten' | 'kept';
}

export interface InitResult {
  readonly toolchains: readonly DetectedToolchain[];
  readonly detectedCommands: readonly string[];
  readonly configuredCommands: readonly string[];
  readonly files: readonly [InitFileOutcome, InitFileOutcome];
  readonly providerStatus: 'unconfigured' | 'configured' | 'tested' | 'config-error';
  readonly configuredProviderIds: readonly string[];
  readonly providerTests?: readonly ProviderTestResult[];
  readonly missingProviderId?: string;
  readonly nextSteps: readonly string[];
}

export async function handleInit(deps: InitDeps, options: InitCliOptions): Promise<number> {
  try {
    const cwd = options.cwd ?? deps.cwd();
    const force = options.force === true;
    const detection = await detectProjectToolchain({
      cwd,
      includeBuild: options.build === true,
    });
    const detectedCommands = detection.commands.map((command) => command.command);

    const wukongDir = join(cwd, '.wukong');
    const checksPath = join(wukongDir, 'checks.json');
    const checksExisted = existsSync(checksPath);
    let checksAction: InitFileOutcome['action'];
    let configuredCommands: readonly string[];

    if (checksExisted && !force) {
      checksAction = 'kept';
      configuredCommands = await readConfiguredCommandStrings(checksPath);
    } else {
      await mkdir(wukongDir, { recursive: true });
      await writeFile(checksPath, `${JSON.stringify({ commands: detectedCommands }, null, 2)}\n`, 'utf8');
      checksAction = checksExisted ? 'overwritten' : 'created';
      configuredCommands = detectedCommands;
    }

    const reviewPolicyPath = join(wukongDir, 'review-policy.md');
    const reviewPolicyExisted = existsSync(reviewPolicyPath);
    let reviewPolicyAction: InitFileOutcome['action'];
    try {
      await initializeReviewPolicy({ cwd, force });
      reviewPolicyAction = reviewPolicyExisted ? 'overwritten' : 'created';
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        reviewPolicyAction = 'kept';
      } else {
        throw error;
      }
    }

    let providerStatus: InitResult['providerStatus'] = 'unconfigured';
    let configuredProviderIds: readonly string[] = [];
    let providerTests: readonly ProviderTestResult[] | undefined;
    let missingProviderId: string | undefined;
    let exitCode = 0;

    const shouldTestProvider = options.testProvider !== undefined && options.testProvider !== false;
    const requestedProviderId =
      typeof options.testProvider === 'string' && options.testProvider.trim().length > 0
        ? options.testProvider.trim()
        : undefined;

    try {
      const harness = deps.getHarness();
      const config = await harness.getConfig();
      configuredProviderIds = Object.keys(config.providers);
      if (configuredProviderIds.length === 0) {
        providerStatus = 'unconfigured';
        if (shouldTestProvider) {
          missingProviderId = requestedProviderId;
          exitCode = 1;
        }
      } else if (shouldTestProvider) {
        const testRun = await testConfiguredProviders(harness, {
          providerId: requestedProviderId,
          offline: options.offline,
          env: deps.env,
          fetch: deps.fetch,
        });
        providerStatus = 'tested';
        providerTests = testRun.results;
        missingProviderId = testRun.missingProviderId;
        if (
          testRun.missingProviderId !== undefined
          || testRun.results.length === 0
          || !testRun.results.every((result) => result.status === 'ok')
        ) {
          exitCode = 1;
        }
      } else {
        providerStatus = 'configured';
      }
    } catch {
      providerStatus = 'config-error';
      if (shouldTestProvider) {
        exitCode = 1;
      }
    }

    const result: InitResult = {
      toolchains: detection.toolchains,
      detectedCommands,
      configuredCommands,
      files: [
        { path: '.wukong/checks.json', action: checksAction },
        { path: '.wukong/review-policy.md', action: reviewPolicyAction },
      ],
      providerStatus,
      configuredProviderIds,
      providerTests,
      missingProviderId,
      nextSteps: [
        'wukong check',
        'wukong gate',
      ],
    };

    deps.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatInitResult(result));
    return exitCode;
  } catch (error) {
    deps.stderr.write(`wukong init failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerInitCommand(parent: Command, deps?: Partial<InitDeps>): void {
  parent
    .command('init')
    .description('Detect project toolchains, scaffold .wukong config files, and guide provider setup.')
    .option('--force', 'Overwrite existing .wukong/checks.json and .wukong/review-policy.md.', false)
    .option('--build', 'Include package build scripts when detecting project checks.', false)
    .option('--test-provider [providerId]', 'Run a connectivity check against configured providers.')
    .option('--offline', 'Skip network probes when --test-provider is used.', false)
    .option('--json', 'Emit initialization summary as JSON.', false)
    .action(async (raw: RawInitOptions) => {
      const resolved = resolveDeps(deps);
      const code = await handleInit(resolved, {
        force: raw.force === true,
        build: raw.build === true,
        testProvider: raw.testProvider,
        offline: raw.offline === true,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawInitOptions {
  readonly force?: boolean;
  readonly build?: boolean;
  readonly testProvider?: boolean | string;
  readonly offline?: boolean;
  readonly json?: boolean;
}

function resolveDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  let harness: WukongHarness | undefined;
  const identity = createWukongCodeHostIdentity();
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    getHarness:
      overrides.getHarness
      ?? (() => {
        harness ??= createWukongHarness({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    env: overrides.env ?? process.env,
    fetch: overrides.fetch,
  };
}

async function readConfiguredCommandStrings(path: string): Promise<readonly string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { readonly commands?: unknown };
    if (!Array.isArray(parsed.commands)) return [];
    return parsed.commands.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EEXIST'
  );
}

function formatInitResult(result: InitResult): string {
  const [checksFile, policyFile] = result.files;
  const lines = [
    'Wukong init',
    '',
    `Toolchains: ${result.toolchains.length === 0 ? 'none detected' : result.toolchains.join(', ')}`,
    `Checks config: ${checksFile.path} (${checksFile.action}, ${String(result.configuredCommands.length)} command(s))`,
  ];

  if (result.configuredCommands.length === 0) {
    lines.push('  warning: No verification commands configured. Edit .wukong/checks.json before running `wukong gate`.');
  } else {
    for (const command of result.configuredCommands) {
      lines.push(`  - ${command}`);
    }
  }

  lines.push(`Review policy: ${policyFile.path} (${policyFile.action})`);
  lines.push('');

  if (result.providerStatus === 'unconfigured') {
    if (result.missingProviderId !== undefined) {
      lines.push(`Provider "${result.missingProviderId}" not found.`);
    }
    lines.push('Provider: not configured.');
    lines.push('  Run `wukong`, then enter `/provider`, or run `wukong provider catalog add <providerId>`.');
  } else if (result.providerStatus === 'configured') {
    lines.push(`Provider: configured (${result.configuredProviderIds.join(', ')}).`);
    lines.push('  Run `wukong provider test` to verify connectivity.');
  } else if (result.providerStatus === 'config-error') {
    lines.push('Provider: unable to read provider configuration. Run `wukong doctor` to diagnose.');
  } else {
    if (result.missingProviderId !== undefined) {
      lines.push(`Provider "${result.missingProviderId}" not found.`);
    }
    if (result.providerTests !== undefined && result.providerTests.length > 0) {
      lines.push(formatProviderTestResults(result.providerTests).trimEnd());
    }
  }

  lines.push('');
  lines.push('Next steps:');
  for (const step of result.nextSteps) {
    lines.push(`  ${step}`);
  }
  lines.push('');
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
