/**
 * Terminal rendering for the official Wukong pixel mascot.
 *
 * The website and CLI both use the same 29 x 22 v2 token grid. TUI output
 * combines two vertical pixels into one Unicode half-block so the official
 * silhouette fits in an 11-row welcome card without losing its colours.
 */
import chalk from 'chalk';

import {
  WUKONG_MASCOT_FRAMES,
  WUKONG_MASCOT_HEIGHT,
  WUKONG_MASCOT_PALETTE,
  WUKONG_MASCOT_WIDTH,
  type WukongMascotFrameName,
} from '#/constant/mascot';

function tokenAt(rows: readonly string[], x: number, y: number): string {
  return rows[y]?.[x] ?? '.';
}

function halfBlock(top: string, bottom: string, color: boolean): string {
  const topFilled = top !== '.';
  const bottomFilled = bottom !== '.';

  if (!topFilled && !bottomFilled) return ' ';
  if (!color) {
    if (topFilled && bottomFilled) return '█';
    return topFilled ? '▀' : '▄';
  }

  if (topFilled && bottomFilled) {
    const topColor = WUKONG_MASCOT_PALETTE[top] ?? '#ffffff';
    const bottomColor = WUKONG_MASCOT_PALETTE[bottom] ?? '#ffffff';
    if (topColor === bottomColor) return chalk.hex(topColor)('█');
    return chalk.hex(topColor).bgHex(bottomColor)('▀');
  }

  const token = topFilled ? top : bottom;
  const glyph = topFilled ? '▀' : '▄';
  return chalk.hex(WUKONG_MASCOT_PALETTE[token] ?? '#ffffff')(glyph);
}

function renderHalfBlockRows(frameName: WukongMascotFrameName, color: boolean): string[] {
  const source = WUKONG_MASCOT_FRAMES[frameName];
  const rows: string[] = [];

  for (let y = 0; y < WUKONG_MASCOT_HEIGHT; y += 2) {
    let row = '';
    for (let x = 0; x < WUKONG_MASCOT_WIDTH; x += 1) {
      row += halfBlock(tokenAt(source, x, y), tokenAt(source, x, y + 1), color);
    }
    rows.push(row.trimEnd());
  }

  return rows;
}

/** Monochrome mask used by the `/dance` rainbow renderer. */
export const WUKONG_EMBLEM: readonly string[] = renderHalfBlockRows('idle', false);

/** Official full-colour TUI rendering used by the normal welcome card. */
export function renderWukongEmblem(frameName: WukongMascotFrameName = 'idle'): string[] {
  return renderHalfBlockRows(frameName, true);
}
