import type { PendingApproval, ToolActivity, WorkBlock } from "./core-bridge.ts";

export interface ToolPayload {
  tool?: string;
  command?: string;
  path?: string;
  bytes?: number;
  name?: string;
  url?: string;
  query?: string;
  count?: number;
  found?: boolean;
  blocked?: string;
  denied?: boolean;
  error?: string;
  reason?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
  timedOut?: boolean;
  action?: string;
  process_id?: string;
  monitor_id?: string;
  added?: number;
}

export interface ToolRowModel {
  call: ToolActivity | null;
  result: ToolActivity | null;
  approval?: ToolActivity;
  attempts?: number;
  pending?: PendingApproval;
}

export type TimelineItem =
  | { kind: "thinking"; activity: ToolActivity }
  | { kind: "text"; activity: ToolActivity }
  | { kind: "tool"; row: ToolRowModel }
  | { kind: "approval"; approval: PendingApproval };

function isTerminalWorkStatus(status: WorkBlock["status"]): boolean {
  return status === "complete" || status === "failed";
}

export type ToolRowKind = "running" | "ok" | "failed" | "attempted" | "approval";

export function toolRowKind(row: ToolRowModel, status: WorkBlock["status"]): ToolRowKind {
  const result = (row.result?.payload ?? {}) as ToolPayload;
  const tool = ((row.call?.payload ?? row.result?.payload ?? {}) as ToolPayload).tool ?? "unknown";
  if (result.blocked === "needs_approval") return "approval";
  if (!row.result) {
    if (!isTerminalWorkStatus(status)) return "running";
    return status === "failed" ? "failed" : "attempted";
  }
  const failed =
    !!result.error ||
    result.denied === true ||
    (tool === "execute" && typeof result.code === "number" && result.code !== 0);
  return failed ? "failed" : "ok";
}

function callIdOf(a: ToolActivity): string | undefined {
  const id = (a.payload as { callId?: unknown } | null)?.callId;
  return typeof id === "string" && id ? id : undefined;
}

function orphanCallSignature(row: ToolRowModel): string | null {
  if (!row.call || row.result || row.approval) return null;
  const p = (row.call.payload ?? {}) as ToolPayload;
  return [p.tool ?? "unknown", p.command ?? "", p.path ?? "", p.name ?? "", p.url ?? "", p.query ?? ""].join("");
}

const timelineMemo = new WeakMap<
  WorkBlock,
  {
    activity: WorkBlock["activity"];
    status: WorkBlock["status"];
    approvals: WorkBlock["pendingApprovals"];
    items: TimelineItem[];
  }
>();

export function buildTimeline(work: WorkBlock): TimelineItem[] {
  const hit = timelineMemo.get(work);
  if (hit && hit.activity === work.activity && hit.status === work.status && hit.approvals === work.pendingApprovals) {
    return hit.items;
  }
  const items = buildTimelineUncached(work);
  timelineMemo.set(work, {
    activity: work.activity,
    status: work.status,
    approvals: work.pendingApprovals,
    items,
  });
  return items;
}

function buildTimelineUncached(work: WorkBlock): TimelineItem[] {
  const pendingByCmd = new Map<string, PendingApproval[]>();
  for (const a of work.pendingApprovals ?? []) {
    const list = pendingByCmd.get(a.command);
    if (list) list.push(a);
    else pendingByCmd.set(a.command, [a]);
  }
  const items: TimelineItem[] = [];
  const rowByCallId = new Map<string, ToolRowModel>();
  let open: ToolRowModel | null = null;
  for (const a of work.activity) {
    if (a.type === "thinking") {
      items.push({ kind: "thinking", activity: a });
      open = null;
    } else if (a.type === "text") {
      items.push({ kind: "text", activity: a });
      open = null;
    } else if (a.type === "tool_call") {
      const row: ToolRowModel = { call: a, result: null };
      const cid = callIdOf(a);
      if (cid) rowByCallId.set(cid, row);
      open = row;
      items.push({ kind: "tool", row });
    } else if (a.type === "tool_result") {
      const cid = callIdOf(a);
      const matched = cid ? rowByCallId.get(cid) : undefined;
      if (matched && !matched.result) matched.result = a;
      else if (!cid && open && !open.result) open.result = a;
      else items.push({ kind: "tool", row: { call: null, result: a } });
    } else {
      items.push({ kind: "tool", row: { call: null, result: null, approval: a } });
      open = null;
    }
  }
  const collapsed = collapseToolItems(items, work.status);
  for (const item of collapsed) {
    if (item.kind !== "tool") continue;
    const cmd = (item.row.call?.payload as ToolPayload | undefined)?.command;
    const blocked = (item.row.result?.payload as ToolPayload | undefined)?.blocked === "needs_approval";
    if (!cmd || !blocked) continue;
    const queue = pendingByCmd.get(cmd);
    if (queue?.length) item.row.pending = queue.shift();
  }
  for (const queue of pendingByCmd.values()) for (const a of queue) collapsed.push({ kind: "approval", approval: a });
  return collapsed;
}

function collapseToolItems(items: TimelineItem[], status: WorkBlock["status"]): TimelineItem[] {
  if (!isTerminalWorkStatus(status)) return items;
  const out: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      out.push(item);
      continue;
    }
    const prev = out[out.length - 1];
    const sig = orphanCallSignature(item.row);
    if (sig && prev?.kind === "tool" && orphanCallSignature(prev.row) === sig) {
      prev.row.attempts = (prev.row.attempts ?? 1) + (item.row.attempts ?? 1);
      continue;
    }
    out.push({ kind: "tool", row: { ...item.row, attempts: item.row.attempts ?? 1 } });
  }
  return out;
}
