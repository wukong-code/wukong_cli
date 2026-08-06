export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: 'ctrl-s to add guidance without waiting for the turn to finish', priority: 2, solo: true },
  { text: '/tasks to check progress and status for background tasks', priority: 2 },
  { text: '/init: generate AGENTS.md', priority: 2 },
  { text: 'Try /dance for a hidden Easter egg' },
  { text: '/plugins: manage plugins — try the "superpowers" plugin', solo: true, priority: 3 },
  {
    text: '/plugins: manage plugins — try the "Wukong Datasource" for reliable financial, economic, and academic data',
    solo: true,
    priority: 3,
  },
  { text: 'ask Wukong to schedule tasks, e.g. "remind me at 5pm"', solo: true, priority: 3 },
  { text: '/resume to browse and continue earlier sessions', solo: true },
  { text: '/loop <goal> to write, check, review, and fix until ready', priority: 3, solo: true },
  { text: '/loop status to inspect the active Loop', solo: true },
  { text: 'after PASS, review git status and git diff — Wukong does not commit automatically', solo: true },
  { text: '@: mention files', priority: 2 },
  { text: '! to run a shell command', priority: 2 },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: 'shift+enter: newline' },
  { text: 'ctrl+c: cancel' },
  { text: '/theme to switch the terminal UI theme' },
  { text: '/auto works unattended within policy and stops at explicit approval boundaries' },
  { text: '/yolo to skip most approvals for trusted batch work, only use it in repos you trust' },
  { text: '/help: show commands' },
  { text: '/compact compresses context when it gets long', priority: 2 },
  { text: 'ctrl-o to hide or reveal tool output switching between a clean chat view and full execution details', priority: 2 },
  { text: 'shift-tab to Plan mode to review the approach before Wukong edits files.', priority: 2 },
  { text: '/model: switch model', priority: 2 },
];
