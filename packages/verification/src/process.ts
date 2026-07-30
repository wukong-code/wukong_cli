import { spawn } from 'node:child_process';

export interface CapturedProcess {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_CAPTURE_CHARS = 24_000;
const TRUNCATION_MARKER = '\n[output truncated; showing beginning and end]\n';

export function runFile(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<CapturedProcess> {
  return runSpawn(file, args, { cwd: options.cwd, shell: false, timeoutMs: options.timeoutMs, signal: options.signal });
}

export function runShellCommand(
  command: string,
  options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<CapturedProcess> {
  return runSpawn(command, [], { cwd: options.cwd, shell: true, timeoutMs: options.timeoutMs, signal: options.signal });
}

function runSpawn(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly shell: boolean; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<CapturedProcess> {
  if (options.signal?.aborted === true) {
    return Promise.reject(abortReason(options.signal));
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Give the child its own process group so a timeout can kill the whole
      // subtree (e.g. shell + spawned Node process) without killing the parent.
      detached: process.platform !== 'win32',
    });

    function killSubtree(signal: NodeJS.Signals) {
      try {
        if (process.platform === 'win32' || child.pid === undefined) {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Process may have already exited.
      }
    }

    function clearTimers() {
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    function onAbort() {
      if (settled) return;
      settled = true;
      clearTimers();
      killSubtree('SIGTERM');
      killTimer = setTimeout(() => {
        killSubtree('SIGKILL');
      }, 1500);
      reject(options.signal === undefined ? new DOMException('This operation was aborted', 'AbortError') : abortReason(options.signal));
    }

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          // SIGTERM the whole subtree first, then hard-kill if it refuses.
          killSubtree('SIGTERM');
          killTimer = setTimeout(() => {
            killSubtree('SIGKILL');
          }, 1500);
        }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      if (settled) {
        clearTimers();
        return;
      }
      settled = true;
      clearTimers();
      // eslint-disable-next-line eslint-plugin-promise/no-multiple-resolved -- guarded by settled flag above
      resolve({
        exitCode: 1,
        timedOut,
        stdout,
        stderr: appendLimited(stderr, error.message),
      });
    });
    child.on('close', (code) => {
      if (settled) {
        clearTimers();
        return;
      }
      settled = true;
      clearTimers();
      // eslint-disable-next-line eslint-plugin-promise/no-multiple-resolved -- guarded by settled flag above
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURE_CHARS) return combined;
  const headLength = Math.floor((MAX_CAPTURE_CHARS - TRUNCATION_MARKER.length) / 2);
  const tailLength = MAX_CAPTURE_CHARS - TRUNCATION_MARKER.length - headLength;
  return combined.slice(0, headLength) + TRUNCATION_MARKER + combined.slice(-tailLength);
}
