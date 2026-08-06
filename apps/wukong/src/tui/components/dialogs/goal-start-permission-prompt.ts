import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type GoalStartPermissionChoice = 'auto' | 'yolo' | 'manual' | 'cancel';

export interface GoalStartPermissionPromptOptions {
  readonly mode: 'manual' | 'yolo';
  readonly onSelect: (choice: GoalStartPermissionChoice) => void;
  readonly onCancel: () => void;
}

export const GOAL_START_MANUAL_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'manual',
    label: 'Keep Manual and start',
    description:
      'Ask before actions that need approval. The goal may pause until you respond.',
  },
  {
    value: 'auto',
    label: 'Switch to Auto and start',
    description:
      'Work unattended within policy. Approval-required or high-risk actions stop instead of being approved.',
  },
  {
    value: 'yolo',
    label: 'Switch to YOLO and start',
    description:
      'High risk: approve ordinary tool and plan actions automatically. Hard deny rules still apply; this is not a sandbox.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your goal command.',
  },
];

export const GOAL_START_YOLO_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'yolo',
    label: 'Keep YOLO and start',
    description:
      'High risk: ordinary tool and plan actions stay approved automatically. Hard deny rules still apply; this is not a sandbox.',
  },
  {
    value: 'auto',
    label: 'Switch to safer Auto and start',
    description:
      'Work unattended within policy, but stop when an action requires explicit approval.',
  },
  {
    value: 'cancel',
    label: 'Do not start',
    description: 'Return to the input box with your goal command.',
  },
];

export function goalStartOptions(mode: 'manual' | 'yolo'): readonly StartPermissionOption[] {
  return mode === 'yolo' ? GOAL_START_YOLO_OPTIONS : GOAL_START_MANUAL_OPTIONS;
}

const MANUAL_OPTIONS = GOAL_START_MANUAL_OPTIONS;

const YOLO_OPTIONS = GOAL_START_YOLO_OPTIONS;

const MANUAL_NOTICE_LINES = [
  'Current mode: Manual. Commands, file edits, and other approval-required actions wait for you.',
  'Choose a different mode only if you understand what will run under your current OS account.',
  'None of these modes creates a shell or filesystem sandbox. Esc keeps your command.',
] as const;

const YOLO_NOTICE_LINES = [
  'Current mode: YOLO. Ordinary tool and plan actions are approved automatically.',
  'Hard deny rules still apply, but actions run under your current OS account without a sandbox.',
  'Choose Auto to restore approval boundaries for unattended work. Esc keeps your command.',
] as const;

export class GoalStartPermissionPromptComponent extends StartPermissionPromptComponent {
  constructor(opts: GoalStartPermissionPromptOptions) {
    super({
      title: 'Choose permission mode for this goal',
      noticeLines: opts.mode === 'yolo' ? YOLO_NOTICE_LINES : MANUAL_NOTICE_LINES,
      options: opts.mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
