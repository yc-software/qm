import type { CoreSession } from "./core-bridge";

export const SESSION_DROP_OVER_CLASS = "session-drop-over";

export interface SessionMoveHost {
  sessions(): readonly CoreSession[];
  movableFrom(scopeId: string): boolean;
  move(ids: readonly string[], scopeId: string): Promise<void>;
}

let host: SessionMoveHost | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let dragIds: readonly string[] | null = null;
const movableByTarget = new Map<string, string[]>();

export function registerSessionMoveHost(next: SessionMoveHost | null): void {
  host = next;
}

export function sessionsToMove(selected: ReadonlySet<string>, draggedId: string): string[] {
  return selected.has(draggedId) && selected.size > 1 ? [...selected] : [draggedId];
}

export function movableInto(
  sessions: readonly CoreSession[],
  ids: readonly string[],
  scopeId: string,
  movableFrom: (scopeId: string) => boolean,
): string[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return ids.filter((id) => {
    const s = byId.get(id);
    return Boolean(
      s &&
      s.scopeId !== scopeId &&
      s.surface === "web" &&
      !s.working &&
      !s.parentSessionId &&
      !s.sideChat &&
      movableFrom(s.scopeId),
    );
  });
}

export function beginSessionMoveDrag(ids: readonly string[]): void {
  dragIds = ids.length ? ids : null;
  movableByTarget.clear();
}

export function endSessionMoveDrag(): void {
  dragIds = null;
  movableByTarget.clear();
  for (const el of document.querySelectorAll(`.${SESSION_DROP_OVER_CLASS}`))
    el.classList.remove(SESSION_DROP_OVER_CLASS);
}

function droppable(scopeId: string): string[] {
  if (!dragIds || !host) return [];
  const target = host;
  let ids = movableByTarget.get(scopeId);
  if (!ids) {
    ids = movableInto(target.sessions(), dragIds, scopeId, (scope) => target.movableFrom(scope));
    movableByTarget.set(scopeId, ids);
  }
  return ids;
}

export interface ProjectDropHandlers {
  dragenter(e: DragEvent): void;
  dragover(e: DragEvent): void;
  dragleave(e: DragEvent): void;
  drop(e: DragEvent): void;
}

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

export function sessionMoveToast(message: string): void {
  let el = document.querySelector<HTMLElement>(".session-move-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "split-toast session-move-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    document.querySelector(".session-move-toast")?.remove();
  }, 2500);
}
