import type { CommandRisk } from './types';

export function classifyCommandRisk(command: readonly string[]): CommandRisk | undefined {
  if (command.length === 0) return undefined;
  const executable = basename(command[0] ?? '').toLowerCase();
  const args = command.slice(1).map((arg) => arg.toLowerCase());
  const joined = command.join(' ').toLowerCase();

  if (executable === 'rm' && args.some((arg) => /^-.*[rf]/.test(arg))) {
    return risk('guard.rm_recursive_or_force', 'rm with recursive or force flags can delete files permanently.', command);
  }

  if (executable === 'git' && args[0] === 'reset' && args.includes('--hard')) {
    return risk('guard.git_reset_hard', 'git reset --hard can discard local changes.', command);
  }

  if (executable === 'git' && args[0] === 'clean' && args.some((arg) => /^-.*f/.test(arg))) {
    return risk('guard.git_clean_force', 'git clean with force can remove untracked files.', command);
  }

  if ((executable === 'curl' || executable === 'wget') && /\|\s*(sh|bash|zsh)\b/.test(joined)) {
    return risk('guard.remote_script_pipe', 'Piping a remote download into a shell is high risk.', command);
  }

  if ((executable === 'curl' || executable === 'wget') && args.some((arg) => ['-d', '--data', '--data-raw', '-f', '--form'].includes(arg))) {
    return risk('guard.network_upload', 'Network command appears to upload data.', command);
  }

  if ((executable === 'sh' || executable === 'bash' || executable === 'zsh') && /\b(curl|wget)\b/.test(joined)) {
    return risk('guard.shell_remote_download', 'Shell command contains a remote download.', command);
  }

  return undefined;
}

function basename(value: string): string {
  // Handle both POSIX and Windows separators, and strip Windows executable
  // extensions so `C:\bin\rm.exe` classifies the same as `rm`.
  const parts = value.split(/[\\/]/);
  const name = parts.at(-1) ?? value;
  return name.replace(/\.(exe|cmd|bat)$/i, '');
}

function risk(id: string, message: string, command: readonly string[]): CommandRisk {
  return { id, severity: 'high', message, command };
}
