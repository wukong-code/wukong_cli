import type { FlagId } from '@wukong/wukong-sdk';

import {
  BUILTIN_SLASH_COMMANDS,
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommand,
  type BuiltinSlashCommandName,
} from './registry';
import { isExperimentalFlagEnabled } from './experimental-flags';
import { parseSlashInput } from './parse';
import type {
  WukongSlashCommand,
  SlashCommandBusyReason,
  SlashCommandInvalidReason,
} from './types';

export type SlashCommandIntent =
  | { readonly kind: 'not-command' }
  | {
      readonly kind: 'builtin';
      readonly command: BuiltinSlashCommand;
      readonly name: BuiltinSlashCommandName;
      readonly args: string;
    }
  | {
      readonly kind: 'skill';
      readonly commandName: string;
      readonly skillName: string;
      readonly args: string;
    }
  | {
      readonly kind: 'disabled';
      readonly commandName: string;
      readonly experimentalFlag: FlagId;
    }
  | {
      readonly kind: 'blocked';
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    }
  | {
      readonly kind: 'invalid';
      readonly commandName: string;
      readonly reason: SlashCommandInvalidReason;
      readonly suggestions: readonly string[];
    };

export interface ResolveSlashCommandInput {
  readonly input: string;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
}

export function resolveSlashCommandInput(options: ResolveSlashCommandInput): SlashCommandIntent {
  const parsed = parseSlashInput(options.input);
  if (parsed === null) return { kind: 'not-command' };

  const command = findBuiltInSlashCommand(parsed.name);
  // `command` is a literal union where only some members carry `experimentalFlag`; widen to read it.
  const experimentalFlag = (command as WukongSlashCommand | undefined)?.experimentalFlag;
  if (
    command !== undefined &&
    experimentalFlag !== undefined &&
    !isExperimentalFlagEnabled(experimentalFlag)
  ) {
    return {
      kind: 'disabled',
      commandName: parsed.name,
      experimentalFlag,
    };
  }
  if (command !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (
      busyReason !== undefined &&
      resolveSlashCommandAvailability(command, parsed.args) === 'idle-only'
    ) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: 'builtin',
      command,
      name: command.name,
      args: parsed.args,
    };
  }

  const skillName = resolveSkillCommand(options.skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: 'skill',
      commandName: parsed.name,
      skillName,
      args: parsed.args.trim(),
    };
  }

  return {
    kind: 'invalid',
    commandName: parsed.name,
    reason: 'unknown',
    suggestions: suggestSlashCommands(parsed.name, options.skillCommandMap),
  };
}

export function suggestSlashCommands(
  commandName: string,
  skillCommandMap: ReadonlyMap<string, string>,
): readonly string[] {
  const query = commandName.toLowerCase();
  const candidates = new Set<string>();
  for (const command of BUILTIN_SLASH_COMMANDS) {
    candidates.add(command.name);
    for (const alias of command.aliases) candidates.add(alias);
  }
  for (const name of skillCommandMap.keys()) {
    candidates.add(name.startsWith('skill:') ? name.slice('skill:'.length) : name);
  }

  const maxDistance = Math.max(2, Math.ceil(query.length * 0.4));
  return [...candidates]
    .map((candidate) => ({
      candidate,
      distance: editDistance(query, candidate.toLowerCase()),
    }))
    .filter(({ candidate, distance }) =>
      distance <= maxDistance || candidate.startsWith(query) || query.startsWith(candidate),
    )
    .toSorted(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? right.length;
}

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export function slashCommandBusyReason(
  options: Pick<ResolveSlashCommandInput, 'isStreaming' | 'isCompacting'>,
): SlashCommandBusyReason | undefined {
  if (options.isStreaming) return 'streaming';
  if (options.isCompacting) return 'compacting';
  return undefined;
}

export function slashBusyMessage(
  commandName: string,
  reason: SlashCommandBusyReason,
): string {
  if (reason === 'streaming') {
    return `Cannot /${commandName} while streaming — press Esc or Ctrl-C first.`;
  }
  return `Cannot /${commandName} while compacting — wait for compaction to finish first.`;
}

export function slashDisabledMessage(commandName: string, experimentalFlag: FlagId): string {
  if (experimentalFlag === 'role_profiles') {
    return `Role profiles are experimental. Run /experiments and enable Role Profiles before using /${commandName}.`;
  }
  return `/${commandName} is disabled (${experimentalFlag}). Run /experiments to enable it.`;
}
