export type SidebarTreeItem =
  | { key: string; kind: 'workspace'; id: string; workspaceId: string }
  | { key: string; kind: 'session'; id: string; workspaceId?: string };

export type SidebarTreeMove = 'previous' | 'next' | 'first' | 'last';

export function moveSidebarTreeFocus(
  items: readonly SidebarTreeItem[],
  currentKey: string | null,
  move: SidebarTreeMove,
): string | null {
  if (items.length === 0) return null;
  if (move === 'first') return items[0]!.key;
  if (move === 'last') return items.at(-1)!.key;
  const currentIndex = items.findIndex((item) => item.key === currentKey);
  if (currentIndex === -1) return items[0]!.key;
  const offset = move === 'previous' ? -1 : 1;
  const nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + offset));
  return items[nextIndex]!.key;
}

export function workspaceTreeKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function sessionTreeKey(sessionId: string): string {
  return `session:${sessionId}`;
}
