import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface LoopRuntimeDraft {
  readonly maxIterations: number;
  readonly writerModel: string;
  readonly writerProviderCallLimit?: number;
  readonly reviewerProviderCallLimit?: number;
  readonly tokenBudget?: number;
  readonly reviewModel?: string;
  readonly minIntervalMs?: number;
}

export type LoopRuntimeEditorResult =
  | { readonly kind: 'submit'; readonly draft: LoopRuntimeDraft }
  | { readonly kind: 'cancel' };

type LoopRuntimeField =
  | 'max-iterations'
  | 'writer-model'
  | 'writer-calls'
  | 'reviewer-calls'
  | 'token-budget'
  | 'review-model'
  | 'min-interval';

const FIELDS: readonly LoopRuntimeField[] = [
  'max-iterations',
  'writer-model',
  'writer-calls',
  'reviewer-calls',
  'token-budget',
  'review-model',
  'min-interval',
];

export class LoopRuntimeEditorComponent extends Container implements Focusable {
  focused = false;
  private activeField: LoopRuntimeField = 'max-iterations';
  private validationError: string | undefined;
  private readonly inputs = {
    'max-iterations': new Input(),
    'writer-model': new Input(),
    'writer-calls': new Input(),
    'reviewer-calls': new Input(),
    'token-budget': new Input(),
    'review-model': new Input(),
    'min-interval': new Input(),
  };

  constructor(
    draft: LoopRuntimeDraft,
    private readonly onDone: (result: LoopRuntimeEditorResult) => void,
  ) {
    super();
    this.inputs['max-iterations'].setValue(String(draft.maxIterations));
    this.inputs['writer-model'].setValue(draft.writerModel);
    this.inputs['writer-calls'].setValue(optionalNumber(draft.writerProviderCallLimit));
    this.inputs['reviewer-calls'].setValue(optionalNumber(draft.reviewerProviderCallLimit));
    this.inputs['token-budget'].setValue(optionalNumber(draft.tokenBudget));
    this.inputs['review-model'].setValue(draft.reviewModel ?? '');
    this.inputs['min-interval'].setValue(optionalNumber(draft.minIntervalMs));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === '\u0003' || data === '\u0004') {
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
      if (this.activeField !== 'min-interval') {
        this.moveField(1);
        return;
      }
      this.submit();
      return;
    }
    this.validationError = undefined;
    this.inputs[this.activeField].handleInput(data);
    this.invalidate();
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const finalField = this.activeField === 'min-interval';
    const lines = [
      currentTheme.fg('primary', `╭${'─'.repeat(Math.max(0, width - 2))}╮`),
      currentTheme.boldFg('primary', '│ Edit Loop runtime limits'),
      currentTheme.fg(
        'textMuted',
        `│ Tab/↑↓ fields · ${finalField ? 'Enter apply' : 'Enter next'} · Esc cancel`,
      ),
      currentTheme.fg('textMuted', '│ Leave optional limits blank for no separate cap.'),
      ...(this.validationError === undefined
        ? []
        : [currentTheme.fg('error', `│ ${this.validationError}`)]),
      currentTheme.fg('text', '│'),
      ...this.renderField('max-iterations', 'Maximum iterations', innerWidth),
      ...this.renderField('writer-model', 'Writer model', innerWidth),
      ...this.renderField('writer-calls', 'Writer provider calls', innerWidth),
      ...this.renderField('reviewer-calls', 'Reviewer provider calls', innerWidth),
      ...this.renderField('token-budget', 'Token budget', innerWidth),
      ...this.renderField('review-model', 'Reviewer model', innerWidth),
      ...this.renderField('min-interval', 'Minimum interval (ms)', innerWidth),
      currentTheme.fg('primary', `╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  override invalidate(): void {
    super.invalidate();
    for (const input of Object.values(this.inputs)) input.invalidate();
  }

  private renderField(field: LoopRuntimeField, label: string, width: number): string[] {
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
    this.validationError = undefined;
    this.invalidate();
  }

  private submit(): void {
    const maxIterations = positiveInteger(this.inputs['max-iterations'].getValue());
    if (maxIterations === undefined) {
      this.validationError = 'Maximum iterations must be a positive safe integer.';
      this.activeField = 'max-iterations';
      this.invalidate();
      return;
    }
    const writerProviderCallLimit = optionalPositiveInteger(
      this.inputs['writer-calls'].getValue(),
    );
    if (!writerProviderCallLimit.ok) {
      this.invalidOptional(
        'writer-calls',
        'Writer provider calls must be blank or a positive safe integer.',
      );
      return;
    }
    const reviewerProviderCallLimit = optionalPositiveInteger(
      this.inputs['reviewer-calls'].getValue(),
    );
    if (!reviewerProviderCallLimit.ok) {
      this.invalidOptional(
        'reviewer-calls',
        'Reviewer provider calls must be blank or a positive safe integer.',
      );
      return;
    }
    const tokenBudget = optionalPositiveInteger(this.inputs['token-budget'].getValue());
    if (!tokenBudget.ok) {
      this.invalidOptional(
        'token-budget',
        'Token budget must be blank or a positive safe integer.',
      );
      return;
    }
    const minIntervalMs = optionalPositiveInteger(this.inputs['min-interval'].getValue());
    if (!minIntervalMs.ok) {
      this.invalidOptional(
        'min-interval',
        'Minimum interval must be blank or a positive safe integer.',
      );
      return;
    }
    const writerModel = this.inputs['writer-model'].getValue().trim();
    if (writerModel.length === 0) {
      this.invalidOptional('writer-model', 'Writer model must be a configured alias.');
      return;
    }
    const reviewModel = this.inputs['review-model'].getValue().trim() || undefined;
    this.onDone({
      kind: 'submit',
      draft: {
        maxIterations,
        writerModel,
        writerProviderCallLimit: writerProviderCallLimit.value,
        reviewerProviderCallLimit: reviewerProviderCallLimit.value,
        tokenBudget: tokenBudget.value,
        reviewModel,
        minIntervalMs: minIntervalMs.value,
      },
    });
  }

  private invalidOptional(field: LoopRuntimeField, message: string): void {
    this.validationError = message;
    this.activeField = field;
    this.invalidate();
  }
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function positiveInteger(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function optionalPositiveInteger(raw: string):
  | { readonly ok: true; readonly value?: number }
  | { readonly ok: false } {
  if (raw.trim().length === 0) return { ok: true };
  const value = positiveInteger(raw);
  return value === undefined ? { ok: false } : { ok: true, value };
}
