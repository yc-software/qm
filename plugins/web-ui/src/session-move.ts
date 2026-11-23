import type { CoreSession } from "./core-bridge";

export const SESSION_DROP_OVER_CLASS = "session-drop-over";

export interface SessionMoveHost {
  sessions(): readonly CoreSession[];
  move(ids: readonly string[], scopeId: string): Promise<void>;
}

let host: SessionMoveHost | null = null;
let dragIds: readonly string[] | null = null;

export function registerSessionMoveHost(next: SessionMoveHost | null): void {
  host = next;
}

/** A drag of a selected row carries the whole selection; any other row moves alone. */
export function sessionsToMove(selected: ReadonlySet<string>, draggedId: string): string[] {
  return selected.has(draggedId) && selected.size > 1 ? [...selected] : [draggedId];
}

/** The dragged sessions that would actually change scope when dropped on `scopeId`. */
export function movableInto(
  sessions: readonly Pick<CoreSession, "id" | "scopeId">[],
  ids: readonly string[],
  scopeId: string,
): string[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return ids.filter((id) => {
    const s = byId.get(id);
    return Boolean(s && s.scopeId !== scopeId);
  });
}

export function beginSessionMoveDrag(ids: readonly string[]): void {
  dragIds = ids.length ? ids : null;
}

export function endSessionMoveDrag(): void {
  dragIds = null;
  for (const el of document.querySelectorAll(`.${SESSION_DROP_OVER_CLASS}`)) el.classList.remove(SESSION_DROP_OVER_CLASS);
}

function droppable(scopeId: string): string[] {
  if (!dragIds || !host) return [];
  return movableInto(host.sessions(), dragIds, scopeId);
}

export interface ProjectDropHandlers {
  dragenter(e: DragEvent): void;
  dragover(e: DragEvent): void;
  dragleave(e: DragEvent): void;
  drop(e: DragEvent): void;
}

/** Event handlers that make an element a drop target that moves dragged sessions into a project. */
export function projectDropHandlers(scopeId: string): ProjectDropHandlers {
  const accept = (e: DragEvent): boolean => {
    if (!droppable(scopeId).length) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    (e.currentTarget as HTMLElement).classList.add(SESSION_DROP_OVER_CLASS);
    return true;
  };
  return {
    dragenter: accept,
    dragover: accept,
    dragleave(e) {
      const el = e.currentTarget as HTMLElement;
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return;
      el.classList.remove(SESSION_DROP_OVER_CLASS);
    },
    drop(e) {
      const ids = droppable(scopeId);
      (e.currentTarget as HTMLElement).classList.remove(SESSION_DROP_OVER_CLASS);
      if (!ids.length || !host) return;
      e.preventDefault();
      e.stopPropagation();
      const target = host;
      endSessionMoveDrag();
      void target.move(ids, scopeId);
    },
  };
}
