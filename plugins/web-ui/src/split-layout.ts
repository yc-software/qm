export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export type SplitEdge = Exclude<DropEdge, "center">;

export const MAX_TILES = 4;

export const MAX_PANES = 12;

const WALK_BUDGET = 10_000;

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

export function layoutNeedsSessionList(layout: unknown): boolean {
  const panels = (layout as { panels?: unknown } | null)?.panels;
  if (!panels || typeof panels !== "object") return true;
  return Object.values(panels as Record<string, unknown>).some((panel) => {
    const params = (panel as { params?: unknown } | null)?.params as PaneSeedLike | undefined;
    return paneNeedsSessionList(params ?? {});
  });
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

export function dropAddsTile(drop: { edge: boolean; wholeTile: boolean; sourceTilePanes: number }): boolean {
  if (!drop.edge || drop.wholeTile) return false;
  return drop.sourceTilePanes !== 1;
}
