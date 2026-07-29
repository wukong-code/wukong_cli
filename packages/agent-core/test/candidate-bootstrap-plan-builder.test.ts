import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import {
  candidateBootstrapRecipeFor,
  canonicalDigest,
  createCandidateBootstrapPreflight,
  createCandidateBootstrapPreflightEntry,
  validateBootstrapBudget,
  validateCandidateBootstrapPlan,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCandidateBootstrapPlan,
  CandidateBootstrapPlanBuilderError,
  confirmCandidateBootstrapPlan,
} from '../src/candidate-bootstrap-plan-builder';
import {
  resolveCandidateBootstrapEnvironment,
} from '../src/candidate-bootstrap-environment';
import { withTrustedExecutablePath } from '../src/trusted-executable';
import { removeTestTree } from './fixtures/remove-test-tree';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const SOURCE_DIGEST = canonicalDigest('test/source', 'source');
const GATE_DIGEST = canonicalDigest('test/gate', 'gate');
const MANIFEST_DIGEST = canonicalDigest('test/manifest', 'manifest');
const LOCKFILE_DIGEST = canonicalDigest('test/lockfile', 'lockfile');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => removeTestTree(root),
  ));
});

describe('candidate bootstrap plan builder', () => {
  it('turns an exact approval into a deterministic private-input plan', async () => {
    const value = await fixture(true);
    const first = await buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: value.preflight.preflightDigest,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    });
    const second = await buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: value.preflight.preflightDigest,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    });

    expect(validateCandidateBootstrapPlan(first.plan)).toBe(true);
    expect(validateBootstrapBudget(first.budget)).toBe(true);
    expect(first.plan).toEqual(second.plan);
    expect(first.budget).toEqual(second.budget);
    expect(first.plan.networkPolicy).toBe('explicit_once');
    expect(first.plan.allowedRegistryEndpointDigests).toHaveLength(1);
    expect(first.preparedSteps).toHaveLength(1);
    expect(first.preparedSteps[0]).toMatchObject({
      argv: [
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        '.wukong-bootstrap/npm-cache',
      ],
      effectiveEnvironment: {
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        PATH: '',
      },
    });
    expect(first.preparedSteps[0]?.effectiveEnvironment)
      .not.toHaveProperty('HTTP_PROXY');
    expect(first.preparedSteps[0]?.effectiveEnvironment)
      .not.toHaveProperty('NPM_TOKEN');
    expect(first.plan.bootstrapBudgetDigest).toBe(first.budget.budgetDigest);
    expect(confirmCandidateBootstrapPlan(
      first,
      first.plan.bootstrapPlanDigest,
    )).toBe(first);
  });

  it('rejects a stale or unapproved preflight digest', async () => {
    const value = await fixture(true);
    await expect(buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: SOURCE_DIGEST,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    })).rejects.toMatchObject({
      reasonCode: 'candidate_bootstrap_preflight_mismatch',
    });
  });

  it('rejects script shims instead of spawning through a shebang', async () => {
    const value = await fixture(false);
    await expect(buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: value.preflight.preflightDigest,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof CandidateBootstrapPlanBuilderError
      && error.reasonCode === 'candidate_bootstrap_runtime_unavailable');
  });

  it('rejects a stale exact plan approval', async () => {
    const value = await fixture(true);
    const prepared = await buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: value.preflight.preflightDigest,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    });
    expect(() => confirmCandidateBootstrapPlan(
      prepared,
      SOURCE_DIGEST,
    )).toThrow(expect.objectContaining({
      reasonCode: 'candidate_bootstrap_confirmation_mismatch',
    }));
  });

  it('freezes a node interpreter plus npm package bundle as one composite runtime', async () => {
    const value = await compositeNpmFixture();
    const prepared = await buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: value.preflight.preflightDigest,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    });

    expect(prepared.preparedSteps[0]?.argv[0])
      .toBe(await realpath(value.npmEntry));
    expect(prepared.preparedSteps[0]?.trustedExecutable.identity
      .runtimeVersionDigest).not.toBe(
      prepared.preparedSteps[0]?.trustedExecutable.identity
        .contentDigest,
    );
    await withTrustedExecutablePath(
      prepared.preparedSteps[0]!.trustedExecutable,
      async () => undefined,
    );

    await writeFile(
      join(value.npmRoot, 'lib', 'cli.js'),
      'module.exports = "changed";\n',
    );
    await expect(withTrustedExecutablePath(
      prepared.preparedSteps[0]!.trustedExecutable,
      async () => undefined,
    )).rejects.toMatchObject({
      reasonCode: 'trusted_runtime_bundle_identity_changed',
    });
  });

  it('revalidates the npm bundle when the guarded callback throws', async () => {
    const value = await compositeNpmFixture();
    const prepared = await buildCandidateBootstrapPlan({
      preflight: value.preflight,
      expectedPreflightDigest: value.preflight.preflightDigest,
      sourceWorkspaceRoot: value.source,
      pathEnvironment: value.bin,
    });

    await expect(withTrustedExecutablePath(
      prepared.preparedSteps[0]!.trustedExecutable,
      async () => {
        await writeFile(
          join(value.npmRoot, 'lib', 'cli.js'),
          'module.exports = "changed-during-callback";\n',
        );
        throw new Error('callback failed');
      },
    )).rejects.toMatchObject({
      reasonCode: 'trusted_runtime_bundle_identity_changed',
    });
  });

  it.runIf(process.env['WUKONG_REAL_ECOSYSTEM_SMOKE'] === '1')(
    'freezes the real Cargo binary behind a rustup proxy',
    async () => {
      const value = await realRustFixture();
      const prepared = await buildCandidateBootstrapPlan({
        preflight: value.preflight,
        expectedPreflightDigest: value.preflight.preflightDigest,
        sourceWorkspaceRoot: value.source,
        pathEnvironment: process.env['PATH'],
      });

      expect(prepared.preparedSteps[0]?.argv)
        .toEqual(['fetch', '--locked']);
      expect(basename(
        prepared.preparedSteps[0]!.effectiveEnvironment['RUSTC']!,
      ).toLowerCase()).toMatch(/^rustc(?:\.exe)?$/);
      await withTrustedExecutablePath(
        prepared.preparedSteps[0]!.trustedExecutable,
        async (absoluteCargoPath) => {
          expect(basename(absoluteCargoPath).toLowerCase())
            .toMatch(/^cargo(?:\.exe)?$/);
          await execFileAsync(
            absoluteCargoPath,
            [...prepared.preparedSteps[0]!.argv],
            {
              cwd: value.source,
              env: resolveCandidateBootstrapEnvironment(
                prepared.preparedSteps[0]!.effectiveEnvironment,
                value.source,
              ),
              timeout: 30_000,
              windowsHide: true,
            },
          );
        },
      );
    },
  );

  it.runIf(process.env['WUKONG_REAL_NETWORK_SMOKE'] === '1')(
    'keeps real Go module and build caches inside the candidate',
    async () => {
      const value = await realGoFixture();
      const prepared = await buildCandidateBootstrapPlan({
        preflight: value.preflight,
        expectedPreflightDigest: value.preflight.preflightDigest,
        sourceWorkspaceRoot: value.source,
        pathEnvironment: process.env['PATH'],
      });
      const step = prepared.preparedSteps[0]!;
      const environment = resolveCandidateBootstrapEnvironment(
        step.effectiveEnvironment,
        value.source,
      );

      expect(environment).toMatchObject({
        GOCACHE: join(value.source, '.wukong-bootstrap', 'go-cache'),
        GOMODCACHE: join(
          value.source,
          '.wukong-bootstrap',
          'go-path',
          'pkg',
          'mod',
        ),
        GOPATH: join(
          value.source,
          '.wukong-bootstrap',
          'go-path',
        ),
      });
      await withTrustedExecutablePath(
        step.trustedExecutable,
        async (absoluteGoPath) => {
          await execFileAsync(absoluteGoPath, [...step.argv], {
            cwd: value.source,
            env: environment,
            timeout: 60_000,
            windowsHide: true,
          });
        },
      );
      await access(join(
        value.source,
        'vendor',
        'rsc.io',
        'quote',
        'quote.go',
      ));
    },
    90_000,
  );

  it.runIf(process.env['WUKONG_REAL_NETWORK_SMOKE'] === '1')(
    'runs the exact real Node and Python registry recipes',
    async () => {
      for (const value of [
        await realNodeFixture(),
        await realPythonFixture(),
      ]) {
        const prepared = await buildCandidateBootstrapPlan({
          preflight: value.preflight,
          expectedPreflightDigest:
            value.preflight.preflightDigest,
          sourceWorkspaceRoot: value.source,
          pathEnvironment: process.env['PATH'],
        });
        const step = prepared.preparedSteps[0]!;
        await withTrustedExecutablePath(
          step.trustedExecutable,
          async (absoluteExecutablePath) => {
            await execFileAsync(
              absoluteExecutablePath,
              [...step.argv],
              {
                cwd: value.source,
                env: resolveCandidateBootstrapEnvironment(
                  step.effectiveEnvironment,
                  value.source,
                ),
                timeout: 90_000,
                windowsHide: true,
              },
            );
          },
        );
        await expect(
          access(join(value.source, value.expectedOutputPath)),
        ).resolves.toBeUndefined();
      }
    },
    180_000,
  );
});

async function fixture(nativeRuntime: boolean): Promise<{
  readonly source: string;
  readonly bin: string;
  readonly preflight: ReturnType<typeof createCandidateBootstrapPreflight>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-plan-'));
  roots.push(root);
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(source), mkdir(bin)]);
  const runtime = join(bin, 'npm');
  if (nativeRuntime) {
    await symlink('/bin/echo', runtime);
  } else {
    await writeFile(runtime, '#!/bin/sh\nexit 0\n');
    await chmod(runtime, 0o755);
  }
  const recipe = candidateBootstrapRecipeFor(
    'node',
    'package-lock.json',
  );
  if (recipe === null) throw new Error('Missing Node bootstrap recipe.');
  const entry = createCandidateBootstrapPreflightEntry({
    ecosystem: 'node',
    ecosystemRef: 'node:npm',
    candidateRelativeCwd: '.',
    manifestPath: 'package.json',
    manifestDigest: MANIFEST_DIGEST,
    lockfilePath: 'package-lock.json',
    lockfileDigest: LOCKFILE_DIGEST,
    status: 'ready',
    reasonCode: 'candidate_bootstrap_confirmation_required',
    recipe,
  });
  return {
    source,
    bin,
    preflight: createCandidateBootstrapPreflight({
      sourceSnapshotDigest: SOURCE_DIGEST,
      gatePlanDigest: GATE_DIGEST,
      entries: [entry],
    }),
  };
}

async function compositeNpmFixture(): Promise<{
  readonly source: string;
  readonly bin: string;
  readonly npmRoot: string;
  readonly npmEntry: string;
  readonly preflight: ReturnType<typeof createCandidateBootstrapPreflight>;
}> {
  const value = await fixture(false);
  await rm(join(value.bin, 'npm'));
  const npmRoot = join(
    value.source,
    '..',
    'runtime',
    'node_modules',
    'npm',
  );
  const npmEntry = join(npmRoot, 'bin', 'npm-cli.js');
  await Promise.all([
    mkdir(join(npmRoot, 'bin'), { recursive: true }),
    mkdir(join(npmRoot, 'lib'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(npmRoot, 'package.json'),
      '{"name":"npm","version":"10.0.0"}\n',
    ),
    writeFile(
      npmEntry,
      '#!/usr/bin/env node\nconsole.log("10.0.0");\n',
    ),
    writeFile(
      join(npmRoot, 'lib', 'cli.js'),
      'module.exports = "stable";\n',
    ),
  ]);
  await chmod(npmEntry, 0o755);
  await Promise.all([
    symlink(npmEntry, join(value.bin, 'npm')),
    symlink(process.execPath, join(value.bin, 'node')),
  ]);
  return {
    ...value,
    npmRoot,
    npmEntry,
  };
}

async function realRustFixture(): Promise<{
  readonly source: string;
  readonly preflight: ReturnType<typeof createCandidateBootstrapPreflight>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-rust-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await mkdir(join(source, 'src'));
  await Promise.all([
    writeFile(
      join(source, 'Cargo.toml'),
      '[package]\nname = "wukong-smoke"\nversion = "0.1.0"\n'
      + 'edition = "2021"\n\n[dependencies]\n',
    ),
    writeFile(
      join(source, 'Cargo.lock'),
      'version = 4\n\n[[package]]\nname = "wukong-smoke"\n'
      + 'version = "0.1.0"\n',
    ),
    writeFile(join(source, 'src', 'main.rs'), 'fn main() {}\n'),
  ]);
  const recipe = candidateBootstrapRecipeFor('rust', 'Cargo.lock');
  if (recipe === null) throw new Error('Missing Rust bootstrap recipe.');
  const entry = createCandidateBootstrapPreflightEntry({
    ecosystem: 'rust',
    ecosystemRef: 'rust:cargo',
    candidateRelativeCwd: '.',
    manifestPath: 'Cargo.toml',
    manifestDigest: MANIFEST_DIGEST,
    lockfilePath: 'Cargo.lock',
    lockfileDigest: LOCKFILE_DIGEST,
    status: 'ready',
    reasonCode: 'candidate_bootstrap_confirmation_required',
    recipe,
  });
  return {
    source,
    preflight: createCandidateBootstrapPreflight({
      sourceSnapshotDigest: SOURCE_DIGEST,
      gatePlanDigest: GATE_DIGEST,
      entries: [entry],
    }),
  };
}

async function realGoFixture(): Promise<{
  readonly source: string;
  readonly preflight: ReturnType<typeof createCandidateBootstrapPreflight>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-go-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await Promise.all([
    writeFile(
      join(source, 'go.mod'),
      'module example.com/wukong-smoke\n\ngo 1.20\n\nrequire (\n'
      + '\tgolang.org/x/text v0.0.0-20170915032832-14c0d48ead0c // indirect\n'
      + '\trsc.io/quote v1.5.2\n'
      + '\trsc.io/sampler v1.3.0 // indirect\n'
      + ')\n',
    ),
    writeFile(
      join(source, 'go.sum'),
      'golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c '
      + 'h1:qgOY6WgZOaTkIIMiVjBQcw93ERBE4m30iBm00nkL0i8=\n'
      + 'golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c/go.mod '
      + 'h1:NqM8EUOU14njkJ3fqMW+pc6Ldnwhi/IjpwHt7yyuwOQ=\n'
      + 'rsc.io/quote v1.5.2 '
      + 'h1:w5fcysjrx7yqtD/aO+QwRjYZOKnaM9Uh2b40tElTs3Y=\n'
      + 'rsc.io/quote v1.5.2/go.mod '
      + 'h1:LzX7hefJvL54yjefDEDHNONDjII0t9xZLPXsUe+TKr0=\n'
      + 'rsc.io/sampler v1.3.0 '
      + 'h1:7uVkIFmeBqHfdjD+gZwtXXI+RODJ2Wc4O7MPEh/QiW4=\n'
      + 'rsc.io/sampler v1.3.0/go.mod '
      + 'h1:T1hPZKmBbMNahiBKFy5HrXp6adAjACjK9JXDnKaTXpA=\n',
    ),
    writeFile(
      join(source, 'main.go'),
      'package main\n\nimport (\n\t"fmt"\n\t"rsc.io/quote"\n)\n\n'
      + 'func main() { fmt.Println(quote.Go()) }\n',
    ),
  ]);
  const recipe = candidateBootstrapRecipeFor('go', 'go.sum');
  if (recipe === null) throw new Error('Missing Go bootstrap recipe.');
  const entry = createCandidateBootstrapPreflightEntry({
    ecosystem: 'go',
    ecosystemRef: 'go:modules',
    candidateRelativeCwd: '.',
    manifestPath: 'go.mod',
    manifestDigest: MANIFEST_DIGEST,
    lockfilePath: 'go.sum',
    lockfileDigest: LOCKFILE_DIGEST,
    status: 'ready',
    reasonCode: 'candidate_bootstrap_confirmation_required',
    recipe,
  });
  return {
    source,
    preflight: createCandidateBootstrapPreflight({
      sourceSnapshotDigest: SOURCE_DIGEST,
      gatePlanDigest: GATE_DIGEST,
      entries: [entry],
    }),
  };
}

async function realNodeFixture(): Promise<{
  readonly source: string;
  readonly expectedOutputPath: string;
  readonly preflight: ReturnType<typeof createCandidateBootstrapPreflight>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-node-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await Promise.all([
    writeFile(
      join(source, 'package.json'),
      '{"name":"wukong-smoke","version":"1.0.0","private":true,'
      + '"dependencies":{"is-number":"7.0.0"}}\n',
    ),
    writeFile(
      join(source, 'package-lock.json'),
      '{"name":"wukong-smoke","version":"1.0.0","lockfileVersion":3,'
      + '"requires":true,"packages":{"":{"name":"wukong-smoke",'
      + '"version":"1.0.0","dependencies":{"is-number":"7.0.0"}},'
      + '"node_modules/is-number":{"version":"7.0.0",'
      + '"resolved":"https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",'
      + '"integrity":"sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",'
      + '"license":"MIT","engines":{"node":">=0.12.0"}}}}\n',
    ),
  ]);
  return {
    source,
    expectedOutputPath: 'node_modules/is-number/index.js',
    preflight: singleEcosystemPreflight('node', 'node:npm'),
  };
}

async function realPythonFixture(): Promise<{
  readonly source: string;
  readonly expectedOutputPath: string;
  readonly preflight: ReturnType<typeof createCandidateBootstrapPreflight>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-bootstrap-python-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await Promise.all([
    writeFile(
      join(source, 'pyproject.toml'),
      '[project]\nname = "wukong-smoke"\nversion = "0.1.0"\n',
    ),
    writeFile(
      join(source, 'requirements.txt'),
      'idna==3.10 '
      + '--hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3\n',
    ),
  ]);
  return {
    source,
    expectedOutputPath: '.wukong-bootstrap/python-site/idna/__init__.py',
    preflight: singleEcosystemPreflight('python', 'python:pip'),
  };
}

function singleEcosystemPreflight(
  ecosystem: 'node' | 'python',
  ecosystemRef: string,
): ReturnType<typeof createCandidateBootstrapPreflight> {
  const lockfile = ecosystem === 'node'
    ? 'package-lock.json'
    : 'requirements.txt';
  const recipe = candidateBootstrapRecipeFor(ecosystem, lockfile);
  if (recipe === null) {
    throw new Error(`Missing ${ecosystem} bootstrap recipe.`);
  }
  const entry = createCandidateBootstrapPreflightEntry({
    ecosystem,
    ecosystemRef,
    candidateRelativeCwd: '.',
    manifestPath: ecosystem === 'node'
      ? 'package.json'
      : 'pyproject.toml',
    manifestDigest: MANIFEST_DIGEST,
    lockfilePath: lockfile,
    lockfileDigest: LOCKFILE_DIGEST,
    status: 'ready',
    reasonCode: 'candidate_bootstrap_confirmation_required',
    recipe,
  });
  return createCandidateBootstrapPreflight({
    sourceSnapshotDigest: SOURCE_DIGEST,
    gatePlanDigest: GATE_DIGEST,
    entries: [entry],
  });
}
