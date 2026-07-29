import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildFinishLine,
  inspectSourceSnapshot,
  type GatePlan,
  type SourceSnapshotV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectCandidateBootstrapPreflight,
} from '../src/candidate-bootstrap-preflight';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe('candidate bootstrap preflight inspector', () => {
  it.each([
    {
      name: 'Node',
      command: 'npm test',
      runtime: 'npm',
      files: {
        'package.json': JSON.stringify({
          scripts: { test: 'node --test' },
          devDependencies: { example: '1.0.0' },
        }),
        'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
      },
      ecosystem: 'node',
      recipeRef: 'builtin:node:npm-ci',
    },
    {
      name: 'Python',
      command: 'python3 -m pytest',
      runtime: 'python3',
      files: {
        'pyproject.toml': '[tool.pytest.ini_options]\n',
        'requirements.txt':
          `pytest==9.0.0 --hash=sha256:${'a'.repeat(64)}\n`,
      },
      ecosystem: 'python',
      recipeRef: 'builtin:python:pip-hashed-wheels',
    },
    {
      name: 'Rust',
      command: 'cargo test',
      runtime: 'cargo',
      files: {
        'Cargo.toml':
          '[package]\nname = "fixture"\nversion = "0.1.0"\n'
          + '[dependencies]\nexample = "1"\n',
        'Cargo.lock': 'version = 4\n',
      },
      ecosystem: 'rust',
      recipeRef: 'builtin:rust:cargo-fetch',
    },
    {
      name: 'Go',
      command: 'go test ./...',
      runtime: 'go',
      files: {
        'go.mod':
          'module example.test/fixture\n\ngo 1.23\n\n'
          + 'require example.test/dependency v1.0.0\n',
        'go.sum': 'example.test/dependency v1.0.0 h1:fixture\n',
      },
      ecosystem: 'go',
      recipeRef: 'builtin:go:mod-vendor',
    },
  ] satisfies readonly {
    readonly name: string;
    readonly command: string;
    readonly runtime: string;
    readonly files: Readonly<Record<string, string>>;
    readonly ecosystem: 'go' | 'node' | 'python' | 'rust';
    readonly recipeRef: string;
  }[])(
    'freezes a deterministic $name lockfile recipe',
    async ({ command, runtime, files, ecosystem, recipeRef }) => {
      const value = await fixture(files, command, [runtime]);
      const result = await inspectCandidateBootstrapPreflight({
        sourceSnapshotCwd: value.repository,
        sourceSnapshot: value.snapshot,
        gatePlan: value.gatePlan,
        pathEnvironment: value.bin,
      });

      expect(result.status).toBe('ready');
      expect(result.reasonCode).toBe(
        'candidate_bootstrap_confirmation_required',
      );
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        ecosystem,
        status: 'ready',
        reasonCode: 'candidate_bootstrap_confirmation_required',
        recipe: {
          recipeRef,
          lifecycleScripts: 'deny',
          nativeBuildHooks: 'deny',
          postInstallCommands: 'deny',
        },
      });
    },
  );

  it('returns not_required for a dependency-free Node project', async () => {
    const value = await fixture({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test' },
      }),
    }, 'npm test', []);
    const result = await inspectCandidateBootstrapPreflight({
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      gatePlan: value.gatePlan,
      pathEnvironment: '',
    });

    expect(result.status).toBe('not_required');
    expect(result.entries[0]).toMatchObject({
      ecosystem: 'node',
      status: 'not_required',
      reasonCode: 'candidate_bootstrap_not_required',
    });
  });

  it('blocks an unsupported package-manager lockfile deterministically', async () => {
    const value = await fixture({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '1.0.0' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
    }, 'pnpm test', ['pnpm']);
    const result = await inspectCandidateBootstrapPreflight({
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      gatePlan: value.gatePlan,
      pathEnvironment: value.bin,
    });

    expect(result.status).toBe('unsupported');
    expect(result.reasonCode).toBe(
      'candidate_bootstrap_lockfile_unsupported',
    );
    expect(result.entries[0]?.lockfilePath).toBe('pnpm-lock.yaml');
  });

  it('blocks ambiguous Node lockfiles before runtime resolution', async () => {
    const value = await fixture({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test' },
        dependencies: { example: '1.0.0' },
      }),
      'package-lock.json': '{"lockfileVersion":3}\n',
      'yarn.lock': '# yarn\n',
    }, 'npm test', ['npm']);
    const result = await inspectCandidateBootstrapPreflight({
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      gatePlan: value.gatePlan,
      pathEnvironment: value.bin,
    });

    expect(result.status).toBe('unsupported');
    expect(result.reasonCode).toBe(
      'candidate_bootstrap_lockfile_ambiguous',
    );
    expect(result.entries[0]?.lockfilePath).toBeNull();
  });

  it('rejects a package lock that can fetch outside the confirmed registry', async () => {
    const value = await fixture({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test' },
        dependencies: { example: '1.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/example': {
            resolved: 'https://example.test/example.tgz',
            integrity: 'sha512-Zml4dHVyZQ==',
          },
        },
      }),
    }, 'npm test', ['npm']);
    const result = await inspectCandidateBootstrapPreflight({
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      gatePlan: value.gatePlan,
      pathEnvironment: value.bin,
    });

    expect(result.status).toBe('unsupported');
    expect(result.reasonCode).toBe(
      'candidate_bootstrap_lockfile_unsupported',
    );
  });

  it.each([
    {
      command: 'npm test',
      runtime: 'npm',
      files: {
        'package.json': JSON.stringify({
          scripts: { test: 'node --test' },
          dependencies: { example: '1.0.0' },
        }),
        'package-lock.json':
          '{"lockfileVersion":3,"packages":{"":{}}}\n',
        '.npmrc': 'registry=https://packages.example.test/\n',
      },
      ecosystem: 'node',
    },
    {
      command: 'cargo test',
      runtime: 'cargo',
      files: {
        'Cargo.toml':
          '[package]\nname="fixture"\nversion="0.1.0"\n'
          + '[dependencies]\nexample="1"\n',
        'Cargo.lock': 'version = 4\n',
        '.cargo/config.toml':
          '[source.crates-io]\nreplace-with = "other"\n',
      },
      ecosystem: 'rust',
    },
  ])(
    'rejects project registry configuration for $ecosystem bootstrap',
    async ({ command, runtime, files, ecosystem }) => {
      const value = await fixture(files, command, [runtime]);
      const result = await inspectCandidateBootstrapPreflight({
        sourceSnapshotCwd: value.repository,
        sourceSnapshot: value.snapshot,
        gatePlan: value.gatePlan,
        pathEnvironment: value.bin,
      });

      expect(result.entries).toMatchObject([{
        ecosystem,
        status: 'unsupported',
        reasonCode: 'candidate_bootstrap_lockfile_unsupported',
      }]);
    },
  );

  it('rejects unhashed or source-build Python requirements', async () => {
    const value = await fixture({
      'pyproject.toml': '[tool.pytest.ini_options]\n',
      'requirements.txt': 'pytest>=8\n',
    }, 'python3 -m pytest', ['python3']);
    const result = await inspectCandidateBootstrapPreflight({
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      gatePlan: value.gatePlan,
      pathEnvironment: value.bin,
    });

    expect(result.status).toBe('unsupported');
    expect(result.reasonCode).toBe(
      'candidate_bootstrap_native_build_unsupported',
    );
  });

  it('reports a missing frozen runtime without creating a worktree', async () => {
    const value = await fixture({
      'go.mod':
        'module example.test/fixture\n\ngo 1.23\n'
        + 'require example.test/dependency v1.0.0\n',
      'go.sum': 'example.test/dependency v1.0.0 h1:fixture\n',
    }, 'go test ./...', []);
    const result = await inspectCandidateBootstrapPreflight({
      sourceSnapshotCwd: value.repository,
      sourceSnapshot: value.snapshot,
      gatePlan: value.gatePlan,
      pathEnvironment: '',
    });

    expect(result.status).toBe('unsupported');
    expect(result.reasonCode).toBe(
      'candidate_bootstrap_runtime_unavailable',
    );
  });

  it('rejects Cargo git sources and Go replace directives', async () => {
    const rust = await fixture({
      'Cargo.toml':
        '[package]\nname = "fixture"\nversion = "0.1.0"\n'
        + '[dependencies]\nexample = "1"\n',
      'Cargo.lock':
        'version = 4\n'
        + 'source = "git+https://example.test/repository"\n',
    }, 'cargo test', ['cargo']);
    const go = await fixture({
      'go.mod':
        'module example.test/fixture\n\ngo 1.23\n'
        + 'require example.test/dependency v1.0.0\n'
        + 'replace example.test/dependency => ../dependency\n',
      'go.sum': 'example.test/dependency v1.0.0 h1:fixture\n',
    }, 'go test ./...', ['go']);

    for (const value of [rust, go]) {
      const result = await inspectCandidateBootstrapPreflight({
        sourceSnapshotCwd: value.repository,
        sourceSnapshot: value.snapshot,
        gatePlan: value.gatePlan,
        pathEnvironment: value.bin,
      });
      expect(result.status).toBe('unsupported');
      expect(result.reasonCode).toBe(
        'candidate_bootstrap_lockfile_unsupported',
      );
    }
  }, 30_000);
});

async function fixture(
  files: Readonly<Record<string, string | undefined>>,
  command: string,
  runtimes: readonly string[],
): Promise<{
  readonly repository: string;
  readonly bin: string;
  readonly snapshot: SourceSnapshotV1;
  readonly gatePlan: GatePlan;
}> {
  const parent = await mkdtemp(
    join(tmpdir(), 'wukong-bootstrap-preflight-'),
  );
  roots.push(parent);
  const repository = join(parent, 'repository');
  const bin = join(parent, 'bin');
  await Promise.all([
    mkdir(repository),
    mkdir(bin),
  ]);
  await git(repository, ['init']);
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    const absolutePath = join(repository, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  for (const runtime of runtimes) {
    const path = join(bin, runtime);
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
  }
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c', 'user.name=Wukong Test',
    '-c', 'user.email=test@example.test',
    'commit', '-m', 'fixture',
  ]);
  const built = await buildFinishLine({
    cwd: repository,
    objective: 'Verify the isolated fixture',
    completionCriterion: 'The frozen project check passes',
    explicitChecks: [command],
    includeDiscoveredChecks: false,
  });
  if (!built.ok) throw new Error(built.failure.message);
  const inspected = await inspectSourceSnapshot({ cwd: repository });
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null) {
    throw new Error('Unable to freeze the test source snapshot.');
  }
  return {
    repository,
    bin: [bin, process.env['PATH'] ?? ''].join(delimiter),
    snapshot: inspected.proposedSnapshot,
    gatePlan: built.proposal.gatePlan,
  };
}

async function git(
  root: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync('git', [...args], { cwd: root });
}
