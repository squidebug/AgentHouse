// The session tree: folders, sessions at the top, and the sessions the user
// placed under them. Kept free of React so it can be tested directly.
import type { SessionInfo, SessionLink } from '@agenthouse/protocol';

export interface SessionNode {
  session: SessionInfo;
  /** What places it under its parent; null at the top. */
  link: SessionLink | null;
  /** Sessions placed under it, in the order they started. */
  children: SessionNode[];
}

export interface FolderGroup {
  cwd: string;
  label: string;
  nodes: SessionNode[];
}

export function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** The links that hold: both sessions listed, one level deep. */
export function validLinks(sessions: SessionInfo[], links: SessionLink[]): Map<string, SessionLink> {
  const ids = new Set(sessions.map((s) => s.id));
  const byChild = new Map(links.filter((l) => l.childId !== l.parentId && ids.has(l.childId) && ids.has(l.parentId)).map((l) => [l.childId, l]));
  // A parent placed under another session would nest deeper than the tree shows: its children go to the top.
  for (const link of [...byChild.values()]) if (byChild.has(link.parentId)) byChild.delete(link.childId);
  return byChild;
}

/** Which session each placed session sits under. */
export function parentsOf(sessions: SessionInfo[], links: SessionLink[]): Record<string, string> {
  return Object.fromEntries([...validLinks(sessions, links).values()].map((l) => [l.childId, l.parentId]));
}

/** The same, for the sessions delegated under another (they can be handed work). */
export function delegatesOf(sessions: SessionInfo[], links: SessionLink[]): Record<string, string> {
  return Object.fromEntries([...validLinks(sessions, links).values()].filter((l) => l.kind === 'delegate').map((l) => [l.childId, l.parentId]));
}

/**
 * Sessions at the top, grouped by working folder in the order they started,
 * each with the sessions placed under it (whatever their folder).
 */
export function sessionTree(sessions: SessionInfo[], links: SessionLink[]): FolderGroup[] {
  const placed = validLinks(sessions, links);
  const nodes = new Map(sessions.map((session) => [session.id, { session, link: placed.get(session.id) ?? null, children: [] as SessionNode[] }]));
  const groups = new Map<string, SessionNode[]>();
  for (const node of nodes.values()) {
    const parent = node.link ? nodes.get(node.link.parentId) : undefined;
    if (parent) parent.children.push(node);
    else groups.set(node.session.cwd, [...(groups.get(node.session.cwd) ?? []), node]);
  }
  return [...groups].map(([cwd, list]) => ({ cwd, label: folderName(cwd), nodes: list }));
}
