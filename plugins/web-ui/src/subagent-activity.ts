import type { CoreSession } from "./core-bridge.ts";
import type { Item } from "./items.ts";

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
      startedAt: session.createdAt,
      endedAt: live ? null : (session.lastActivityAt ?? session.createdAt),
    };
  });
}

export function visibleSubagents(rows: readonly SubagentRow[], acknowledged: ReadonlySet<string>): SubagentRow[] {
  return rows.filter((row) => row.state !== "done" && !(row.state === "failed" && acknowledged.has(ackKey(row))));
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

export interface PeekLine {
  kind: "tool" | "text";
  text: string;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolLine(item: Item): string | null {
  if (!item.tool) return null;
  const { action, command } = item.body;
  const actionText = typeof action === "string" && action ? ` ${action}` : "";
  const commandText = typeof command === "string" && command ? ` · ${command}` : "";
  return clip(`${item.tool}${actionText}${commandText}`, 120);
}

export function peekLines(items: readonly Item[], max = 4): PeekLine[] {
  const lines: PeekLine[] = [];
  for (const item of items) {
    const tool = item.kind === "ToolCall" ? toolLine(item) : null;
    if (tool) lines.push({ kind: "tool", text: tool });
    else if (item.kind === "AgentMessage" && item.variant !== "files_delivered" && item.text !== null) {
      const text = clip(item.text, 240);
      if (text) lines.push({ kind: "text", text });
    }
  }
  return lines.slice(-max);
}
