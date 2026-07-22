import type { AutocompleteItem, SlashCommand } from '@earendil-works/pi-tui';
import type { FlagId } from '@wukong/wukong-sdk';

export type SlashCommandAvailability = 'always' | 'idle-only';
export type SlashCommandTier = 'core' | 'advanced' | 'hidden';

export interface WukongSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  /** @deprecated Use `tier: 'hidden'` for new entries. */
  readonly hidden?: boolean;
  /** Discovery tier. All commands remain executable regardless of tier. */
  readonly tier?: SlashCommandTier;
  /** Aliases that remain executable but are omitted from help and autocomplete. */
  readonly hiddenAliases?: readonly string[];
  /** Optional public name used in help/autocomplete while keeping the canonical dispatch name. */
  readonly discoveryName?: string;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /** When set, the command is blocked unless this flag is enabled. */
  readonly experimentalFlag?: FlagId;
  /** Keep a gated command discoverable so invoking it can explain how to enable the feature. */
  readonly visibleWhenDisabled?: boolean;
  /**
   * Generic argument autocompletion. `argumentPrefix` is the text typed after
   * `/<command> `; return suggestions or `null`. Declared as a plain function
   * property (not a method) so passing it around is `this`-free. Adapted to
   * pi-tui's `getArgumentCompletions` in the autocomplete setup.
   */
  readonly completeArgs?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
