import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export type LocalPathInputResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

export class LocalPathInputDialogComponent extends Container implements Focusable {
  focused = false;
  private readonly input = new Input();
  private done = false;
  private emptyHinted = false;

  constructor(
    private readonly onDone: (result: LocalPathInputResult) => void,
  ) {
    super();
    this.input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        this.emptyHinted = true;
        return;
      }
      this.done = true;
      this.onDone({ kind: 'ok', value: trimmed });
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape)
      || matchesKey(data, Key.ctrl('c'))
      || matchesKey(data, Key.ctrl('d'))
    ) {
      this.done = true;
      this.onDone({ kind: 'cancel' });
      return;
    }
    this.emptyHinted = false;
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;
    const safeWidth = Math.max(1, width);
    return [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      currentTheme.boldFg('primary', ' Trust a local verification criteria source'),
      currentTheme.fg(
        'textMuted',
        ' Enter the exact local directory containing Skill folders. Remote URLs are rejected.',
      ),
      this.emptyHinted
        ? currentTheme.fg('error', ' Path cannot be empty.')
        : currentTheme.fg('textMuted', ' This creates a revocable local-only grant.'),
      '',
      truncateToWidth(this.input.render(safeWidth)[0] ?? '> ', safeWidth, '…'),
      '',
      currentTheme.fg('textMuted', ' Enter trust · Esc cancel'),
    ].map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
