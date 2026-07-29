import {
  mkdir,
  mkdtemp,
  link,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalDigest,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
} from '@wukong/verification';
import type { ModelCapability } from '@wukong/kosong';
import { LocalKaos } from '@wukong/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindCandidateWorkspaceGuard,
  CandidateWorkspacePathPolicyV1,
  withWorkspacePathGuard,
  WorkspacePathGuardError,
  type WorkspaceConfig,
} from '../../src/tools/support/workspace';
import { EditTool } from '../../src/tools/builtin/file/edit';
import { GlobTool } from '../../src/tools/builtin/file/glob';
import { GrepTool } from '../../src/tools/builtin/file/grep';
import { ReadMediaFileTool } from '../../src/tools/builtin/file/read-media';
import { ReadTool } from '../../src/tools/builtin/file/read';
import { WriteTool } from '../../src/tools/builtin/file/write';
import type { CandidateWorkspaceFileEntry } from '../../src/tools/support/candidate-workspace-file-backend';
import { executeTool } from './fixtures/execute-tool';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  pathPolicy?: CandidateWorkspacePathPolicyV1,
): Promise<{
  readonly parent: string;
  readonly root: string;
  readonly workspace: WorkspaceConfig;
}> {
  const parent = await mkdtemp(join(tmpdir(), 'wukong-candidate-guard-'));
  roots.push(parent);
  const root = join(parent, 'candidate');
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, 'source.txt'), 'source\n');
  const workspace = Object.freeze({
    workspaceDir: root,
    additionalDirs: Object.freeze([]),
    accessMode: 'workspace-only' as const,
  });
  bindCandidateWorkspaceGuard(workspace, {
    rootDirectory: root,
    expectedRootIdentity: await candidateIdentity(root),
    pathPolicy,
  });
  return { parent, root, workspace };
}

async function candidateIdentity(root: string): Promise<string> {
  const [actualPath, info] = await Promise.all([
    realpath(root),
    stat(root, { bigint: true }),
  ]);
  return canonicalDigest('wukong/candidate-path-identity/v1', {
    pathDigest: canonicalDigest('wukong/private-path/v1', actualPath),
    device: info.dev.toString(),
    inode: info.ino.toString(),
  });
}

describe('candidate workspace path guard', () => {
  it('binds all Candidate Writer file tools to dynamic generated scopes before dispatch', async () => {
    const plan = candidateBootstrapPlan(['generated/cache']);
    const pathPolicy = CandidateWorkspacePathPolicyV1.create(plan);
    const value = await fixture(pathPolicy);
    const generated = join(value.root, 'generated', 'cache');
    await mkdir(generated, { recursive: true });
    const dependency = join(generated, 'dependency.txt');
    const image = join(generated, 'dependency.png');
    await writeFile(dependency, 'dependency-secret\n');
    await writeFile(
      image,
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    );
    const kaos = (await LocalKaos.create()).withCwd(value.root);
    const signal = new AbortController().signal;
    const capabilities: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128_000,
    };
    const attempts = [
      executeTool(new ReadTool(kaos, value.workspace), {
        turnId: 'turn',
        toolCallId: 'read-generated',
        args: { path: dependency },
        signal,
      }),
      executeTool(new WriteTool(kaos, value.workspace), {
        turnId: 'turn',
        toolCallId: 'write-generated',
        args: { path: dependency, content: 'polluted\n' },
        signal,
      }),
      executeTool(new EditTool(kaos, value.workspace), {
        turnId: 'turn',
        toolCallId: 'edit-generated',
        args: {
          path: dependency,
          old_string: 'dependency-secret',
          new_string: 'polluted',
        },
        signal,
      }),
      executeTool(
        new ReadMediaFileTool(
          kaos,
          value.workspace,
          capabilities,
        ),
        {
          turnId: 'turn',
          toolCallId: 'media-generated',
          args: { path: image },
          signal,
        },
      ),
      executeTool(new GlobTool(kaos, value.workspace), {
        turnId: 'turn',
        toolCallId: 'glob-generated',
        args: { path: generated, pattern: '**/*' },
        signal,
      }),
      executeTool(new GrepTool(kaos, value.workspace), {
        turnId: 'turn',
        toolCallId: 'grep-generated',
        args: {
          path: generated,
          pattern: 'dependency-secret',
          output_mode: 'content',
        },
        signal,
      }),
    ];

    const results = await Promise.all(attempts);
    expect(results.every((result) => result.isError === true)).toBe(true);
    expect(results.every((result) =>
      typeof result.output === 'string'
      && result.output.includes('bootstrap-owned generated paths')))
      .toBe(true);
    expect(await readFile(dependency, 'utf8')).toBe('dependency-secret\n');

    const rootGlob = await executeTool(
      new GlobTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'glob-root',
        args: { path: value.root, pattern: '**/*', include_ignored: true },
        signal,
      },
    );
    const rootGrep = await executeTool(
      new GrepTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'grep-root',
        args: {
          path: value.root,
          pattern: 'dependency-secret',
          output_mode: 'content',
        },
        signal,
      },
    );
    expect(rootGlob.isError).not.toBe(true);
    expect(rootGlob.output).not.toContain('generated/cache');
    expect(rootGrep.isError).not.toBe(true);
    expect(rootGrep.output).not.toContain('dependency-secret');

    const sourceWrite = await executeTool(
      new WriteTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'write-source',
        args: { path: join(value.root, 'source.txt'), content: 'updated\n' },
        signal,
      },
    );
    expect(sourceWrite.isError).not.toBe(true);
    expect(await readFile(join(value.root, 'source.txt'), 'utf8'))
      .toBe('updated\n');
    expect(JSON.stringify(pathPolicy)).not.toContain('generated/cache');
    expect(JSON.stringify(pathPolicy)).not.toContain(
      plan.bootstrapPlanDigest,
    );
  });

  it('keeps fixed internal dependency paths denied without a bootstrap plan', async () => {
    const value = await fixture();
    const callback = vi.fn(async () => undefined);
    const denied = [
      'node_modules',
      '.venv',
      'target',
      'vendor',
      '.wukong-bootstrap',
    ];
    for (const [index, directory] of denied.entries()) {
      const root = join(value.root, 'nested', directory);
      await mkdir(root, { recursive: true });
      const path = join(root, 'dependency.txt');
      await writeFile(path, 'dependency\n');
      await expect(withWorkspacePathGuard(
        value.workspace,
        path,
        index % 3 === 0
          ? 'read'
          : index % 3 === 1
            ? 'write'
            : 'search',
        callback,
      )).rejects.toMatchObject({
        code: index % 3 === 2
          ? 'candidate_atomic_search_scope_denied'
          : 'candidate_atomic_generated_scope_denied',
      });
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it('guards a normal read before and after the callback', async () => {
    const value = await fixture();
    const callback = vi.fn(async () => 'ok');

    await expect(withWorkspacePathGuard(
      value.workspace,
      join(value.root, 'source.txt'),
      'read',
      callback,
    )).resolves.toBe('ok');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('revalidates live authority before and after every callback', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wukong-candidate-authority-'));
    roots.push(parent);
    const root = join(parent, 'candidate');
    await mkdir(root, { mode: 0o700 });
    const source = join(root, 'source.txt');
    await writeFile(source, 'source\n');
    const validateAuthority = vi.fn(async () => undefined);
    const workspace = Object.freeze({
      workspaceDir: root,
      additionalDirs: Object.freeze([]),
      accessMode: 'workspace-only' as const,
    });
    bindCandidateWorkspaceGuard(workspace, {
      rootDirectory: root,
      expectedRootIdentity: await candidateIdentity(root),
      validateAuthority,
    });

    await withWorkspacePathGuard(
      workspace,
      source,
      'read',
      async () => undefined,
    );

    expect(validateAuthority).toHaveBeenCalledTimes(2);
  });

  it('fails closed without an authentic candidate capability', async () => {
    const value = await fixture();
    const unbound: WorkspaceConfig = {
      workspaceDir: value.root,
      additionalDirs: [],
      accessMode: 'workspace-only',
    };

    await expect(withWorkspacePathGuard(
      unbound,
      join(value.root, 'source.txt'),
      'read',
      async () => undefined,
    )).rejects.toBeInstanceOf(WorkspacePathGuardError);
  });

  it('rejects outside, Git control, symlink and hardlink paths', async () => {
    const value = await fixture();
    const outside = join(value.parent, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await symlink(outside, join(value.root, 'linked.txt'));
    await link(
      join(value.root, 'source.txt'),
      join(value.root, 'hardlinked.txt'),
    );
    const callback = vi.fn(async () => undefined);

    for (const path of [
      outside,
      join(value.root, '.git', 'config'),
      join(value.root, 'linked.txt'),
      join(value.root, 'hardlinked.txt'),
    ]) {
      await expect(withWorkspacePathGuard(
        value.workspace,
        path,
        'read',
        callback,
      )).rejects.toBeInstanceOf(WorkspacePathGuardError);
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it('allows creating missing parents but revalidates every created node', async () => {
    const value = await fixture();
    const target = join(value.root, 'new', 'nested', 'file.txt');

    await expect(withWorkspacePathGuard(
      value.workspace,
      target,
      'write',
      async () => {
        await mkdir(join(value.root, 'new', 'nested'), {
          recursive: true,
        });
        await writeFile(target, 'created\n');
      },
    )).resolves.toBeUndefined();
  });

  it('detects root replacement during a tool callback', async () => {
    const value = await fixture();
    const original = join(value.parent, 'candidate-original');

    await expect(withWorkspacePathGuard(
      value.workspace,
      join(value.root, 'source.txt'),
      'read',
      async () => {
        await rename(value.root, original);
        await mkdir(value.root, { mode: 0o700 });
        await writeFile(join(value.root, 'source.txt'), 'replacement\n');
      },
    )).rejects.toThrow(/root identity changed/u);
  });

  it('routes Candidate Read, Write and Edit through descriptor-rooted I/O', async () => {
    const value = await fixture();
    const kaos = (await LocalKaos.create()).withCwd(value.root);
    const signal = new AbortController().signal;

    const written = await executeTool(
      new WriteTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'write',
        args: {
          path: 'nested/output.txt',
          content: 'alpha beta\n',
        },
        signal,
      },
    );
    expect(written.isError).not.toBe(true);
    expect(await readFile(join(value.root, 'nested', 'output.txt'), 'utf8'))
      .toBe('alpha beta\n');

    const edited = await executeTool(
      new EditTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'edit',
        args: {
          path: 'nested/output.txt',
          old_string: 'beta',
          new_string: 'gamma',
        },
        signal,
      },
    );
    expect(edited.isError).not.toBe(true);
    expect(await readFile(join(value.root, 'nested', 'output.txt'), 'utf8'))
      .toBe('alpha gamma\n');

    const read = await executeTool(
      new ReadTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'read',
        args: { path: 'nested/output.txt' },
        signal,
      },
    );
    expect(read.isError).not.toBe(true);
    expect(read.output).toContain('alpha gamma');
  });

  it('does not follow a parent swapped to an outside symlink after checking', async () => {
    const value = await fixture();
    const safe = join(value.root, 'safe');
    const displaced = join(value.root, 'safe-displaced');
    const outsideDirectory = join(value.parent, 'outside');
    const outside = join(outsideDirectory, 'target.txt');
    await mkdir(safe);
    await writeFile(join(safe, 'target.txt'), 'candidate\n');
    await mkdir(outsideDirectory);
    await writeFile(outside, 'outside\n');

    await expect(withWorkspacePathGuard(
      value.workspace,
      join(safe, 'target.txt'),
      'write',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await rename(safe, displaced);
        await symlink(outsideDirectory, safe);
        await io.writeText(join(safe, 'target.txt'), 'replacement\n');
      },
    )).rejects.toThrow();

    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it('atomically replaces a raced leaf symlink without writing its target', async () => {
    const value = await fixture();
    const target = join(value.root, 'source.txt');
    const outside = join(value.parent, 'outside.txt');
    await writeFile(outside, 'outside\n');

    await expect(withWorkspacePathGuard(
      value.workspace,
      target,
      'write',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await rm(target);
        await symlink(outside, target);
        await io.writeText(target, 'replacement\n');
      },
    )).rejects.toThrow();

    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it('walks candidate trees through descriptors and hides control paths', async () => {
    const value = await fixture();
    await mkdir(join(value.root, 'src'));
    await writeFile(join(value.root, 'src', 'alpha.ts'), 'needle\n');
    await mkdir(join(value.root, '.git'));
    await writeFile(join(value.root, '.git', 'config'), 'needle\n');
    await mkdir(join(value.root, '.wukong'));
    await writeFile(join(value.root, '.wukong', 'private'), 'needle\n');
    await mkdir(join(value.root, 'vendor'));
    await writeFile(join(value.root, 'vendor', 'dependency.ts'), 'needle\n');
    await mkdir(join(value.root, '.wukong-bootstrap'));
    await writeFile(
      join(value.root, '.wukong-bootstrap', 'cache.ts'),
      'needle\n',
    );
    const callback = vi.fn(async (io) => {
      if (io === undefined) throw new TypeError('missing atomic I/O');
      return io.listFiles(value.root, { includeIgnored: true });
    });

    const entries: readonly CandidateWorkspaceFileEntry[] =
      await withWorkspacePathGuard(
        value.workspace,
        value.root,
        'search',
        callback,
      );

    expect(entries.map((entry) => entry.relativePath))
      .toContain('src/alpha.ts');
    expect(entries.every((entry) =>
      !entry.relativePath.startsWith('.git/')
      && !entry.relativePath.startsWith('.wukong/')
      && !entry.relativePath.startsWith('vendor/')
      && !entry.relativePath.startsWith('.wukong-bootstrap/')))
      .toBe(true);
    expect(callback).toHaveBeenCalledOnce();

    await expect(withWorkspacePathGuard(
      value.workspace,
      join(value.root, 'vendor'),
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await io.listFiles(join(value.root, 'vendor'), {
          includeIgnored: true,
        });
      },
    )).rejects.toMatchObject({
      code: 'candidate_atomic_search_scope_denied',
    });
  });

  it('runs operational Candidate Glob and Grep without spawning rg', async () => {
    const value = await fixture();
    await mkdir(join(value.root, 'src'));
    await writeFile(
      join(value.root, 'src', 'alpha.ts'),
      'const marker = "descriptor-needle";\n',
    );
    await writeFile(join(value.root, 'src', 'skip.js'), 'descriptor-needle\n');
    const kaos = (await LocalKaos.create()).withCwd(value.root);
    const signal = new AbortController().signal;

    const glob = await executeTool(
      new GlobTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'glob',
        args: { pattern: 'src/**/*.ts' },
        signal,
      },
    );
    expect(glob.isError).not.toBe(true);
    expect(glob.output).toContain('src/alpha.ts');
    expect(glob.output).not.toContain('skip.js');

    const grep = await executeTool(
      new GrepTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'grep',
        args: {
          pattern: 'descriptor-needle',
          path: 'src',
          glob: '**/*.ts',
          output_mode: 'content',
          '-n': true,
        },
        signal,
      },
    );
    expect(grep.isError).not.toBe(true);
    expect(grep.output).toContain('src/alpha.ts:1:');
    expect(grep.output).not.toContain('skip.js');
  });

  it('rejects unsafe Candidate Grep patterns before reading the tree', async () => {
    const value = await fixture();
    const kaos = (await LocalKaos.create()).withCwd(value.root);

    const grep = await executeTool(
      new GrepTool(kaos, value.workspace),
      {
        turnId: 'turn',
        toolCallId: 'grep-redos',
        args: {
          pattern: '(a+)+$',
          path: '.',
          output_mode: 'content',
        },
        signal: new AbortController().signal,
      },
    );

    expect(grep.isError).toBe(true);
    expect(grep.output).toContain('catastrophic backtracking');
  });

  it('fails closed when a listed parent is swapped before Grep reads it', async () => {
    const value = await fixture();
    const safe = join(value.root, 'safe');
    const displaced = join(value.root, 'safe-displaced');
    const outsideDirectory = join(value.parent, 'outside-search');
    const outside = join(outsideDirectory, 'target.txt');
    await mkdir(safe);
    await writeFile(join(safe, 'target.txt'), 'candidate\n');
    await mkdir(outsideDirectory);
    await writeFile(outside, 'outside-secret\n');

    await expect(withWorkspacePathGuard(
      value.workspace,
      safe,
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        const entries = await io.listFiles(safe);
        await rename(safe, displaced);
        await symlink(outsideDirectory, safe);
        await io.readText(entries[0]!.path);
      },
    )).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('outside-secret\n');
  });

  it('fails closed when a listed file changes in place before Grep reads it', async () => {
    const value = await fixture();

    await expect(withWorkspacePathGuard(
      value.workspace,
      value.root,
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        const entries = await io.listFiles(value.root);
        const source = entries.find((entry) =>
          entry.relativePath === 'source.txt');
        if (source === undefined) throw new Error('source entry missing');
        await writeFile(source.path, 'changed after enumeration\n');
        await io.readText(source.path);
      },
    )).rejects.toMatchObject({
      code: 'candidate_atomic_file_changed',
    });
  });

  it('rejects symlinks, hardlinks and non-portable nodes during tree walking', async () => {
    const value = await fixture();
    const outside = join(value.parent, 'outside-tree.txt');
    await writeFile(outside, 'outside\n');
    const linked = join(value.root, 'linked.txt');
    await symlink(outside, linked);

    await expect(withWorkspacePathGuard(
      value.workspace,
      value.root,
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await io.listFiles(value.root);
      },
    )).rejects.toThrow();

    await rm(linked);
    await link(join(value.root, 'source.txt'), join(value.root, 'hard.txt'));
    await expect(withWorkspacePathGuard(
      value.workspace,
      value.root,
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await io.listFiles(value.root);
      },
    )).rejects.toThrow(/hardlinked/u);

    await rm(join(value.root, 'hard.txt'));
    await writeFile(join(value.root, 'CON'), 'reserved\n');
    await expect(withWorkspacePathGuard(
      value.workspace,
      value.root,
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await io.listFiles(value.root);
      },
    )).rejects.toThrow(/non-portable/u);
  });

  it('rejects case-folded portable collisions when the filesystem permits them', async () => {
    const value = await fixture();
    const upper = join(value.root, 'Alpha.ts');
    const lower = join(value.root, 'alpha.ts');
    await writeFile(upper, 'upper\n');
    await writeFile(lower, 'lower\n');
    const [upperInfo, lowerInfo] = await Promise.all([
      stat(upper, { bigint: true }),
      stat(lower, { bigint: true }),
    ]);
    if (upperInfo.ino === lowerInfo.ino
      && upperInfo.dev === lowerInfo.dev) {
      expect(process.platform).toBe('darwin');
      return;
    }

    await expect(withWorkspacePathGuard(
      value.workspace,
      value.root,
      'search',
      async (io) => {
        if (io === undefined) throw new TypeError('missing atomic I/O');
        await io.listFiles(value.root);
      },
    )).rejects.toMatchObject({
      code: 'candidate_atomic_portable_collision',
    });
  });
});

function candidateBootstrapPlan(
  generatedPathScopes: readonly string[],
) {
  const step = createCandidateBootstrapStep({
    stepId: 'install_dependencies',
    recipeRef: 'builtin:test-install',
    recipeVersion: '1.0.0',
    executableIdentity: testDigest('executable'),
    runtimeVersionDigest: testDigest('runtime'),
    exactArgvPrivateRef: 'private/bootstrap/argv/install',
    argvDigest: testDigest('argv'),
    effectiveEnvironmentPrivateRef: 'private/bootstrap/env/install',
    effectiveEnvironmentDigest: testDigest('environment'),
    candidateRelativeCwd: '.',
    generatedPathScopes,
    timeoutMs: 5_000,
  });
  return createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8cf0-0000-7abc-8def-0123456789ab',
    sourceSnapshotDigest: testDigest('snapshot'),
    gatePlanDigest: testDigest('gate'),
    ecosystemRefs: ['test:dependency'],
    lockfileDigests: [],
    steps: [step],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: testDigest('permission'),
    bootstrapBudgetDigest: testDigest('budget'),
  });
}

function testDigest(value: string): string {
  return canonicalDigest('wukong/test/v1', value);
}
