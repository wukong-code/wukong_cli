import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ToolCall } from '@wukong/kosong';
import {
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  clearBrokerReviewTrustBindingsForTests,
  createBrokerReviewTrustProposal,
  createReviewSubjectConsentProposal,
  grantBrokerReviewTrust,
  inspectSourceSnapshot,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  LoopRunReviewSettingsInput,
} from '../src/agent/goal';
import {
  buildCandidateBootstrapPlan,
  inspectCandidateBootstrapPreflight,
} from '../src';
import {
  FLAG_DEFINITIONS,
  FlagResolver,
} from '../src/flags';
import {
  testAgent,
} from './agent/harness/agent';
import { removeTestTree } from './fixtures/remove-test-tree';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const PROVIDER_ENDPOINT = 'https://review.example.test/v1';
const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const RUN_REAL_ECOSYSTEM_LOOP =
  process.env['WUKONG_REAL_ECOSYSTEM_SMOKE'] === '1';
const RUN_REAL_DEPENDENCYFUL_LOOP =
  process.env['WUKONG_REAL_NETWORK_SMOKE'] === '1';

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  vi.unstubAllEnvs();
  clearBrokerReviewTrustBindingsForTests();
  await Promise.all(roots.splice(0).map((root) =>
    removeTestTree(root)));
});

describe('isolated Loop real ecosystem release harness', () => {
  for (const ecosystem of realEcosystems()) {
    it.runIf(RUN_REAL_ECOSYSTEM_LOOP)(
      `${ecosystem.name} preserves dirty source, promotes one delta, and reaches target Final PASS`,
      async () => {
        expect.hasAssertions();
        await runRealEcosystemLoop(ecosystem);
      },
    );
  }

  for (const ecosystem of dependencyfulEcosystems()) {
    it.runIf(RUN_REAL_DEPENDENCYFUL_LOOP)(
      `dependencyful ${ecosystem.name} completes registry bootstrap, Candidate, Promote, and target Final PASS`,
      async () => {
        expect.hasAssertions();
        await runRealEcosystemLoop(ecosystem);
      },
    );
  }
});

interface RealEcosystemFixture {
  readonly name: 'node' | 'python' | 'rust' | 'go';
  readonly gateCommand: string;
  readonly implementationPath: string;
  readonly implementationBefore: string;
  readonly implementationAfter: string;
  readonly files: Readonly<Record<string, string>>;
  readonly bootstrapStatus: 'ready' | 'not_required';
  readonly bootstrapRecipeRef?: string;
  readonly prepareTargetWorkspace?: (
    repository: string,
  ) => Promise<void>;
  readonly assertCandidateBootstrap?: (
    candidateRoot: string,
  ) => Promise<void>;
  readonly fixedRegistryEndpoint?: string;
}

async function runRealEcosystemLoop(
  ecosystem: RealEcosystemFixture,
): Promise<void> {
  const parent = await mkdtemp(
    join(tmpdir(), `wukong-real-${ecosystem.name}-loop-`),
  );
  roots.push(parent);
  const repository = join(parent, 'repository');
  const sessionHome = join(parent, 'session');
  const wukongHome = join(parent, 'wukong-home');
  await git(parent, ['init', 'repository']);
  await Promise.all(Object.entries(ecosystem.files).map(
    async ([path, content]) => {
      const absolutePath = join(repository, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    },
  ));
  await writeFile(join(repository, 'context.txt'), 'clean context\n');
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'base',
  ]);
  await writeFile(
    join(repository, 'context.txt'),
    'user dirty context must survive\n',
  );
  if (ecosystem.prepareTargetWorkspace !== undefined) {
    try {
      await ecosystem.prepareTargetWorkspace(repository);
    } catch (error) {
      throw new Error(
        `${ecosystem.name} dependency fixture could not reach ${ecosystem.fixedRegistryEndpoint ?? 'the fixed public registry'} or install its exact locked dependency.`,
        { cause: error },
      );
    }
  }
  const dirtyStatus = await gitStatusLines(repository);
  expect(dirtyStatus).toEqual(['M context.txt']);

  const objective =
    `Change ${ecosystem.implementationPath} to the approved after value`;
  const completionCriterion =
    `${ecosystem.implementationPath} has the approved value and ${ecosystem.gateCommand} passes`;
  const finishLine = await buildFinishLine({
    cwd: repository,
    objective,
    completionCriterion,
    explicitChecks: [ecosystem.gateCommand],
    includeDiscoveredChecks: false,
  });
  if (!finishLine.ok) throw new Error(finishLine.failure.message);
  const source = await inspectSourceSnapshot({ cwd: repository });
  if (source.status !== 'ready' || source.proposedSnapshot === null) {
    throw new Error(
      `${ecosystem.name} source snapshot is not ready.`,
    );
  }
  const sourceSnapshot = source.proposedSnapshot;
  const preflight = await inspectCandidateBootstrapPreflight({
    sourceSnapshotCwd: repository,
    sourceSnapshot,
    gatePlan: finishLine.proposal.gatePlan,
  });
  expect(preflight.status).toBe(ecosystem.bootstrapStatus);
  const preparedBootstrap = preflight.status === 'ready'
    ? await buildCandidateBootstrapPlan({
        preflight,
        expectedPreflightDigest: preflight.preflightDigest,
        sourceWorkspaceRoot: repository,
      })
    : null;
  if (preparedBootstrap !== null) {
    expect(preparedBootstrap.preparedSteps).toHaveLength(1);
    expect(preparedBootstrap.preparedSteps[0]?.step.recipeRef)
      .toBe(ecosystem.bootstrapRecipeRef);
  }

  const spawn = vi.fn(async (input: { readonly prompt: string }) => ({
    agentId: `fresh-${ecosystem.name}-reviewer`,
    profileName: 'fresh-reviewer',
    resumed: false,
    completion: Promise.resolve({
      result: freshPassFromPrompt(input.prompt),
    }),
  }));
  const ctx = testAgent({
    homedir: sessionHome,
    wukongHomeDir: wukongHome,
    experimentalFlags: new FlagResolver(
      {
        WUKONG_CODE_EXPERIMENTAL_ISOLATED_LOOP_WORKTREES: '1',
      },
      FLAG_DEFINITIONS,
    ),
    subagentHost: { spawn } as never,
  });
  ctx.configure({
    provider: {
      type: 'anthropic',
      apiKey: 'test-key',
      model: 'writer-model',
      baseUrl: PROVIDER_ENDPOINT,
    },
  });
  ctx.agent.permission.setMode('yolo');
  ctx.agent.config.update({ cwd: repository });
  const reviewSettings = makeReviewSettings(
    finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
  );
  await ctx.agent.goal.createGoal({
    objective,
    completionCriterion: finishLine.proposal.completionCriterion,
    stopCondition: 'proof-pass',
    reviewModel: 'writer-model',
    loopContract: {
      schemaVersion: 2,
      objective,
      completionCriterion: finishLine.proposal.completionCriterion,
      constraints: finishLine.proposal.constraints,
      finishLineReview: {
        ...finishLine.proposal.finishLineReview,
        acknowledgedWarningIds:
          finishLine.proposal.finishLineReview.warnings.map(
            (warning) => warning.id,
          ),
      },
      workspaceIdentity: finishLine.proposal.workspaceIdentity,
      workspaceTrust: finishLine.proposal.workspaceTrust,
      gateApproval: finishLine.proposal.gateApproval,
      gatePlan: finishLine.proposal.gatePlan,
      reviewPolicy: finishLine.proposal.reviewPolicy,
      reviewSettings,
      source: 'user',
    },
  });
  const writeCall: ToolCall = {
    type: 'function',
    id: `call_write_${ecosystem.name}_candidate`,
    name: 'Write',
    arguments: JSON.stringify({
      path: ecosystem.implementationPath,
      content: ecosystem.implementationAfter,
    }),
  };
  ctx.mockNextResponse(
    {
      type: 'text',
      text: `I will update the ${ecosystem.name} candidate.`,
    },
    writeCall,
  );
  ctx.mockNextResponse({
    type: 'text',
    text: 'The candidate is ready for independent verification.',
  });

  const payload = {
    schemaVersion: 1 as const,
    sourceRepositoryRoot: repository,
    sourceSnapshotCwd: repository,
    sourceSnapshot,
    approvedBootstrapPlanDigest:
      preparedBootstrap?.plan.bootstrapPlanDigest,
  };
  let candidate: Awaited<ReturnType<
    typeof ctx.agent.runIsolatedLoopCandidateIteration
  >>;
  try {
    candidate =
      await ctx.agent.runIsolatedLoopCandidateIteration(payload);
  } catch (error) {
    if (ecosystem.fixedRegistryEndpoint !== undefined) {
      throw new Error(
        `${ecosystem.name} candidate failed while executing the exact bootstrap plan for ${ecosystem.fixedRegistryEndpoint}; this is a registry/bootstrap failure, not a skipped smoke test.`,
        { cause: error },
      );
    }
    throw error;
  }
  const candidateRoot = join(
    sessionHome,
    'runtime',
    'isolated-loop',
    'candidates',
    candidate.candidateId,
    'worktree',
  );
  if (candidate.outcome !== 'PASS') {
    const candidateValue = await readFile(
      join(candidateRoot, ecosystem.implementationPath),
      'utf8',
    );
    throw new Error(
      `${ecosystem.name} candidate did not pass: ${
        JSON.stringify({ candidate, candidateValue })
      }`,
    );
  }
  expect(candidate).toMatchObject({
    outcome: 'PASS',
    leaseState: 'awaiting_promotion',
    writerRan: true,
    iteration: 1,
  });
  await ecosystem.assertCandidateBootstrap?.(candidateRoot);
  expect(await readFile(
    join(repository, ecosystem.implementationPath),
    'utf8',
  )).toBe(ecosystem.implementationBefore);
  expect(await readFile(
    join(repository, 'context.txt'),
    'utf8',
  )).toBe('user dirty context must survive\n');
  expect(await gitStatusLines(repository)).toEqual(dirtyStatus);

  expect(await readFile(
    join(candidateRoot, ecosystem.implementationPath),
    'utf8',
  )).toBe(ecosystem.implementationAfter);
  expect(await readFile(
    join(candidateRoot, 'context.txt'),
    'utf8',
  )).toBe('user dirty context must survive\n');

  const proposal =
    await ctx.agent.prepareIsolatedLoopPromotion(payload);
  expect(proposal).toMatchObject({
    candidateId: candidate.candidateId,
    changedFileCount: 1,
    changes: [{
      operation: 'update',
      sourcePath: ecosystem.implementationPath,
      targetPath: ecosystem.implementationPath,
    }],
  });
  const promoted = await ctx.agent.promoteIsolatedLoopCandidate({
    ...payload,
    proposalDigest: proposal.proposalDigest,
  });
  expect(promoted).toMatchObject({
    candidateId: candidate.candidateId,
    outcome: 'PASS',
    reasonCode: 'target_final_gate_passed',
  });
  expect(await readFile(
    join(repository, ecosystem.implementationPath),
    'utf8',
  )).toBe(ecosystem.implementationAfter);
  expect(await readFile(
    join(repository, 'context.txt'),
    'utf8',
  )).toBe('user dirty context must survive\n');
  expect(await gitStatusLines(repository)).toEqual([
    'M context.txt',
    `M ${ecosystem.implementationPath}`,
  ].toSorted());
  expect(ctx.agent.goal.getGoal().goal).toBeNull();
  expect(spawn).toHaveBeenCalledTimes(2);
}

function realEcosystems(): readonly RealEcosystemFixture[] {
  return [
    {
      name: 'node',
      gateCommand: 'npm test',
      implementationPath: 'value.cjs',
      implementationBefore:
        'module.exports = { value: "before" };\n',
      implementationAfter:
        'module.exports = { value: "after" };\n',
      bootstrapStatus: 'ready',
      bootstrapRecipeRef: 'builtin:node:npm-ci',
      files: {
        '.gitignore': 'node_modules/\n.wukong-bootstrap/\n',
        'package.json':
          '{"name":"wukong-real-loop","version":"1.0.0",'
          + '"private":true,"scripts":{"test":"node --test"}}\n',
        'package-lock.json':
          '{"name":"wukong-real-loop","version":"1.0.0",'
          + '"lockfileVersion":3,"requires":true,"packages":{'
          + '"":{"name":"wukong-real-loop","version":"1.0.0"}}}\n',
        'value.cjs': 'module.exports = { value: "before" };\n',
        'value.test.cjs':
          'const test = require("node:test");\n'
          + 'const assert = require("node:assert/strict");\n'
          + 'const { value } = require("./value.cjs");\n'
          + 'test("approved value", () => assert.equal(value, "after"));\n',
      },
    },
    {
      name: 'python',
      gateCommand: `${PYTHON_COMMAND} -B -m unittest -q`,
      implementationPath: 'app.py',
      implementationBefore:
        'def value():\n    return "before"\n',
      implementationAfter:
        'def value():\n    return "after"\n',
      bootstrapStatus: 'not_required',
      files: {
        '.gitignore': '__pycache__/\n.wukong-bootstrap/\n',
        'pyproject.toml':
          '[project]\nname = "wukong-real-loop"\nversion = "0.1.0"\n',
        'requirements.txt': '',
        'app.py': 'def value():\n    return "before"\n',
        'test_app.py':
          'import unittest\n\n'
          + 'from app import value\n\n\n'
          + 'class ValueTest(unittest.TestCase):\n'
          + '    def test_approved_value(self):\n'
          + '        self.assertEqual(value(), "after")\n',
      },
    },
    {
      name: 'rust',
      gateCommand: 'cargo test --locked',
      implementationPath: 'src/lib.rs',
      implementationBefore:
        'pub fn value() -> &\'static str { "before" }\n\n'
        + '#[cfg(test)]\nmod tests {\n'
        + '    #[test]\n    fn approved_value() {\n'
        + '        assert_eq!(super::value(), "after");\n'
        + '    }\n}\n',
      implementationAfter:
        'pub fn value() -> &\'static str { "after" }\n\n'
        + '#[cfg(test)]\nmod tests {\n'
        + '    #[test]\n    fn approved_value() {\n'
        + '        assert_eq!(super::value(), "after");\n'
        + '    }\n}\n',
      bootstrapStatus: 'ready',
      bootstrapRecipeRef: 'builtin:rust:cargo-fetch',
      files: {
        '.gitignore': 'target/\n.wukong-bootstrap/\n',
        'Cargo.toml':
          '[package]\nname = "wukong-real-loop"\nversion = "0.1.0"\n'
          + 'edition = "2021"\n\n[dependencies]\n',
        'Cargo.lock':
          'version = 4\n\n[[package]]\n'
          + 'name = "wukong-real-loop"\nversion = "0.1.0"\n',
        'src/lib.rs':
          'pub fn value() -> &\'static str { "before" }\n\n'
          + '#[cfg(test)]\nmod tests {\n'
          + '    #[test]\n    fn approved_value() {\n'
          + '        assert_eq!(super::value(), "after");\n'
          + '    }\n}\n',
      },
    },
    {
      name: 'go',
      gateCommand: 'go test ./...',
      implementationPath: 'value.go',
      implementationBefore:
        'package wukongloop\n\nfunc Value() string { return "before" }\n',
      implementationAfter:
        'package wukongloop\n\nfunc Value() string { return "after" }\n',
      bootstrapStatus: 'ready',
      bootstrapRecipeRef: 'builtin:go:mod-vendor',
      files: {
        '.gitignore': 'vendor/\n.wukong-bootstrap/\n',
        'go.mod': 'module example.com/wukong-loop\n\ngo 1.20\n',
        'go.sum': '',
        'value.go':
          'package wukongloop\n\nfunc Value() string { return "before" }\n',
        'value_test.go':
          'package wukongloop\n\nimport "testing"\n\n'
          + 'func TestApprovedValue(t *testing.T) {\n'
          + '\tif Value() != "after" { t.Fatal("unexpected value") }\n'
          + '}\n',
      },
    },
  ];
}

function dependencyfulEcosystems(): readonly RealEcosystemFixture[] {
  return [
    dependencyfulNodeEcosystem(),
    dependencyfulPythonEcosystem(),
    dependencyfulRustEcosystem(),
    dependencyfulGoEcosystem(),
  ];
}

function dependencyfulNodeEcosystem(): RealEcosystemFixture {
  const implementationBefore =
    dependencyfulNodeImplementation('before');
  const implementationAfter =
    dependencyfulNodeImplementation('after');
  return {
    name: 'node',
    gateCommand: 'npm test',
    implementationPath: 'value.cjs',
    implementationBefore,
    implementationAfter,
    bootstrapStatus: 'ready',
    bootstrapRecipeRef: 'builtin:node:npm-ci',
    fixedRegistryEndpoint: 'https://registry.npmjs.org/',
    prepareTargetWorkspace: installExactNodeTargetDependency,
    assertCandidateBootstrap: async (candidateRoot) => {
      const dependency = await readFile(
        join(
          candidateRoot,
          'node_modules',
          'is-number',
          'index.js',
        ),
        'utf8',
      );
      expect(dependency.length).toBeGreaterThan(0);
    },
    files: {
      '.gitignore':
        'node_modules/\n.wukong-bootstrap/\n',
      'package.json':
        '{"name":"wukong-dependency-loop","version":"1.0.0",'
        + '"private":true,"scripts":{"test":"node --test"},'
        + '"dependencies":{"is-number":"7.0.0"}}\n',
      'package-lock.json':
        '{"name":"wukong-dependency-loop","version":"1.0.0",'
        + '"lockfileVersion":3,"requires":true,"packages":{'
        + '"":{"name":"wukong-dependency-loop","version":"1.0.0",'
        + '"dependencies":{"is-number":"7.0.0"}},'
        + '"node_modules/is-number":{"version":"7.0.0",'
        + '"resolved":"https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",'
        + '"integrity":"sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",'
        + '"license":"MIT","engines":{"node":">=0.12.0"}}}}\n',
      'value.cjs': implementationBefore,
      'value.test.cjs':
        'const test = require("node:test");\n'
        + 'const assert = require("node:assert/strict");\n'
        + 'const { value } = require("./value.cjs");\n'
        + 'test("approved value", () => '
        + 'assert.equal(value(), "after"));\n',
    },
  };
}

function dependencyfulNodeImplementation(
  value: 'before' | 'after',
): string {
  return 'const isNumber = require("is-number");\n\n'
    + 'function value() {\n'
    + '  if (!isNumber(7)) throw new Error("dependency failed");\n'
    + `  return "${value}";\n`
    + '}\n\nmodule.exports = { value };\n';
}

function dependencyfulPythonEcosystem(): RealEcosystemFixture {
  const implementationBefore = dependencyfulPythonImplementation('before');
  const implementationAfter = dependencyfulPythonImplementation('after');
  return {
    name: 'python',
    gateCommand: `${PYTHON_COMMAND} -B -m unittest -q`,
    implementationPath: 'app.py',
    implementationBefore,
    implementationAfter,
    bootstrapStatus: 'ready',
    bootstrapRecipeRef: 'builtin:python:pip-hashed-wheels',
    fixedRegistryEndpoint: 'https://pypi.org/simple/',
    prepareTargetWorkspace: installExactPythonTargetDependency,
    assertCandidateBootstrap: async (candidateRoot) => {
      const dependencyPath = join(
        candidateRoot,
        '.wukong-bootstrap',
        'python-site',
        'idna',
        '__init__.py',
      );
      const dependency = await readFile(dependencyPath, 'utf8');
      expect(dependency.length).toBeGreaterThan(0);
      const { stdout } = await execFileAsync(
        PYTHON_COMMAND,
        [
          '-I',
          '-c',
          'import pathlib,sys;'
          + 'sys.path.insert(0,str(pathlib.Path(".wukong-bootstrap/python-site").resolve()));'
          + 'import idna;print(idna.__version__)',
        ],
        {
          cwd: candidateRoot,
          env: pythonVerificationEnvironment(),
          timeout: 30_000,
          windowsHide: true,
        },
      );
      expect(stdout.trim()).toBe('3.10');
    },
    files: {
      '.gitignore': '__pycache__/\n.wukong-bootstrap/\n',
      'pyproject.toml':
        '[project]\nname = "wukong-real-loop"\nversion = "0.1.0"\n',
      'requirements.txt':
        'idna==3.10 '
        + '--hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3\n',
      'app.py': implementationBefore,
      'test_app.py':
        'import unittest\n\n'
        + 'from app import dependency_version, value\n\n\n'
        + 'class ValueTest(unittest.TestCase):\n'
        + '    def test_approved_value(self):\n'
        + '        self.assertEqual(dependency_version(), "3.10")\n'
        + '        self.assertEqual(value(), "after")\n',
    },
  };
}

function dependencyfulRustEcosystem(): RealEcosystemFixture {
  const implementationBefore =
    dependencyfulRustImplementation('before');
  const implementationAfter =
    dependencyfulRustImplementation('after');
  return {
    name: 'rust',
    gateCommand:
      'CARGO_HOME=.wukong-bootstrap/cargo-home cargo test --locked',
    implementationPath: 'src/lib.rs',
    implementationBefore,
    implementationAfter,
    bootstrapStatus: 'ready',
    bootstrapRecipeRef: 'builtin:rust:cargo-fetch',
    fixedRegistryEndpoint: 'https://index.crates.io/',
    prepareTargetWorkspace: installExactRustTargetDependency,
    files: {
      '.gitignore':
        'target/\n.wukong-bootstrap/\n',
      'Cargo.toml':
        '[package]\nname = "wukong_dependency_loop"\n'
        + 'version = "0.1.0"\nedition = "2021"\n\n'
        + '[dependencies]\nitoa = "=1.0.15"\n',
      'Cargo.lock':
        '# This file is automatically @generated by Cargo.\n'
        + '# It is not intended for manual editing.\n'
        + 'version = 4\n\n'
        + '[[package]]\nname = "itoa"\nversion = "1.0.15"\n'
        + 'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
        + 'checksum = "4a5f13b858c8d314ee3e8f639011f7ccefe71f97f96e50151fb991f267928e2c"\n\n'
        + '[[package]]\nname = "wukong_dependency_loop"\n'
        + 'version = "0.1.0"\ndependencies = [\n "itoa",\n]\n',
      'src/lib.rs': implementationBefore,
    },
  };
}

function dependencyfulRustImplementation(
  value: 'before' | 'after',
): string {
  return 'pub fn value() -> &\'static str {\n'
    + '    let mut buffer = itoa::Buffer::new();\n'
    + '    assert_eq!(buffer.format(7), "7");\n'
    + `    "${value}"\n`
    + '}\n\n'
    + '#[cfg(test)]\nmod tests {\n'
    + '    #[test]\n    fn approved_value() {\n'
    + '        assert_eq!(super::value(), "after");\n'
    + '    }\n}\n';
}

function dependencyfulGoEcosystem(): RealEcosystemFixture {
  const implementationBefore =
    dependencyfulGoImplementation('before');
  const implementationAfter =
    dependencyfulGoImplementation('after');
  return {
    name: 'go',
    gateCommand: 'go test ./...',
    implementationPath: 'value.go',
    implementationBefore,
    implementationAfter,
    bootstrapStatus: 'ready',
    bootstrapRecipeRef: 'builtin:go:mod-vendor',
    fixedRegistryEndpoint: 'https://proxy.golang.org',
    prepareTargetWorkspace: installExactGoTargetDependency,
    assertCandidateBootstrap: async (candidateRoot) => {
      const dependency = await readFile(
        join(
          candidateRoot,
          'vendor',
          'rsc.io',
          'quote',
          'quote.go',
        ),
        'utf8',
      );
      expect(dependency.length).toBeGreaterThan(0);
    },
    files: {
      '.gitignore':
        'vendor/\n.wukong-bootstrap/\n',
      'go.mod':
        'module example.com/wukong-dependency-loop\n\n'
        + 'go 1.20\n\nrequire (\n'
        + '\tgolang.org/x/text '
        + 'v0.0.0-20170915032832-14c0d48ead0c // indirect\n'
        + '\trsc.io/quote v1.5.2\n'
        + '\trsc.io/sampler v1.3.0 // indirect\n'
        + ')\n',
      'go.sum':
        'golang.org/x/text '
        + 'v0.0.0-20170915032832-14c0d48ead0c '
        + 'h1:qgOY6WgZOaTkIIMiVjBQcw93ERBE4m30iBm00nkL0i8=\n'
        + 'golang.org/x/text '
        + 'v0.0.0-20170915032832-14c0d48ead0c/go.mod '
        + 'h1:NqM8EUOU14njkJ3fqMW+pc6Ldnwhi/IjpwHt7yyuwOQ=\n'
        + 'rsc.io/quote v1.5.2 '
        + 'h1:w5fcysjrx7yqtD/aO+QwRjYZOKnaM9Uh2b40tElTs3Y=\n'
        + 'rsc.io/quote v1.5.2/go.mod '
        + 'h1:LzX7hefJvL54yjefDEDHNONDjII0t9xZLPXsUe+TKr0=\n'
        + 'rsc.io/sampler v1.3.0 '
        + 'h1:7uVkIFmeBqHfdjD+gZwtXXI+RODJ2Wc4O7MPEh/QiW4=\n'
        + 'rsc.io/sampler v1.3.0/go.mod '
        + 'h1:T1hPZKmBbMNahiBKFy5HrXp6adAjACjK9JXDnKaTXpA=\n',
      'value.go': implementationBefore,
      'value_test.go':
        'package wukongloop\n\nimport "testing"\n\n'
        + 'func TestApprovedValue(t *testing.T) {\n'
        + '\tif Value() != "after" { t.Fatal("unexpected value") }\n'
        + '}\n',
    },
  };
}

function dependencyfulGoImplementation(
  value: 'before' | 'after',
): string {
  return 'package wukongloop\n\n'
    + 'import "rsc.io/quote"\n\n'
    + 'func Value() string {\n'
    + '\tif quote.Go() == "" { panic("dependency failed") }\n'
    + `\treturn "${value}"\n`
    + '}\n';
}

function dependencyfulPythonImplementation(
  value: 'before' | 'after',
): string {
  return 'from pathlib import Path\n'
    + 'import sys\n\n'
    + '_DEPENDENCY_ROOT = Path(__file__).resolve().parent '
    + '/ ".wukong-bootstrap" / "python-site"\n'
    + 'sys.path.insert(0, str(_DEPENDENCY_ROOT))\n\n'
    + 'import idna\n\n\n'
    + 'def dependency_version():\n'
    + '    return idna.__version__\n\n\n'
    + 'def value():\n'
    + `    return idna.encode("${value}").decode("ascii")\n`;
}

async function installExactNodeTargetDependency(
  repository: string,
): Promise<void> {
  await execFileAsync(
    NPM_COMMAND,
    [
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      '.wukong-bootstrap/target-npm-cache',
    ],
    {
      cwd: repository,
      env: {
        CI: '1',
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
        PATH: process.env['PATH'] ?? '',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_USERCONFIG:
          process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

async function installExactPythonTargetDependency(
  repository: string,
): Promise<void> {
  await execFileAsync(
    PYTHON_COMMAND,
    [
      '-m',
      'pip',
      'install',
      '--require-hashes',
      '--only-binary=:all:',
      '--no-input',
      '--disable-pip-version-check',
      '--no-cache-dir',
      '--index-url',
      'https://pypi.org/simple/',
      '--target',
      '.wukong-bootstrap/python-site',
      '-r',
      'requirements.txt',
    ],
    {
      cwd: repository,
      env: pythonVerificationEnvironment(),
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

async function installExactRustTargetDependency(
  repository: string,
): Promise<void> {
  const cargoHome = join(
    repository,
    '.wukong-bootstrap',
    'cargo-home',
  );
  await execFileAsync(
    'cargo',
    ['fetch', '--locked'],
    {
      cwd: repository,
      env: {
        CI: '1',
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'],
        USERPROFILE: process.env['USERPROFILE'],
        RUSTUP_HOME: process.env['RUSTUP_HOME'],
        CARGO_HOME: cargoHome,
        CARGO_NET_GIT_FETCH_WITH_CLI: 'false',
        CARGO_REGISTRIES_CRATES_IO_INDEX:
          'sparse+https://index.crates.io/',
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
      },
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

async function installExactGoTargetDependency(
  repository: string,
): Promise<void> {
  await execFileAsync(
    'go',
    ['mod', 'vendor'],
    {
      cwd: repository,
      env: {
        CI: '1',
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
        PATH: process.env['PATH'] ?? '',
        GOENV: 'off',
        GOCACHE: join(
          repository,
          '.wukong-bootstrap',
          'target-go-cache',
        ),
        GOMODCACHE: join(
          repository,
          '.wukong-bootstrap',
          'target-go-path',
          'pkg',
          'mod',
        ),
        GONOSUMDB: '',
        GOPATH: join(
          repository,
          '.wukong-bootstrap',
          'target-go-path',
        ),
        GOPRIVATE: '',
        GOPROXY: 'https://proxy.golang.org',
        GOSUMDB: 'sum.golang.org',
        GOTOOLCHAIN: 'local',
      },
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

function pythonVerificationEnvironment(): NodeJS.ProcessEnv {
  return {
    CI: '1',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PATH: process.env['PATH'] ?? '',
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_CACHE_DIR: '1',
    PIP_NO_INPUT: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
}

function makeReviewSettings(
  workspaceIdentityDigest: string,
): LoopRunReviewSettingsInput {
  const trustProposal = createBrokerReviewTrustProposal({
    workspaceIdentityDigest,
    intent: 'once',
  });
  const consentProposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest,
    allowedOrigins: ['changed-tracked', 'gate-evidence'],
    providerId: 'test-provider',
    endpoint: PROVIDER_ENDPOINT,
  });
  return {
    brokerReviewTrust: grantBrokerReviewTrust(
      trustProposal,
      trustProposal.trustProposalDigest,
      'real-ecosystem-loop-trust',
    ),
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
      1_000,
    ),
  };
}

function freshPassFromPrompt(prompt: string): string {
  const attemptId = lineValue(prompt, 'Attempt: ');
  const reviewerInputDigest =
    lineValue(prompt, 'Reviewer input digest: ');
  const criteria = JSON.parse(
    lineValue(prompt, 'Frozen criteria: '),
  ) as Array<{
    readonly criterionId: string;
    readonly criterionProvenanceDigest: string;
  }>;
  const priorBlockerKeys = JSON.parse(
    lineValue(prompt, 'Prior blocker keys: '),
  ) as string[];
  const manifest = JSON.parse(
    lineValue(prompt, 'Review Subject manifest: '),
  ) as {
    readonly entries: readonly {
      readonly subjectRef: string;
      readonly sha256: string;
    }[];
  };
  const firstSubject = manifest.entries[0];
  if (firstSubject === undefined) {
    throw new Error('Reviewer fixture requires one changed subject.');
  }
  const evidence = [{
    kind: 'review-subject',
    subjectRef: firstSubject.subjectRef,
    subjectDigest: firstSubject.sha256,
  }];
  const verdict = {
    schemaVersion: 1,
    attemptId,
    reviewerInputDigest,
    status: 'PASS',
    criterionDispositions: criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      criterionProvenanceDigest:
        criterion.criterionProvenanceDigest,
      status: 'satisfied',
      evidence,
    })),
    priorBlockerDispositions: priorBlockerKeys.map(
      (blockerKey) => ({
        blockerKey,
        status: 'resolved',
        evidence,
      }),
    ),
    findings: [],
  };
  return `FRESH_VERDICT_JSON: ${JSON.stringify(verdict)}`;
}

function lineValue(prompt: string, prefix: string): string {
  const line = prompt.split('\n').find(
    (candidate) => candidate.startsWith(prefix),
  );
  if (line === undefined) {
    throw new Error(`Prompt line missing: ${prefix}`);
  }
  return line.slice(prefix.length);
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}

async function gitStatusLines(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--short'],
    { cwd },
  );
  return stdout.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
}
