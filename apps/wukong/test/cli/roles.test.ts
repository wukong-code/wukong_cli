import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRolesCommand } from '#/cli/sub/roles';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wukong-roles-cli-'));
  tempDirs.push(dir);
  return dir;
}

function makeProgram() {
  const cwd = makeTempDir();
  const homeDir = makeTempDir();
  const output: string[] = [];
  const program = new Command('wukong');
  registerRolesCommand(program, {
    cwd: () => cwd,
    homeDir: () => homeDir,
    stdout: {
      write: (chunk) => {
        output.push(String(chunk));
        return true;
      },
    },
  });
  return { program, output };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('roles command', () => {
  it.each([
    { label: 'roles', argv: ['roles'] },
    { label: 'roles list', argv: ['roles', 'list'] },
  ])('lists roles for $label', async ({ argv }) => {
    const { program, output } = makeProgram();

    await program.parseAsync(['node', 'wukong', ...argv]);

    expect(output.join('')).toContain('general');
    expect(output.join('')).toContain('security');
  });

  it('reports an unknown subcommand instead of treating it as list arguments', async () => {
    const { program } = makeProgram();
    let errorOutput = '';
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: (chunk) => { errorOutput += chunk; },
    });

    await expect(
      program.parseAsync(['node', 'wukong', 'roles', 'nope']),
    ).rejects.toThrow();
    expect(errorOutput).toContain("unknown command 'nope'. See 'wukong roles --help'.");
  });
});
