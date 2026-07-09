/**
 * Welcome panel shown at the top of the TUI.
 * Renders a compact startup card with the product mark, session, model, and version.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { WUKONG_EMBLEM, WUKONG_EMBLEM_HEADBAND_ROW } from '#/tui/constant/welcome-art';
import { isRainbowDancing, renderDanceWelcomeHeader } from '#/tui/easter-eggs/dance';
import { currentTheme } from '#/tui/theme';
import type { AppState, UIMode } from '#/tui/types';
import { formatTodayCompact } from '#/tui/utils/today-format';
import type { TodayBriefing } from '#/utils/stats';

export class WelcomeComponent implements Component {
  private state: AppState;
  private todayBriefing: TodayBriefing | null;
  private uiMode: UIMode;

  constructor(state: AppState, todayBriefing?: TodayBriefing | null, uiMode?: UIMode) {
    this.state = state;
    this.todayBriefing = todayBriefing ?? null;
    this.uiMode = uiMode ?? 'idle';
  }

  setState(todayBriefing: TodayBriefing | null, uiMode: UIMode): void {
    this.todayBriefing = todayBriefing;
    this.uiMode = uiMode;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);

    if (safeWidth < 24) {
      const title = chalk.bold.hex(currentTheme.palette.primary)('Wukong Code');
      const isLoggedOut = !this.state.model;
      const prompt = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)('Run /login or /provider to get started.')
        : chalk.hex(currentTheme.palette.textDim)('Send /help for help information.');
      const activeModel = this.state.availableModels[this.state.model];
      const model = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)('not set, run /login or /provider')
        : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);
      return ['', title, prompt, `Model: ${model}`].map((line) =>
        truncateToWidth(line, safeWidth, '…'),
      );
    }

    if (this.uiMode === 'idle' && this.todayBriefing !== null) {
      return this.renderTodayBlock(safeWidth);
    }

    return this.renderWelcomeCard(safeWidth);
  }

  private renderTodayBlock(safeWidth: number): string[] {
    const primary = (s: string): string => chalk.hex(currentTheme.palette.primary)(s);
    const text = formatTodayCompact({ briefing: this.todayBriefing! });
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const content = `${chalk.bold.hex(currentTheme.palette.primary)('Today')} · ${text}`;
    const truncated = truncateToWidth(content, innerWidth, '…');
    const vis = visibleWidth(truncated);
    const rightPad = Math.max(0, innerWidth - vis);

    const lines: string[] = ['', primary('╭' + '─'.repeat(safeWidth - 2) + '╮')];
    lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private renderWelcomeCard(safeWidth: number): string[] {
    const primary = (s: string): string => chalk.hex(currentTheme.palette.primary)(s);
    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];

    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    // Mascot emblem (left) + side-by-side text (right).
    const artWidth = Math.max(...WUKONG_EMBLEM.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - artWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(currentTheme.palette.primary)('Wukong Code'),
      textWidth,
      '…',
    );
    const dim = chalk.hex(currentTheme.palette.textDim);
    const labelStyle = chalk.bold.hex(currentTheme.palette.textDim);
    const rightRow1 = truncateToWidth(
      dim(isLoggedOut ? 'Run /login or /provider to get started.' : 'Send /help for help information.'),
      textWidth,
      '…',
    );
    const textRows = [rightRow0, rightRow1];
    const textStartRow = Math.floor((WUKONG_EMBLEM.length - textRows.length) / 2);

    // Headband (金箍) glows gold; the rest of the face follows the theme brand
    // colour so it stays legible in both light and dark palettes. Pad by
    // visible width (not code-point length) so the `●` eyes — an ambiguous-width
    // glyph — never shift the right-hand text column.
    const emblem = (rowIndex: number, row: string): string => {
      const token = rowIndex === WUKONG_EMBLEM_HEADBAND_ROW ? 'warning' : 'primary';
      const padded = row + ' '.repeat(Math.max(0, artWidth - visibleWidth(row)));
      return chalk.hex(currentTheme.palette[token])(padded);
    };

    let renderedHeaderLines = WUKONG_EMBLEM.map((row, i) => {
      const left = emblem(i, row);
      const textIndex = i - textStartRow;
      const text =
        textIndex >= 0 && textIndex < textRows.length ? textRows[textIndex] : undefined;
      return text !== undefined ? left + gap + text : left;
    });
    if (isRainbowDancing()) {
      renderedHeaderLines = renderDanceWelcomeHeader(
        WUKONG_EMBLEM,
        artWidth,
        textRows,
        textStartRow,
      );
    }

    const modelValue = isLoggedOut
      ? chalk.hex(currentTheme.palette.warning)('not set, run /login or /provider')
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    const infoLines = [
      labelStyle('Directory: ') + this.state.workDir,
      labelStyle('Session:   ') + this.state.sessionId,
      labelStyle('Model:     ') + modelValue,
      labelStyle('Version:   ') + this.state.version,
    ];

    if (this.state.mcpServersSummary) {
      infoLines.push(labelStyle('MCP:       ') + this.state.mcpServersSummary);
    }

    const contentLines: string[] = [...renderedHeaderLines, '', ...infoLines];

    const lines: string[] = ['', primary('╭' + '─'.repeat(safeWidth - 2) + '╮')];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
