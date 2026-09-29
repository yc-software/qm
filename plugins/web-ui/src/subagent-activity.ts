import type { CoreSession, SessionEntry } from "./core-bridge.ts";
import { subagentState, type SessionSubagentCounts } from "../../chassis/src/session-navigation.ts";

type SubagentState = "working" | "waiting" | "done" | "failed";

export interface SubagentRow {
  session: CoreSession;
  state: SubagentState;
  depth: number;
  startedAt: number;
  endedAt: number | null;
}

export { descendantsOf, subagentCounts } from "../../chassis/src/session-navigation.ts";
import { descendantsOf } from "../../chassis/src/session-navigation.ts";

export function subagentRows(list: readonly CoreSession[], rootId: string): SubagentRow[] {
  return descendantsOf(list, rootId).map(({ session, depth }) => subagentRow(session, depth));
}

export function subagentRow(session: CoreSession, depth: number): SubagentRow {
  const state = subagentState(session);
  const live = state === "working" || state === "waiting";
  return {
    session,
    state,
    depth,
    startedAt: session.createdAt,
    endedAt: live ? null : (session.lastActivityAt ?? session.createdAt),
  };
}

export function visibleSubagents(rows: readonly SubagentRow[], acknowledged: ReadonlySet<string>): SubagentRow[] {
  return rows.filter((row) => row.state !== "done" && !(row.state === "failed" && acknowledged.has(ackKey(row))));
}

export function ackKey(row: Pick<SubagentRow, "session" | "endedAt">): string {
  return `${row.session.id}@${row.endedAt ?? 0}`;
}

export function subagentSummary(rows: readonly SubagentRow[], full?: SessionSubagentCounts, partial = false): string {
  const count = (state: SubagentState) => rows.filter((row) => row.state === state).length;
  const parts: string[] = [];
  const working = full?.running ?? count("working");
  const waiting = full?.waiting ?? count("waiting");
  const failed = count("failed");
  if (working) parts.push(`${working} subagent${working === 1 ? "" : "s"} running`);
  if (waiting) parts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
  if (failed) parts.push(`${failed} failed${partial ? " loaded" : ""}`);
  if (partial) parts.push("more available");
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

function toolLine(payload: { tool?: unknown; action?: unknown; command?: unknown }): string | null {
  if (typeof payload.tool !== "string" || !payload.tool) return null;
  const action = typeof payload.action === "string" && payload.action ? ` ${payload.action}` : "";
  const command = typeof payload.command === "string" && payload.command ? ` · ${payload.command}` : "";
  return clip(`${payload.tool}${action}${command}`, 120);
}

export function peekLines(entries: readonly SessionEntry[], max = 4): PeekLine[] {
  const lines: PeekLine[] = [];
  for (const entry of entries) {
    const payload = (entry.payload ?? {}) as { tool?: unknown; action?: unknown; command?: unknown; text?: unknown };
    const tool = entry.type === "tool_call" ? toolLine(payload) : null;
    if (tool) lines.push({ kind: "tool", text: tool });
    else if ((entry.type === "assistant" || entry.type === "text") && typeof payload.text === "string") {
      const text = clip(payload.text, 240);
      if (text) lines.push({ kind: "text", text });
    }
  }
  return lines.slice(-max);
}
