import { ChoicePickerComponent } from './choice-picker';
import type { SessionRow, SessionSource } from './session-picker';

export type ResumeHandoffAction = 'continue' | 'loop';

const SOURCE_LABELS: Record<Exclude<SessionSource, 'wukong'>, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
};

export class ResumeHandoffComponent extends ChoicePickerComponent {
  constructor(options: {
    readonly session: SessionRow;
    readonly source: Exclude<SessionSource, 'wukong'>;
    readonly onSelect: (action: ResumeHandoffAction) => void;
    readonly onCancel: () => void;
  }) {
    const sourceLabel = SOURCE_LABELS[options.source];
    super({
      title: `Continue ${sourceLabel} task in Wukong`,
      notice:
        'The source transcript is read-only. Wukong does not replay old tools, permissions, or test results.',
      options: [
        {
          value: 'continue',
          label: 'Continue in Wukong',
          description: `Import the selected ${sourceLabel} context, re-check this workspace, and continue normally.`,
        },
        {
          value: 'loop',
          label: 'Start /loop',
          description:
            'Pre-fill an editable Loop objective from the last request. Nothing runs until you review it and press Enter.',
        },
      ],
      onSelect: (value) => {
        options.onSelect(value === 'loop' ? 'loop' : 'continue');
      },
      onCancel: options.onCancel,
    });
  }
}

export function foreignLoopDraft(
  session: SessionRow,
  source: Exclude<SessionSource, 'wukong'>,
): string {
  const sourceLabel = SOURCE_LABELS[source];
  const rawObjective = session.last_prompt ?? session.title ?? `Finish the selected ${sourceLabel} task`;
  const objective = rawObjective.replaceAll(/\s+/g, ' ').trim().slice(0, 2000);
  return `/loop Continue the ${sourceLabel} task: ${objective}`;
}
