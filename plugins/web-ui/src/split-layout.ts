export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export type SplitEdge = Exclude<DropEdge, "center">;

export const MAX_TILES = 4;

export const MAX_PANES = 12;

const WALK_BUDGET = 10_000;

export interface PaneSeed {
  sessionId: string | null;
  threadRef: string | null;
}

export function v1PaneSeeds(raw: unknown): PaneSeed[] | null {
  if (!raw || typeof raw !== "object" || (raw as { active?: unknown }).active !== true) return null;
  const seeds: PaneSeed[] = [];
  const stack: unknown[] = [(raw as { root?: unknown }).root];
  for (let budget = WALK_BUDGET; stack.length; budget--) {
    if (budget <= 0) return null;
    const node = stack.pop();
    if (!node || typeof node !== "object" || seeds.length > MAX_TILES) return null;
    const o = node as Record<string, unknown>;
    if (o.kind === "leaf") {
      seeds.push({
        sessionId: typeof o.sessionId === "string" && o.sessionId ? o.sessionId : null,
        threadRef: typeof o.threadRef === "string" && o.threadRef ? o.threadRef : null,
      });
      continue;
    }
    if (o.kind !== "split") return null;
    stack.push(o.b, o.a);
  }
  return seeds.length >= 2 && seeds.length <= MAX_TILES ? seeds : null;
}

export function serializedTileCount(layout: unknown): number {
  const stack: unknown[] = [(layout as { grid?: { root?: unknown } } | null)?.grid?.root];
  let tiles = 0;
  for (let budget = WALK_BUDGET; stack.length; budget--) {
    if (budget <= 0) return Infinity;
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const o = node as { type?: unknown; data?: unknown };
    if (o.type === "leaf") tiles++;
    else if (Array.isArray(o.data)) for (const child of o.data) stack.push(child);
  }
  return tiles;
}

export function dropAddsTile(drop: { edge: boolean; wholeTile: boolean; sourceTilePanes: number }): boolean {
  if (!drop.edge || drop.wholeTile) return false;
  return drop.sourceTilePanes !== 1;
}

export function layoutNeedsSessionList(layout: unknown): boolean {
  const panels = (layout as { panels?: unknown } | null)?.panels;
  if (!panels || typeof panels !== "object") return true;
  return Object.values(panels as Record<string, unknown>).some((panel) => {
    const params = (panel as { params?: unknown } | null)?.params as PaneSeedLike | undefined;
    return paneNeedsSessionList(params ?? {});
  });
}

export function serializedActiveSessionId(layout: unknown): string | null {
  if (!layout || typeof layout !== "object") return null;
  const o = layout as { activeGroup?: unknown; panels?: unknown; grid?: { root?: unknown } };
  if (!o.panels || typeof o.panels !== "object") return null;
  const panels = o.panels as Record<string, { params?: PaneSeedLike }>;
  const stack: unknown[] = [o.grid?.root];
  for (let budget = WALK_BUDGET; stack.length; budget--) {
    if (budget <= 0) return null;
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const n = node as { data?: unknown };
    if (Array.isArray(n.data)) {
      stack.push(...n.data);
      continue;
    }
    if (!n.data || typeof n.data !== "object") continue;
    const group = n.data as { id?: unknown; activeView?: unknown };
    if (group.id !== o.activeGroup || typeof group.activeView !== "string") continue;
    const sessionId = panels[group.activeView]?.params?.sessionId;
    return typeof sessionId === "string" && sessionId ? sessionId : null;
  }
  return null;
}

interface PaneSeedLike {
  sessionId?: unknown;
  threadRef?: unknown;
}

export function paneNeedsSessionList(p: PaneSeedLike): boolean {
  const hasSession = typeof p.sessionId === "string" && p.sessionId !== "";
  const hasThread = typeof p.threadRef === "string" && p.threadRef !== "";
  return !hasSession && hasThread;
}
