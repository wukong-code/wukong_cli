import { describe, it, expect } from 'vitest';

import { injectPromptSymbol } from '#/tui/components/editor/custom-editor';

describe('injectPromptSymbol', () => {
  it('places a "❯ " prompt at columns 0-1 (borderless editor)', () => {
    expect(injectPromptSymbol('  hello world')).toBe('❯ hello world');
  });

  it('preserves overall visible width (prompt occupies padding slots)', () => {
    const original = '  hello       ';
    expect(injectPromptSymbol(original)).toHaveLength(original.length);
  });

  it('preserves trailing ANSI escapes (e.g. cursor inverse marker)', () => {
    const line = '  [7m [0m         ';
    const out = injectPromptSymbol(line);
    expect(out).toBe('❯ [7m [0m         ');
  });

  it('emits no SGR when no paint is provided (terminal default foreground)', () => {
    const out = injectPromptSymbol('  hello');
    expect(out).not.toMatch(/\[/);
  });

  it('applies the paint function to the symbol when provided', () => {
    const out = injectPromptSymbol('  hello', '❯', (s) => `[${s}]`);
    expect(out).toBe('[❯] hello');
  });

  it('returns undefined when the line is too short', () => {
    expect(injectPromptSymbol(' ')).toBeUndefined();
    expect(injectPromptSymbol('')).toBeUndefined();
  });

  it('returns undefined when the leading two characters are not both spaces', () => {
    expect(injectPromptSymbol('x  hello')).toBeUndefined();
    expect(injectPromptSymbol(' x hello')).toBeUndefined();
    expect(injectPromptSymbol('xx hello')).toBeUndefined();
  });

  it('supports a custom prompt symbol', () => {
    expect(injectPromptSymbol('  hello', '!')).toBe('! hello');
  });
});
