import { toolCategory, toolRowKind, type TimelineItem, type ToolPayload, type ToolRowModel } from "./timeline.ts";
import type { WorkBlock } from "./core-bridge.ts";

export type ActivityCategory = "read" | "search" | "execute" | "other";

function compactPath(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  return parts.at(-1) === "SKILL.md" ? parts.slice(-2).join("/") : parts.at(-1) || path;
}

export function activityDescription(
  call: ToolPayload,
  result: ToolPayload = {},
): {
  category: ActivityCategory;
  target: string;
} {
  const tool = toolCategory({ ...result, ...call });
  if (tool === "read") return { category: "read", target: compactPath(call.path ?? result.path ?? "") };
  if (tool === "skill") {
    const name = call.name ?? result.name ?? "";
    const path = call.path ?? result.path ?? "SKILL.md";
    return { category: "read", target: path === "SKILL.md" ? name : `${name}/${compactPath(path)}` };
  }
  if (tool !== "execute") return { category: "other", target: "" };
  const activity = call.activity;
  if (activity?.kind === "read") return { category: "read", target: compactPath(activity.path) };
  if (activity?.kind === "list_files")
    return { category: "search", target: `files${activity.path ? ` in ${compactPath(activity.path)}` : ""}` };
  if (activity?.kind === "search")
    return {
      category: "search",
      target: `${activity.pattern}${activity.path ? ` in ${compactPath(activity.path)}` : ""}`,
    };
  return { category: "execute", target: (call.command ?? "").split("\n")[0] ?? "" };
}

export function activityLabel(row: ToolRowModel, status: WorkBlock["status"]): string | null {
  const call = (row.call?.payload ?? {}) as ToolPayload;
  const result = (row.result?.payload ?? {}) as ToolPayload;
  const { category, target } = activityDescription(call, result);
  const state = toolRowKind(row, status);
  if (state === "approval") return null;
  const exit =
    state === "ok" &&
    toolCategory({ ...result, ...call }) === "execute" &&
    typeof result.code === "number" &&
    result.code !== 0
      ? ` · exit ${result.code}`
      : "";
  const purpose = typeof call.purpose === "string" ? call.purpose.trim() : "";
  if (purpose) {
    if (state === "failed") return `${purpose} · Failed`;
    if (state === "attempted") return `${purpose} · Unconfirmed`;
    return purpose + exit;
  }
  if (category === "other") return null;
  const verbs = {
    read: { ok: "Read", running: "Reading", failed: "Failed to read", attempted: "Tried reading" },
    search: {
      ok: "Searched for",
      running: "Searching for",
      failed: "Failed searching for",
      attempted: "Tried searching for",
    },
    execute: { ok: "Ran", running: "Running", failed: "Failed running", attempted: "Tried running" },
  };
  if (state === "ok" && (category === "read" || category === "execute") && target) return target + exit;
  return `${verbs[category][state]} ${target || (category === "execute" ? "command" : "file")}${exit}`;
}

export function activityGroupSummary(
  items: TimelineItem[],
  status: WorkBlock["status"],
): {
  label: string;
  category: ActivityCategory;
  attention: boolean;
} {
  const categories = new Set<ActivityCategory>();
  let failed = 0;
  let running = 0;
  let approvals = 0;
  let attempted = 0;
  for (const item of items) {
    if (item.kind === "approval") approvals++;
    if (item.kind !== "tool") continue;
    const state = toolRowKind(item.row, status);
    if (state === "failed") failed++;
    if (state === "running") running++;
    if (item.row.pending) approvals++;
    if (state === "attempted") attempted++;
    categories.add(
      activityDescription(
        (item.row.call?.payload ?? {}) as ToolPayload,
        (item.row.result?.payload ?? {}) as ToolPayload,
      ).category,
    );
  }
  const active = running > 0;
  const phrases = [];
  if (categories.has("read")) phrases.push(active ? "Reading files" : "Read files");
  if (categories.has("search")) phrases.push(active ? "Searching files" : "Searched files");
  if (categories.has("execute")) phrases.push(active ? "Running commands" : "Ran commands");
  if (categories.has("other")) phrases.push(active ? "Using tools" : "Used tools");
  const base = phrases.map((phrase, i) => (i ? phrase.toLowerCase() : phrase)).join(", ") || "Thought";
  const notes = [
    failed ? `${failed} failed` : "",
    approvals ? "Approval needed" : "",
    attempted ? `${attempted} unconfirmed` : "",
  ].filter(Boolean);
  return {
    label: [base, ...notes].join(" · "),
    category:
      (["search", "read", "execute"] as ActivityCategory[]).find((category) => categories.has(category)) ?? "other",
    attention: failed > 0 || approvals > 0,
  };
}

export function thinkingPresentation(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const heading = /^(?:#{1,6} +([^\n]+)|\*\*([^\n]+?)\*\*|__([^\n]+?)__)(?:\r?\n|$)/.exec(trimmed);
  if (!heading) return { title: "Thinking", body: trimmed };
  const title = (heading[1] ?? heading[2] ?? heading[3]!).replace(/ +#+$/, "").trim();
  return { title, body: trimmed.slice(heading[0].length).trim() };
}

export function sessionPresentation(
  row: ToolRowModel,
  status: WorkBlock["status"],
): { label: string; target: string; preview: string } | null {
  const call = (row.call?.payload ?? {}) as ToolPayload & {
    target?: string;
    text?: string;
    task?: string;
    interrupt?: boolean;
  };
  const result = (row.result?.payload ?? {}) as ToolPayload & { title?: string; sessionId?: string };
  if (toolCategory({ ...result, ...call }) !== "session") return null;
  const action = call.interrupt === true ? "interrupt" : (call.action ?? result.action ?? "");
  const actions: Record<string, [string, string, string]> = {
    open: ["Created", "Creating", "create"],
    write: ["Sent message to", "Sending message to", "send message to"],
    send_message: ["Sent message to", "Sending message to", "send message to"],
    followup_task: ["Continued", "Continuing", "continue"],
    read: ["Read updates from", "Reading updates from", "read updates from"],
    wait: ["Waited", "Waiting", "wait"],
    interrupt: ["Interrupted", "Interrupting", "interrupt"],
    close: ["Closed", "Closing", "close"],
    list: ["Listed", "Listing", "list"],
    new: ["Started", "Starting", "start"],
    fork: ["Forked into", "Forking into", "fork into"],
  };
  const verbs = actions[action];
  if (!verbs) return null;
  const state = toolRowKind(row, status);
  let label = verbs[0];
  if (state === "running") label = verbs[1];
  else if (state === "failed") label = `Failed to ${verbs[2]}`;
  else if (state === "attempted") label = `Tried to ${verbs[2]}`;
  else if (state === "approval") label = `${row.pending ? "Approval needed" : "Approval requested"} to ${verbs[2]}`;
  const target =
    result.title ||
    call.name ||
    call.target ||
    result.sessionId ||
    ({ open: "subagent", new: "session", fork: "session", list: "sessions" } as Record<string, string>)[action] ||
    "subagents";
  const preview = ["write", "send_message", "followup_task"].includes(action)
    ? (call.text ?? call.task ?? "").replace(/\s+/g, " ").trim()
    : "";
  return { label, target, preview };
}

export function activityGroups(items: TimelineItem[]): TimelineItem[][] {
  const groups: TimelineItem[][] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (item.kind === "text" || !last || last[0]?.kind === "text") groups.push([item]);
    else last.push(item);
  }
  return groups;
}
