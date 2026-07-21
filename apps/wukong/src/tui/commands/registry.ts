import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'pathe';

import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args';
import { isExperimentalFlagEnabled } from './experimental-flags';
import type { WukongSlashCommand, SlashCommandAvailability } from './types';

/** Subcommands offered when autocompleting `/goal <…>`. */
const GOAL_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'status', description: 'Show the current goal' },
  { value: 'pause', description: 'Pause the active goal' },
  { value: 'resume', description: 'Resume a paused goal' },
  { value: 'cancel', description: 'Cancel and remove the current goal' },
  { value: 'replace', description: 'Replace the current goal with a new objective' },
  { value: 'next', description: 'Queue an upcoming goal' },
];

const GOAL_NEXT_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'manage', description: 'Manage upcoming goals' },
];

const SWARM_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'on', description: 'Turn swarm mode on' },
  { value: 'off', description: 'Turn swarm mode off' },
];

const LOOP_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'status', description: 'Show the active Loop' },
  { value: 'pause', description: 'Pause the active Loop' },
  { value: 'resume', description: 'Resume a paused Loop' },
  { value: 'stop', description: 'Stop and remove the active Loop' },
  { value: '--help', description: 'Show Loop usage' },
];

const PLAN_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'on', description: 'Turn plan mode on' },
  { value: 'off', description: 'Turn plan mode off' },
  { value: 'clear', description: 'Clear the current plan' },
];

const PERMISSION_TOGGLE_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'on', description: 'Turn this permission mode on' },
  { value: 'off', description: 'Turn this permission mode off' },
];

const PLUGINS_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'list', description: 'List installed plugins' },
  { value: 'marketplace', description: 'Browse a plugin marketplace' },
  { value: 'install', description: 'Install a plugin from a path or ZIP URL' },
  { value: 'info', description: 'Show plugin details' },
  { value: 'enable', description: 'Enable an installed plugin' },
  { value: 'disable', description: 'Disable an installed plugin' },
  { value: 'remove', description: 'Remove an installed plugin' },
  { value: 'mcp', description: 'Enable or disable a plugin MCP server' },
  { value: 'reload', description: 'Reload installed plugins' },
];

const TRANSFORM_BUILTIN_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'general', description: 'General-purpose role profile' },
  { value: 'reviewer', description: 'Code review role profile' },
  { value: 'planner', description: 'Planning role profile' },
  { value: 'strategist', description: 'Strategy role profile' },
  { value: 'security', description: 'Security review role profile' },
  { value: 'tester', description: 'Testing role profile' },
  { value: 'off', description: 'Disable the active transform' },
  { value: 'list', description: 'List built-in and custom roles' },
  { value: 'status', description: 'Show the active transform' },
];

const ADD_DIR_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'list', description: 'Show configured additional workspace directories' },
];

const REVIEW_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'init', description: 'Create .wukong/review-policy.md' },
  { value: 'feedback', description: 'Record local feedback for a finding' },
  { value: 'stats', description: 'Show local review counts' },
];

const RESUME_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'codex', description: 'Show local Codex sessions' },
  { value: 'claude', description: 'Show local Claude Code sessions' },
  { value: 'cursor', description: 'Show local Cursor sessions' },
];

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const nextMatch = argumentPrefix.match(/^next\s+(\S*)$/i);
  if (nextMatch !== null) {
    return (
      completeLeadingArg(GOAL_NEXT_ARG_COMPLETIONS, nextMatch[1] ?? '')?.map((item) => ({
        ...item,
        value: `next ${item.value}`,
      })) ?? null
    );
  }
  return completeLeadingArg(GOAL_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/swarm` command (subcommands). */
export function swarmArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(SWARM_ARG_COMPLETIONS, argumentPrefix);
}

export function loopArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(LOOP_ARG_COMPLETIONS, argumentPrefix);
}

export function planArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(PLAN_ARG_COMPLETIONS, argumentPrefix);
}

export function permissionToggleArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(PERMISSION_TOGGLE_ARG_COMPLETIONS, argumentPrefix);
}

export function pluginsArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(PLUGINS_ARG_COMPLETIONS, argumentPrefix);
}

export function transformArgumentCompletions(
  argumentPrefix: string,
  roles: readonly { readonly selection: string; readonly description: string }[] = [],
): AutocompleteItem[] | null {
  const specs = new Map(
    TRANSFORM_BUILTIN_ARG_COMPLETIONS.map((item) => [item.value, item] as const),
  );
  for (const role of roles) {
    specs.set(role.selection, { value: role.selection, description: role.description });
  }
  return completeLeadingArg([...specs.values()], argumentPrefix);
}

/** Argument autocompletion for the `/add-dir` command. */
export function addDirArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  if (isPathLikeAddDirArgument(argumentPrefix)) {
    return completeAddDirPath(argumentPrefix);
  }
  return completeLeadingArg(ADD_DIR_ARG_COMPLETIONS, argumentPrefix);
}

export function reviewArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(REVIEW_ARG_COMPLETIONS, argumentPrefix);
}

export function resumeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(RESUME_ARG_COMPLETIONS, argumentPrefix);
}

function isPathLikeAddDirArgument(argumentPrefix: string): boolean {
  return argumentPrefix === '.' || argumentPrefix === '..' || argumentPrefix.startsWith('./') || argumentPrefix.startsWith('../') || argumentPrefix.startsWith('/') || argumentPrefix.startsWith('~');
}

function completeAddDirPath(argumentPrefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix === '~' ? '~/' : argumentPrefix;
  const expandedPrefix = expandHomePrefix(normalizedPrefix);
  const parentInput = getDirectoryCompletionParentInput(normalizedPrefix, expandedPrefix);
  const partialName = normalizedPrefix.endsWith('/') ? '' : basename(expandedPrefix);
  const parentDir = resolveDirectoryCompletionParent(parentInput);
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const items: AutocompleteItem[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue;
    if (partialName.length > 0 && !entry.name.toLowerCase().startsWith(partialName.toLowerCase())) continue;
    const absolutePath = join(parentDir, entry.name);
    if (!isDirectoryPath(absolutePath, entry.isDirectory(), entry.isSymbolicLink())) continue;
    const value = formatDirectoryCompletionValue(normalizedPrefix, parentInput, entry.name);
    items.push({
      value,
      label: `${entry.name}/`,
      description: absolutePath,
    });
  }

  return items.length > 0 ? items : null;
}

function expandHomePrefix(argumentPrefix: string): string {
  if (argumentPrefix === '~') return homedir();
  if (argumentPrefix.startsWith('~/')) return join(homedir(), argumentPrefix.slice(2));
  return argumentPrefix;
}

function getDirectoryCompletionParentInput(argumentPrefix: string, expandedPrefix: string): string {
  if (argumentPrefix === '/') return '/';
  if (argumentPrefix === '~/') return homedir();
  if (argumentPrefix.endsWith('/')) return expandedPrefix.slice(0, -1);
  return dirname(expandedPrefix);
}

function resolveDirectoryCompletionParent(parentInput: string): string {
  if (parentInput === '~') return homedir();
  if (parentInput.startsWith('~/')) return join(homedir(), parentInput.slice(2));
  return resolve(parentInput);
}

function isDirectoryPath(path: string, isDirectory: boolean, isSymlink: boolean): boolean {
  if (isDirectory) return true;
  if (!isSymlink) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function formatDirectoryCompletionValue(argumentPrefix: string, parentInput: string, entryName: string): string {
  if (argumentPrefix.startsWith('~/')) {
    const home = homedir();
    const homeRelative = relative(home, parentInput);
    return `~${homeRelative.length > 0 ? `/${homeRelative}` : ''}/${entryName}/`;
  }
  if (argumentPrefix.startsWith('/')) {
    return `${join(parentInput, entryName)}/`;
  }
  return `${join(parentInput, entryName)}/`;
}

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'verify',
    aliases: [],
    description: 'Advanced: inspect the project checks used by Loop',
    hidden: true,
    priority: 70,
    availability: 'idle-only',
  },
  {
    name: 'scan',
    aliases: [],
    description: 'Advanced: inspect the risk rules used by Loop',
    hidden: true,
    priority: 70,
    availability: 'idle-only',
  },
  {
    name: 'proof',
    aliases: [],
    description: 'Advanced: inspect the Loop delivery gate',
    hidden: true,
    priority: 70,
    availability: 'idle-only',
  },
  {
    name: 'judge',
    aliases: [],
    description: 'Evaluate whether the workspace is safe to merge (deterministic)',
    priority: 70,
    availability: 'idle-only',
  },
  {
    name: 'loop',
    aliases: [],
    description: 'Start a local iteration loop with a verification gate',
    priority: 70,
    argumentHint: '[status|pause|resume|stop] | [options] -- <objective>',
    completeArgs: loopArgumentCompletions,
    availability: (args) => {
      const control = args.trim().toLowerCase();
      return control === 'status' || control === 'pause' || control === 'stop'
        ? 'always'
        : 'idle-only';
    },
  },
  {
    name: 'guard',
    aliases: [],
    description: 'Show Wukong guard status',
    priority: 70,
    argumentHint: '[status]',
    availability: 'always',
  },
  {
    name: 'yolo',
    aliases: [],
    description: 'Toggle auto-approve mode',
    priority: 100,
    argumentHint: '[on|off]',
    completeArgs: permissionToggleArgumentCompletions,
    availability: 'always',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Toggle auto permission mode',
    priority: 100,
    argumentHint: '[on|off]',
    completeArgs: permissionToggleArgumentCompletions,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: 'Select permission mode',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: ['config'],
    description: 'Open TUI settings',
    priority: 100,
    availability: 'idle-only',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Toggle plan mode',
    priority: 100,
    argumentHint: '[on|off|clear]',
    completeArgs: planArgumentCompletions,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'swarm',
    aliases: [],
    description: 'Toggle swarm mode or run one task in swarm mode',
    priority: 100,
    argumentHint: '[on|off] | <task>',
    completeArgs: swarmArgumentCompletions,
    availability: 'idle-only',
  },
  {
    name: 'model',
    aliases: [],
    description: 'Switch LLM model',
    priority: 100,
    argumentHint: '[alias]',
    availability: 'always',
  },
  {
    name: 'transform',
    aliases: [],
    description: 'Transform the agent with a role profile',
    priority: 80,
    argumentHint: '<role|off|list>',
    availability: 'idle-only',
    experimentalFlag: 'role_profiles',
    visibleWhenDisabled: true,
    completeArgs: transformArgumentCompletions,
  },
  {
    name: 'provider',
    aliases: ['providers'],
    description: 'Manage AI providers (add / delete / refresh)',
    priority: 95,
    availability: 'always',
  },
  {
    name: 'btw',
    aliases: [],
    description: 'Ask a forked side agent a question',
    priority: 90,
    argumentHint: '<question>',
    availability: 'always',
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and shortcuts',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'Start a fresh session in the current workspace',
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'Resume Wukong, Codex, Claude Code, or Cursor sessions',
    priority: 80,
    argumentHint: '[codex|claude|cursor]',
    completeArgs: resumeArgumentCompletions,
  },
  {
    name: 'resume-codex',
    aliases: [],
    description: 'Resume a local Codex session in Wukong',
    hidden: true,
    priority: 80,
  },
  {
    name: 'resume-claude',
    aliases: [],
    description: 'Resume a local Claude Code session in Wukong',
    hidden: true,
    priority: 80,
  },
  {
    name: 'resume-cursor',
    aliases: [],
    description: 'Resume a local Cursor session in Wukong',
    hidden: true,
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'Browse background tasks',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'Show MCP server status',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'plugins',
    aliases: [],
    description: 'Manage plugins',
    priority: 60,
    argumentHint: '[list|marketplace|install|info|enable|disable|remove|mcp|reload]',
    completeArgs: pluginsArgumentCompletions,
    availability: 'always',
  },
  {
    name: 'add-dir',
    aliases: [],
    description: 'Add or list an additional workspace directory',
    priority: 60,
    availability: 'idle-only',
    argumentHint: '[list] | <path>',
    completeArgs: addDirArgumentCompletions,
  },
  {
    name: 'experiments',
    aliases: ['experimental'],
    description: 'Manage experimental features',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload',
    aliases: [],
    description: 'Reload session and apply config.toml settings plus tui.toml UI preferences',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload-tui',
    aliases: [],
    description: 'Reload only tui.toml UI preferences',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    description: 'Compact the conversation context',
    priority: 80,
    argumentHint: '<instruction>',
  },
  {
    name: 'goal',
    aliases: [],
    description: 'Start or manage an autonomous goal',
    priority: 80,
    argumentHint: '[status|pause|resume|cancel|replace|next] | <objective>',
    completeArgs: goalArgumentCompletions,
    // status / pause / cancel are always available; creation, replacement, and
    // resume start (or restart) a turn and so are idle-only.
    availability: (args) => {
      const trimmed = args.trim();
      if (trimmed === 'next' || trimmed.startsWith('next ')) return 'always';
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'cancel'
        ? 'always'
        : 'idle-only';
    },
  },
  {
    name: 'init',
    aliases: [],
    description: 'Analyze the codebase and generate AGENTS.md',
  },
  {
    name: 'fork',
    aliases: [],
    description: 'Fork the current session',
    priority: 80,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'Set or show session title',
    priority: 60,
    argumentHint: '<title>',
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'Show session tokens + context window + plan quotas',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: 'Show current session and runtime status',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'feedback',
    aliases: [],
    description: 'Send feedback to make Wukong better',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'review',
    aliases: [],
    description: 'Manage project review policy and local finding feedback',
    priority: 70,
    argumentHint: 'init | feedback <finding-id> <action> | stats',
    completeArgs: reviewArgumentCompletions,
    availability: 'always',
  },
  {
    name: 'undo',
    aliases: [],
    description: 'Withdraw the last prompt from the transcript',
    priority: 80,
    argumentHint: '[count]',
    availability: 'idle-only',
  },
  {
    name: 'editor',
    aliases: [],
    description: 'Set the external editor for Ctrl-G',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: 'Set the terminal UI theme',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'Log out of a configured provider',
    priority: 40,
  },
  {
    name: 'login',
    aliases: [],
    description: 'Select a platform and authenticate',
    priority: 40,
  },
  {
    name: 'export-md',
    aliases: [],
    description: 'Export current session as a Markdown file',
    priority: 40,
  },
  {
    name: 'export-debug-zip',
    aliases: ['export'],
    description: 'Export current session as a debug ZIP archive',
    priority: 40,
  },
  {
    name: 'web',
    aliases: [],
    description: 'Open the current session in the Web UI and exit the terminal',
    priority: 40,
    availability: 'always',
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the application',
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    description: 'Show version information',
    priority: 20,
    availability: 'always',
  },
] as const satisfies readonly WukongSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly WukongSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: WukongSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function isSlashCommandVisible(command: WukongSlashCommand): boolean {
  return command.hidden !== true &&
    (isExperimentalFlagEnabled(command.experimentalFlag) || command.visibleWhenDisabled === true);
}

export function sortSlashCommands(commands: readonly WukongSlashCommand[]): WukongSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}
