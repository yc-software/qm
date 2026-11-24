import type { CoreSession, MoveAudienceMember } from "./core-bridge";

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
  preview(id: string): Promise<{ gains: readonly MoveAudienceMember[] }>;
  move(id: string, audience: readonly string[]): Promise<CoreSession>;
  confirm(question: string): boolean;
  reason(error: unknown): string;
}

export async function runSessionMove(
  ids: readonly string[],
  io: SessionMoveIo,
): Promise<{ moved: CoreSession[]; toast: string | null }> {
  const held: string[] = [];
  const hold = (id: string, error: unknown) => {
    const why = io.reason(error);
    held.push(ids.length === 1 ? why : `"${io.title(id)}" wasn't moved: ${why}`);
  };
  const ready: string[] = [];
  const readers = new Map<string, string>();
  const previews = await Promise.allSettled(ids.map((id) => io.preview(id)));
  previews.forEach((preview, i) => {
    if (preview.status === "rejected") return hold(ids[i]!, preview.reason);
    ready.push(ids[i]!);
    for (const g of preview.value.gains) readers.set(g.principalId, g.displayName);
  });
  if (
    ready.length &&
    readers.size &&
    !io.confirm(moveConfirmation(ready.map(io.title), io.project, [...readers.values()]))
  )
    return { moved: [], toast: held.length ? held.join(" ") : null };
  const moved: CoreSession[] = [];
  const moves = await Promise.allSettled(ready.map((id) => io.move(id, [...readers.keys()])));
  moves.forEach((move, i) => {
    if (move.status === "rejected") hold(ready[i]!, move.reason);
    else moved.push(move.value);
  });
  let summary = "";
  if (moved.length === ids.length)
    summary = moved.length === 1 ? `Moved to ${io.project}` : `Moved ${moved.length} chats to ${io.project}`;
  else if (moved.length) summary = `Moved ${moved.length} of ${ids.length} chats to ${io.project}.`;
  return { moved, toast: [summary, ...held].filter(Boolean).join(" ") };
}
