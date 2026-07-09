/**
 * Horizontal separator line rendered above/below the editor input.
 *
 * Mirrors Claude Code's separator: a full-width run of box-drawing
 * horizontal lines, with an optional left-aligned label that replaces the
 * leading dashes (e.g. `! shell mode ─────────────`).
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface SeparatorLineOptions {
  /** Label rendered at the left of the separator. */
  readonly label?: string;
  /** Optional colouriser for the line characters. */
  readonly paint?: (s: string) => string;
}

export class SeparatorLineComponent implements Component {
  private readonly label?: string;
  private readonly paint: (s: string) => string;

  constructor(options: SeparatorLineOptions = {}) {
    this.label = options.label;
    this.paint = options.paint ?? ((s) => s);
  }

  invalidate(): void {}

  setLabel(label: string | undefined): void {
    // This is a mutable property to let the host update the label without
    // remounting the component (e.g. when entering/leaving bash mode).
    (this as unknown as { label: string | undefined }).label = label;
  }

  setPaint(paint: (s: string) => string): void {
    (this as unknown as { paint: (s: string) => string }).paint = paint;
  }

  render(width: number): string[] {
    if (width <= 0) return [''];
    const label = this.label;
    if (label === undefined || label.length === 0) {
      return [this.paint('─'.repeat(width))];
    }

    const labelWidth = visibleWidth(label);
    if (labelWidth >= width) {
      return [truncateToWidth(this.paint(label), width, '…')];
    }

    const rightWidth = width - labelWidth;
    return [this.paint(label) + this.paint('─'.repeat(rightWidth))];
  }
}
