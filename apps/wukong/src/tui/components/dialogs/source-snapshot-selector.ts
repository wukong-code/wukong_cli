import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type {
  SnapshotUntrackedCandidateV1,
} from '@wukong/verification';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface SourceSnapshotSelectorOptions {
  readonly candidates: readonly SnapshotUntrackedCandidateV1[];
  readonly selectedPaths: readonly string[];
  readonly onDone: (selectedPaths: readonly string[]) => void;
  readonly onCancel: () => void;
}

export class SourceSnapshotSelectorComponent
  extends Container
  implements Focusable {
  focused = false;
  private readonly list: SearchableList<SnapshotUntrackedCandidateV1>;
  private readonly selectedPaths: Set<string>;

  constructor(
    private readonly options: SourceSnapshotSelectorOptions,
  ) {
    super();
    this.list = new SearchableList({
      items: options.candidates,
      toSearchText: (candidate) => candidate.pathProjection,
      searchable: true,
      pageSize: 8,
    });
    const eligiblePaths = new Set(
      options.candidates
        .filter(({ eligibility }) => eligibility === 'eligible')
        .map(({ pathProjection }) => pathProjection),
    );
    this.selectedPaths = new Set(
      options.selectedPaths.filter((path) => eligiblePaths.has(path)),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.options.onDone(
        Object.freeze([...this.selectedPaths].toSorted()),
      );
      return;
    }
    if (matchesKey(data, Key.space)) {
      const candidate = this.list.selected();
      if (candidate?.eligibility !== 'eligible') return;
      if (this.selectedPaths.has(candidate.pathProjection)) {
        this.selectedPaths.delete(candidate.pathProjection);
      } else {
        this.selectedPaths.add(candidate.pathProjection);
      }
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const lines = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Source snapshot files')
        + (view.query.length === 0
          ? currentTheme.fg('textMuted', '  (type to search)')
          : ''),
      currentTheme.fg(
        'textMuted',
        ' ↑↓ navigate · Space toggle · Enter confirm · Esc cancel',
      ),
      currentTheme.fg(
        'textMuted',
        ` ${String(this.selectedPaths.size)} selected · only eligible regular files are copied`,
      ),
      '',
    ];
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg('primary', ' Search: ')
          + currentTheme.fg('text', view.query),
      );
    }
    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No untracked files discovered'));
    }
    for (let index = view.page.start; index < view.page.end; index += 1) {
      const candidate = view.items[index]!;
      const cursor = index === view.selectedIndex;
      const selected = this.selectedPaths.has(candidate.pathProjection);
      const pointer = cursor ? SELECT_POINTER : ' ';
      const state = candidate.eligibility === 'excluded'
        ? currentTheme.fg(
            'warning',
            ` blocked · ${candidate.exclusionReason ?? 'policy_denied'}`,
          )
        : selected
          ? currentTheme.fg('success', ' ✓ selected')
          : currentTheme.fg('textMuted', ' ○ not selected');
      lines.push(
        currentTheme.fg(cursor ? 'primary' : 'textDim', `  ${pointer} `)
          + (cursor
            ? currentTheme.boldFg('primary', candidate.pathProjection)
            : currentTheme.fg('text', candidate.pathProjection))
          + state,
      );
      lines.push(currentTheme.fg(
        'textMuted',
        `    ${candidate.sizeBytes === null ? 'unknown size' : formatBytes(candidate.sizeBytes)} · ${candidate.candidateDigest}`,
      ));
    }
    if (view.page.pageCount > 1) {
      lines.push('', currentTheme.fg(
        'textMuted',
        ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
      ));
    }
    lines.push(
      '',
      currentTheme.fg(
        'textMuted',
        ' Unselected, excluded, ignored, generated, and secret files stay outside the candidate.',
      ),
      currentTheme.fg('primary', '─'.repeat(width)),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
