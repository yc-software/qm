import type { CoreSession } from "./core-bridge.ts";

type SubagentState = "working" | "waiting" | "done" | "failed";

export interface SubagentRow {
  session: CoreSession;
  state: SubagentState;
  depth: number;
  startedAt: number;
  endedAt: number | null;
}

type SessionLink = Pick<CoreSession, "id" | "parentSessionId" | "working" | "awaitingInput">;

const childIndexes = new WeakMap<readonly SessionLink[], Map<string, number[]>>();

function childPositions(list: readonly SessionLink[]): Map<string, number[]> {
  const index = childIndexes.get(list);
  if (index) return index;
  const built = new Map<string, number[]>();
  list.forEach((session, position) => {
    if (!session.parentSessionId) return;
    const siblings = built.get(session.parentSessionId);
    if (siblings) siblings.push(position);
    else built.set(session.parentSessionId, [position]);
  });
  childIndexes.set(list, built);
  return built;
}

export function descendantsOf<T extends SessionLink>(
  list: readonly T[],
  rootId: string,
): { session: T; depth: number }[] {
  const index = childPositions(list);
  const out: { session: T; depth: number }[] = [];
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let depth = 1; frontier.length; depth++) {
    const level = frontier.flatMap((id) => index.get(id) ?? []).sort((a, b) => a - b);
    frontier = [];
    for (const position of level) {
      const session = list[position];
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      out.push({ session, depth });
      frontier.push(session.id);
    }
  }
  return out;
}

export function subagentRows(list: readonly CoreSession[], rootId: string): SubagentRow[] {
  return descendantsOf(list, rootId).map(({ session, depth }) => {
    let state: SubagentState = "done";
    if (session.awaitingInput) state = "waiting";
    else if (session.working) state = "working";
    else if (session.lastTurnFailed) state = "failed";
    const live = state === "working" || state === "waiting";
    return {
      session,
      state,
      depth,
      startedAt: (live && session.workingSince) || session.createdAt,
      endedAt: live ? null : (session.lastActivityAt ?? session.createdAt),
    };
  });
}

export function visibleSubagents(rows: readonly SubagentRow[], acknowledged: ReadonlySet<string>): SubagentRow[] {
  const depths = new Map<string, number>();
  const visible: SubagentRow[] = [];
  for (const row of rows) {
    const shown = row.state !== "done" && !(row.state === "failed" && acknowledged.has(ackKey(row)));
    const depth = (depths.get(row.session.parentSessionId ?? "") ?? 0) + (shown ? 1 : 0);
    depths.set(row.session.id, depth);
    if (shown) visible.push(depth === row.depth ? row : { ...row, depth });
  }
  return visible;
}

export function ackKey(row: Pick<SubagentRow, "session" | "endedAt">): string {
  return `${row.session.id}@${row.endedAt ?? 0}`;
}

export function subagentSummary(rows: readonly SubagentRow[]): string {
  const count = (state: SubagentState) => rows.filter((row) => row.state === state).length;
  const parts: string[] = [];
  const working = count("working");
  const waiting = count("waiting");
  const failed = count("failed");
  if (working) parts.push(`${working} subagent${working === 1 ? "" : "s"} running`);
  if (waiting) parts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(", ");
}
