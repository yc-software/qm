export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export type SplitEdge = Exclude<DropEdge, "center">;

export const MAX_TILES = 4;

export const MAX_PANES = 12;

const WALK_BUDGET = 10_000;

export interface PaneSeed {
  sessionId: string | null;
  threadRef: string | null;
}

export type PaneLoadKind = "session" | "continuable" | "blank" | "invalid";

export function isLiveCanvasState(input: {
  active: boolean;
  hasDock: boolean;
  hostAttached: boolean;
  panelCount: number;
}): boolean {
  return input.active && input.hasDock && input.hostAttached && input.panelCount > 0;
}

export function parsePaneSeed(raw: unknown): PaneSeed | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { sessionId?: unknown; threadRef?: unknown };
  if (value.sessionId != null && typeof value.sessionId !== "string") return null;
  if (value.threadRef != null && typeof value.threadRef !== "string") return null;
  return {
    sessionId: typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null,
    threadRef: typeof value.threadRef === "string" && value.threadRef ? value.threadRef : null,
  };
}

export function classifyPaneSeed(raw: unknown): PaneLoadKind {
  const seed = parsePaneSeed(raw);
  if (!seed) return "invalid";
  if (seed.sessionId) return "session";
  if (seed.threadRef) return "continuable";
  return "blank";
}

export function paneSeedMatchesSession(raw: unknown, sessionId: string, threadRef: string): boolean {
  const seed = parsePaneSeed(raw);
  return Boolean(seed && (seed.sessionId === sessionId || (threadRef && seed.threadRef === threadRef)));
}

export function serializedPaneParams(panel: unknown): unknown {
  return panel && typeof panel === "object" ? (panel as { params?: unknown }).params : undefined;
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
      const seed = parsePaneSeed(o);
      if (!seed) return null;
      seeds.push(seed);
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
    const kind = classifyPaneSeed(serializedPaneParams(panel) ?? {});
    return kind === "continuable";
  });
}
