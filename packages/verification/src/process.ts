import { spawn } from 'node:child_process';

export interface CapturedProcess {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_CAPTURE_CHARS = 24_000;

export function runFile(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs?: number },
): Promise<CapturedProcess> {
  return runSpawn(file, args, { cwd: options.cwd, shell: false, timeoutMs: options.timeoutMs });
}

export function runShellCommand(
  command: string,
  options: { readonly cwd: string; readonly timeoutMs?: number },
): Promise<CapturedProcess> {
  return runSpawn(command, [], { cwd: options.cwd, shell: true, timeoutMs: options.timeoutMs });
}

function runSpawn(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly shell: boolean; readonly timeoutMs?: number },
): Promise<CapturedProcess> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // eslint-disable-next-line eslint-plugin-promise/no-multiple-resolved -- guarded by settled flag above
      resolve({
        exitCode: 1,
        timedOut,
        stdout,
        stderr: appendLimited(stderr, error.message),
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // eslint-disable-next-line eslint-plugin-promise/no-multiple-resolved -- guarded by settled flag above
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURE_CHARS) return combined;
  return combined.slice(0, MAX_CAPTURE_CHARS) + '\n[output truncated]\n';
}
