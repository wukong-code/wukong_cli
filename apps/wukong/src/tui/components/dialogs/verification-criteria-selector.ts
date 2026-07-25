import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type {
  VerificationCriteriaCatalogEntryV1,
  VerificationCriteriaCatalogV1,
} from '@wukong/verification';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface VerificationCriteriaChoice {
  readonly selectionId: string;
  readonly provenanceDigest: string;
}

export interface VerificationCriteriaSelectorOptions {
  readonly catalog: VerificationCriteriaCatalogV1;
  readonly selected: readonly VerificationCriteriaChoice[];
  readonly onDone: (selected: readonly VerificationCriteriaChoice[]) => void;
  readonly onCancel: () => void;
}

export class VerificationCriteriaSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly list: SearchableList<VerificationCriteriaCatalogEntryV1>;
  private readonly selected: VerificationCriteriaChoice[];

  constructor(private readonly options: VerificationCriteriaSelectorOptions) {
    super();
    this.selected = [...options.selected];
    this.list = new SearchableList({
      items: options.catalog.entries,
      toSearchText: (entry) => [
        entry.ref.skillName,
        entry.recipe.description,
        entry.ref.logicalLocator,
        entry.ref.source.kind,
      ].join(' '),
      searchable: true,
      pageSize: 6,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.options.onDone(this.selected);
      return;
    }
    if (matchesKey(data, Key.space)) {
      const entry = this.list.selected();
      if (entry === undefined) return;
      const index = this.selected.findIndex(
        (selected) => selected.selectionId === entry.selectionId,
      );
      if (index === -1) {
        this.selected.push({
          selectionId: entry.selectionId,
          provenanceDigest: entry.ref.provenanceDigest,
        });
      } else {
        this.selected.splice(index, 1);
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const entry = this.list.selected();
      const index = entry === undefined
        ? -1
        : this.selected.findIndex(
            (selected) => selected.selectionId === entry.selectionId,
          );
      if (index === -1) return;
      const nextIndex = matchesKey(data, Key.left)
        ? Math.max(0, index - 1)
        : Math.min(this.selected.length - 1, index + 1);
      if (nextIndex === index) return;
      const [moved] = this.selected.splice(index, 1);
      if (moved !== undefined) this.selected.splice(nextIndex, 0, moved);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const lines = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg(
        'primary',
        ' Verification criteria',
      ) + (
        view.query.length === 0
          ? currentTheme.fg('textMuted', '  (type to search)')
          : ''
      ),
      currentTheme.fg(
        'textMuted',
        ' ↑↓ navigate · Space toggle · ←→ order · Enter confirm · Esc cancel',
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
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    }
    for (let index = view.page.start; index < view.page.end; index += 1) {
      const entry = view.items[index]!;
      const cursor = index === view.selectedIndex;
      const selectedIndex = this.selected.findIndex(
        (selected) => selected.selectionId === entry.selectionId,
      );
      const selected = selectedIndex !== -1;
      const pointer = cursor ? SELECT_POINTER : ' ';
      const collision = entry.status === 'collision'
        ? currentTheme.fg('warning', ' ! same name · exact source')
        : '';
      const state = selected
          ? currentTheme.fg('success', ` ✓ ${String(selectedIndex + 1)} selected`)
          : entrySuggestion(this.options.catalog, entry.selectionId)
            ? currentTheme.fg('warning', ' ○ suggested')
            : currentTheme.fg('textMuted', ' ○');
      lines.push(
        currentTheme.fg(cursor ? 'primary' : 'textDim', `  ${pointer} `)
          + (
            cursor
              ? currentTheme.boldFg('primary', entry.ref.skillName)
              : currentTheme.fg('text', entry.ref.skillName)
          )
          + collision
          + state,
      );
      lines.push(currentTheme.fg(
        'textMuted',
        `    ${entry.ref.source.kind} · ${entry.ref.logicalLocator} · ${String(entry.recipe.criteria.length)} blocking · ${entry.ref.provenanceDigest.slice(0, 20)}…`,
      ));
      if (cursor) {
        lines.push(currentTheme.fg(
          'textMuted',
          `    Input: scope-matched/changed files; secrets excluded · Cost: one shared fresh review`,
        ));
        lines.push(currentTheme.fg(
          'textMuted',
          `    Trust: ${formatSourceTrust(entry)}`,
        ));
        lines.push(currentTheme.fg(
          'textMuted',
          `    Digest: ${entry.ref.provenanceDigest}`,
        ));
        for (const criterion of entry.recipe.criteria) {
          lines.push(currentTheme.fg(
            'textMuted',
            `    Criterion ${criterion.id}: ${criterion.text}`,
          ));
        }
      }
    }
    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(currentTheme.fg(
        'textMuted',
        ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
      ));
    }
    lines.push(currentTheme.fg(
      'textMuted',
      ' Model hints: none · hints are advisory and never select criteria',
    ));
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function formatSourceTrust(entry: VerificationCriteriaCatalogEntryV1): string {
  const trust = entry.ref.sourceTrust;
  switch (trust.kind) {
    case 'workspace':
      return `workspace · ${trust.workspaceIdentityDigest}`;
    case 'personal-local':
      return `personal-local · ${trust.ownerIdentityDigest}`;
    case 'extra-local-grant':
      return `extra-local-grant · ${trust.trustGrantId}`;
    case 'builtin-release':
      return `builtin-release · ${trust.version} · ${trust.assetDigest}`;
  }
}

function entrySuggestion(
  catalog: VerificationCriteriaCatalogV1,
  selectionId: string,
): boolean {
  return catalog.suggestions.some((suggestion) => suggestion.selectionId === selectionId);
}
