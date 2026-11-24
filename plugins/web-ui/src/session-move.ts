import type { CoreSession, HeldSessionMove, SessionMoveResult } from "./core-bridge";

export const SESSION_DROP_OVER_CLASS = "session-drop-over";

export interface SessionMoveHost {
  sessions(): readonly CoreSession[];
  movableFrom(scopeId: string): boolean;
  move(ids: readonly string[], scopeId: string): Promise<void>;
}

let host: SessionMoveHost | null = null;
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
      s && s.scopeId !== scopeId && s.surface === "web" && !s.parentSessionId && !s.sideChat && movableFrom(s.scopeId),
    );
  });
}

export function moveConfirmation(titles: readonly string[], project: string, readers: readonly string[]): string {
  const list = readers.length > 1 ? `${readers.slice(0, -1).join(", ")} and ${readers.at(-1)}` : (readers[0] ?? "");
  const one = titles.length === 1;
  const what = one ? `"${titles[0]}"` : `${titles.length} chats`;
  return `Move ${what} to ${project}? ${list} will be able to read ${one ? "it" : "them"}, including ${one ? "its" : "their"} earlier messages.`;
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
    ids = movableInto(target.sessions(), dragIds, scopeId, (from) => target.movableFrom(from));
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

export interface SessionMoveIo {
  project: string;
  title(id: string): string;
  move(ids: readonly string[], audience: readonly string[]): Promise<SessionMoveResult>;
  confirm(question: string): boolean;
  reason(error: unknown): string;
}

export async function runSessionMove(
  ids: readonly string[],
  io: SessionMoveIo,
): Promise<{ moved: readonly CoreSession[]; toast: string | null }> {
  const explain = (held: readonly HeldSessionMove[]) =>
    held.map((h) => (ids.length === 1 ? h.message : `"${io.title(h.sessionId)}" wasn't moved: ${h.message}`));
  const finish = (moved: readonly CoreSession[], notes: readonly string[]) => {
    let summary = "";
    if (moved.length === ids.length)
      summary = moved.length === 1 ? `Moved to ${io.project}` : `Moved ${moved.length} chats to ${io.project}`;
    else if (moved.length) summary = `Moved ${moved.length} of ${ids.length} chats to ${io.project}.`;
    return { moved, toast: [summary, ...notes].filter(Boolean).join(" ") || null };
  };
  const notes: string[] = [];
  let ready = ids;
  let audience: readonly string[] = [];
  try {
    for (;;) {
      const out = await io.move(ready, audience);
      notes.push(...explain(out.held));
      if ("sessions" in out) return finish(out.sessions, notes);
      ready = ready.filter((id) => !out.held.some((h) => h.sessionId === id));
      const readers = out.confirm.map((g) => g.displayName);
      if (!io.confirm(moveConfirmation(ready.map(io.title), io.project, readers))) return finish([], notes);
      audience = out.confirm.map((g) => g.principalId);
    }
  } catch (error) {
    return finish([], [...notes, io.reason(error)]);
  }
}
