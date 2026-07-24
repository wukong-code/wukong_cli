import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface FinishLineDraft {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly string[];
}

export type FinishLineEditorResult =
  | { readonly kind: 'submit'; readonly draft: FinishLineDraft }
  | { readonly kind: 'cancel' };

type FinishLineField = 'objective' | 'done-when' | 'must-not';
const FIELDS: readonly FinishLineField[] = ['objective', 'done-when', 'must-not'];

export class FinishLineEditorComponent extends Container implements Focusable {
  focused = false;
  private activeField: FinishLineField = 'objective';
  private readonly inputs = {
    objective: new Input(),
    'done-when': new Input(),
    'must-not': new Input(),
  };

  constructor(
    draft: FinishLineDraft,
    private readonly onDone: (result: FinishLineEditorResult) => void,
  ) {
    super();
    this.inputs.objective.setValue(draft.objective);
    this.inputs['done-when'].setValue(draft.completionCriterion ?? '');
    this.inputs['must-not'].setValue(draft.constraints.join('; '));
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape)
      || data === '\u0003'
      || data === '\u0004'
    ) {
      this.onDone({ kind: 'cancel' });
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      this.moveField(1);
      return;
    }
    if (data === '\u001B[Z' || matchesKey(data, Key.up)) {
      this.moveField(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.activeField !== 'must-not') {
        this.moveField(1);
        return;
      }
      this.submit();
      return;
    }
    this.inputs[this.activeField].handleInput(data);
    this.invalidate();
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const finalField = this.activeField === 'must-not';
    const lines = [
      currentTheme.fg('primary', `╭${'─'.repeat(Math.max(0, width - 2))}╮`),
      currentTheme.boldFg('primary', '│ Edit finish line'),
      currentTheme.fg(
        'textMuted',
        `│ Tab/↑↓ fields · ${finalField ? 'Enter submit' : 'Enter next'} · Esc cancel`,
      ),
      currentTheme.fg('textMuted', '│ Must not rules are separated with semicolons.'),
      currentTheme.fg('text', '│'),
      ...this.renderField('objective', 'Goal', innerWidth),
      ...this.renderField('done-when', 'Done when (optional)', innerWidth),
      ...this.renderField('must-not', 'Must not (optional)', innerWidth),
      currentTheme.fg('primary', `╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  override invalidate(): void {
    super.invalidate();
    for (const input of Object.values(this.inputs)) input.invalidate();
  }

  private renderField(
    field: FinishLineField,
    label: string,
    width: number,
  ): string[] {
    const active = field === this.activeField;
    const input = this.inputs[field];
    input.focused = this.focused && active;
    const rendered = input.render(width)[0] ?? '> ';
    return [
      currentTheme.fg(active ? 'primary' : 'textMuted', `│ ${label}`),
      currentTheme.fg('text', `│ ${rendered}`),
      currentTheme.fg('text', '│'),
    ];
  }

  private moveField(delta: number): void {
    const current = FIELDS.indexOf(this.activeField);
    const next = (current + delta + FIELDS.length) % FIELDS.length;
    this.activeField = FIELDS[next]!;
    this.invalidate();
  }

  private submit(): void {
    const objective = this.inputs.objective.getValue().trim();
    if (objective.length === 0) {
      this.activeField = 'objective';
      this.invalidate();
      return;
    }
    const completionCriterion = this.inputs['done-when'].getValue().trim() || undefined;
    const constraints = this.inputs['must-not'].getValue()
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    this.onDone({
      kind: 'submit',
      draft: { objective, completionCriterion, constraints },
    });
  }
}
