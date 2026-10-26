import { postCallText, postResultOk } from "./surface-post.ts";
import type { PendingApproval, WorkBlock } from "./core-bridge.ts";
import {
  activityItems,
  isHidden,
  isNarration,
  isUserMessage,
  reasoningStepKey,
  type Item,
  type WorkActivity,
} from "./items.ts";

export interface ToolPayload {
  sessionId?: string;
  title?: string;
  task?: string;
  target?: string;
  delivered?: string;
  interrupt?: boolean;
  status?: string;
  children?: number;

  command?: string;
  background?: boolean;
  purpose?: string;
  path?: string;
  bytes?: number;
  name?: string;
  url?: string;
  query?: string;
  seq?: number;
  count?: number;
  found?: boolean;
  blocked?: string;
  denied?: boolean;
  error?: string;
  reason?: string;
  code?: number;
  timedOut?: boolean;
  quarantined?: boolean;
  action?: string;
  process_id?: string;
  sandbox_id?: string | null;
  monitor_id?: string;
  added?: number;
}

export interface ToolRowModel {
  call: Item | null;
  result: Item | null;
  approval?: Item;
  attempts?: number;
  pending?: PendingApproval;
}

export type TimelineItem =
  | { kind: "steer"; item: Item }
  | { kind: "thinking"; seq: number; step: string | null; text: string }
  | { kind: "text"; item: Item }
  | { kind: "tool"; row: ToolRowModel }
  | { kind: "approval"; approval: PendingApproval };

export function workTimelineSegments(items: TimelineItem[]): TimelineItem[][] {
  const segments: TimelineItem[][] = [[]];
  for (const item of items) {
    if (item.kind === "steer") segments.push([item], []);
    else segments.at(-1)!.push(item);
  }
  return segments;
}

function isTerminalWorkStatus(status: WorkBlock["status"]): boolean {
  return status === "complete" || status === "failed";
}

export type ToolRowKind = "running" | "ok" | "failed" | "attempted" | "approval";

export function toolBody(item: Item | null | undefined): ToolPayload {
  return (item?.body ?? {}) as ToolPayload;
}

export function rowTool(row: Pick<ToolRowModel, "call" | "result">): string | null {
  return row.call?.tool ?? row.result?.tool ?? null;
}

export function rowArgs(row: Pick<ToolRowModel, "call" | "result">): ToolPayload {
  return { ...toolBody(row.result), ...toolBody(row.call) };
}

export function toolCategory(tool: string | null, payload: ToolPayload): string {
  if (tool === "execute" && payload.background === true) return "background";
  if (tool === "files") {
    if (payload.action === "read" || payload.action === "write") return payload.action;
    return "share";
  }
  if (tool === "skills") return payload.action === "read" ? "skill" : "share";
  if (tool === "apps") return payload.action === "publish" ? "publish" : "share";
  if (tool === "sessions" || tool === "subagents") return "session";
  if (tool !== "sandbox") return tool ?? "unknown";
  if (payload.action === "exec") return "execute";
  if (
    [
      "start_process",
      "read_process",
      "write_stdin",
      "signal_process",
      "list_processes",
      "watch_process",
      "unwatch_process",
    ].includes(payload.action ?? "")
  )
    return "background";
  return "sandbox";
}

export function toolExecutionOutput(result: Item | null): string | null {
  return result && typeof result.body.code === "number" ? result.text : null;
}

export function toolRowKind(row: ToolRowModel, status: WorkBlock["status"]): ToolRowKind {
  const result = toolBody(row.result);
  if (result.blocked === "needs_approval") return "approval";
  if (!row.result) {
    if (!isTerminalWorkStatus(status)) return "running";
    return status === "failed" ? "failed" : "attempted";
  }
  const completedNonzeroExecution =
    toolCategory(rowTool(row), rowArgs(row)) === "execute" &&
    typeof result.code === "number" &&
    Number.isFinite(result.code) &&
    result.code !== 0 &&
    result.timedOut === false &&
    toolExecutionOutput(row.result) !== null;
  const failed =
    (row.result.isError === true && !completedNonzeroExecution) ||
    !!result.error ||
    result.denied === true ||
    result.timedOut === true ||
    result.quarantined === true;
  return failed ? "failed" : "ok";
}

export function postSpeechText(row: ToolRowModel, allowInFlight = false): string | null {
  const text = row.call ? postCallText(row.call) : null;
  if (!text?.trim()) return null;
  if (row.result) return postResultOk(row.result) ? text : null;
  return allowInFlight && !row.approval && !row.pending ? text : null;
}

function orphanCallSignature(row: ToolRowModel): string | null {
  if (!row.call || row.result || row.approval) return null;
  const p = toolBody(row.call);
  return [
    row.call.tool ?? "unknown",
    p.action ?? "",
    p.sandbox_id ?? "",
    p.process_id ?? "",
    p.monitor_id ?? "",
    p.command ?? "",
    p.path ?? "",
    p.name ?? "",
    p.url ?? "",
    p.query ?? "",
    p.seq !== undefined ? String(p.seq) : "",
  ].join("");
}

const timelineMemo = new WeakMap<
  WorkBlock,
  {
    activity: WorkBlock["activity"];
    reasoning: WorkBlock["reasoning"];
    status: WorkBlock["status"];
    approvals: WorkBlock["pendingApprovals"];
    items: TimelineItem[];
  }
>();

export function buildTimeline(work: WorkBlock): TimelineItem[] {
  const hit = timelineMemo.get(work);
  if (
    hit &&
    hit.activity === work.activity &&
    hit.reasoning === work.reasoning &&
    hit.status === work.status &&
    hit.approvals === work.pendingApprovals
  ) {
    return hit.items;
  }
  const items = buildTimelineUncached(work);
  timelineMemo.set(work, {
    activity: work.activity,
    reasoning: work.reasoning,
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
  for (const a of activityItems(work.activity)) {
    if (isUserMessage(a)) {
      if (a.kind === "SteeringMessage" && !isHidden(a)) items.push({ kind: "steer", item: a });
      open = null;
    } else if (a.kind === "Reasoning") {
      if (a.body.redacted !== true)
        items.push({ kind: "thinking", seq: a.seq, step: reasoningStepKey(a), text: a.text ?? "" });
      open = null;
    } else if (a.kind === "AgentMessage") {
      items.push({ kind: "text", item: a });
      open = null;
    } else if (a.kind === "ElicitationResponse") {
      open = null;
    } else if (a.kind === "ToolCall") {
      const row: ToolRowModel = { call: a, result: null };
      if (a.callId) rowByCallId.set(a.callId, row);
      open = row;
      items.push({ kind: "tool", row });
    } else if (a.kind === "ToolResult") {
      const matched = a.callId ? rowByCallId.get(a.callId) : undefined;
      if (matched && !matched.result) matched.result = a;
      else if (!a.callId && open && !open.result) open.result = a;
      else items.push({ kind: "tool", row: { call: null, result: a } });
    } else {
      items.push({ kind: "tool", row: { call: null, result: null, approval: a } });
      open = null;
    }
  }
  if (!isTerminalWorkStatus(work.status)) {
    liveReasoning(work).forEach((block, i) =>
      items.push({ kind: "thinking", seq: -1 - i, step: `${block.step}:${block.index}`, text: block.text }),
    );
  }
  const collapsed = collapseToolItems(items, work.status);
  for (const item of collapsed) {
    if (item.kind !== "tool") continue;
    const cmd = toolBody(item.row.call).command;
    const blocked = toolBody(item.row.result).blocked === "needs_approval";
    if (!cmd || !blocked) continue;
    const queue = pendingByCmd.get(cmd);
    if (queue?.length) item.row.pending = queue.shift();
  }
  for (const queue of pendingByCmd.values()) for (const a of queue) collapsed.push({ kind: "approval", approval: a });
  return collapsed;
}

function liveReasoning(work: WorkBlock): NonNullable<WorkBlock["reasoning"]> {
  const persisted = new Set(activityItems(work.activity).map(reasoningStepKey));
  return (work.reasoning ?? []).filter((b) => b.text.trim() && !persisted.has(`${b.step}:${b.index}`));
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

export function sessionToolView(
  row: Pick<ToolRowModel, "call" | "result">,
  sessions: readonly { id: string; title?: string | null }[],
): { action: string; chipTitle?: string; sessionId?: string; detail: string } {
  const call = toolBody(row.call);
  const result = toolBody(row.result);
  const output = row.result?.text ?? "";
  const action = call.interrupt === true ? "interrupt" : (call.action ?? result.action ?? "");
  const target = result.sessionId ?? call.target;
  const session =
    sessions.find((row) => row.id === target || row.title === target) ??
    sessions.find((row) => output.includes(`(sessionId ${row.id})`));
  const sessionId = session?.id ?? result.sessionId;
  let chipTitle = session?.title || result.title || call.name || "Subagent";
  let detail = "";
  if (action === "wait") return { action, detail: "for agent messages" };
  if (action === "read" && !target && result.children === undefined) return { action, detail: "subagents" };
  if (action === "read" && result.children !== undefined) {
    return { action, detail: `${result.children} subagent${result.children === 1 ? "" : "s"}` };
  }
  if (action === "open" && !session?.title && !result.title && !call.name && call.task) {
    chipTitle = call.task.split("\n")[0].slice(0, 48);
  }
  if (action === "write" || action === "send_message" || action === "followup_task") {
    const verbs: Record<string, string> = {
      steered: "steered",
      queued_turn: "queued a turn",
      queued_message: "",
      interrupted: "interrupted",
    };
    detail = result.delivered ? (verbs[result.delivered] ?? result.delivered) : "";
  } else if (action === "read") detail = result.status ?? "";
  return { action, chipTitle, ...(sessionId ? { sessionId } : {}), detail };
}

export function currentTextPhase(work: WorkBlock): {
  phase: "commentary" | "final_answer" | undefined;
  streamOffset: number;
  startedAt: number;
} | null {
  const entry = work.activity.findLast((activity) => "marker" in activity);
  if (!entry || !("marker" in entry)) return null;
  const { phase, streamOffset } = entry;
  if (
    (phase !== undefined && phase !== "commentary" && phase !== "final_answer") ||
    typeof streamOffset !== "number" ||
    !Number.isSafeInteger(streamOffset) ||
    streamOffset < 0
  )
    return null;
  return { phase, streamOffset, startedAt: entry.createdAt };
}

export function streamedAnswer(text: string, work: WorkBlock): string {
  const phase = currentTextPhase(work);
  if (phase) {
    const lastText = work.activity.findLast((entry) => "marker" in entry || isNarration(entry.item));
    if (phase.phase !== "final_answer" && lastText && "item" in lastText) return "";
    return streamTextFrom(text, phase.streamOffset, work.streamStartOffset ?? 0);
  }
  return work.streamStartOffset
    ? streamTextFrom(text, 0, work.streamStartOffset)
    : streamingTextTail(text, work.activity);
}

function streamTextFrom(text: string, offset: number, startOffset: number): string {
  if (offset >= startOffset) return text.slice(offset - startOffset);
  let boundary = 0;
  while (boundary < text.length && text[boundary]!.trim()) boundary++;
  return "…earlier output omitted\n\n" + text.slice(boundary).trimStart();
}

export function streamingTextTail(text: string, activity: readonly WorkActivity[]): string {
  let tail = text;
  for (const item of activityItems(activity)) {
    if (!isNarration(item)) continue;
    const spoken = (item.text ?? "").trim();
    if (!spoken) continue;
    const candidate = tail.trimStart();
    if (candidate.startsWith(spoken)) tail = candidate.slice(spoken.length).replace(/^\s*?\n\n/, "");
    else if (spoken.startsWith(candidate)) return "";
    else break;
  }
  return tail;
}

export function messageWorkTimeline(work: WorkBlock, finalText: string): TimelineItem[] {
  const timeline = buildTimeline(work);
  const lastText = finalText.trim() ? timeline.findLastIndex((item) => item.kind === "text") : -1;
  return timeline.filter((item, index) => {
    if (item.kind === "thinking") return Boolean(item.text.trim());
    if (item.kind !== "text") return true;
    const text = item.item.text?.trim() ?? "";
    return (
      item.item.body.demoted !== true &&
      Boolean(text) &&
      !(index === lastText && item.item.body.phase !== "commentary" && text === finalText.trim())
    );
  });
}
