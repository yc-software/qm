import { isIP } from "node:net";
import { isPrivateNetworkIp } from "../util/network.ts";
import type { RunActivityEntry } from "../runs/run-activity-store.ts";
import type { SessionWorkBranch } from "../sessions/session-work.ts";
import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";

export type StepDetailMode = "full" | "brief";
type PlanTaskStatus = "pending" | "in_progress" | "complete" | "error";

interface PlanTaskSource {
  type: "url";
  url: string;
  text: string;
}

export interface PlanTaskSnapshot {
  taskId: string;
  title: string;
  status: PlanTaskStatus;
  details?: string;
  output?: string;
  sources?: PlanTaskSource[];
}

export interface BuiltPlan {
  tasks: PlanTaskSnapshot[];
  totalToolCalls: number;
  hasVisibleActivity: boolean;
}

const SLACK_PLAN_MAX_TASKS = 50;
const MAX_DISTINCT_TASKS = SLACK_PLAN_MAX_TASKS - 1;
const TITLE_MAX_CHARS = 60;
const MAX_SOURCES_PER_TASK = 5;

const HIDDEN_TOOLS = new Set([
  "finish_silently",
  "react",
  "typing",
  "post",
  "edit",
  "delete",
  "reply",
  "attach",
  "withdraw_approval",
]);

const SENSITIVE_TOOLS = new Set(["memory", "history", "sessions", "admin", "files", "guidance", "credentials"]);

const SENSITIVE_CONNECTOR_IDS = new Set([
  "gmail",
  "google-mail",
  "google-workspace",
  "google-drive",
  "google-docs",
  "google-sheets",
  "google-slides",
  "google-calendar",
  "slack",
  "dropbox",
  "outlook",
  "onedrive",
  "brex",
  "front",
  "quickbooks",
]);

const STATIC_LABELS: Record<string, string> = {
  execute: "Running a command",
  background: "Checking background work",
  files: "Checking files",
  memory: "Checking memory",
  history: "Checking conversation history",
  sessions: "Checking conversations",
  skills: "Reading a skill",
  cron: "Managing a schedule",
  webhook: "Managing a webhook",
  apps: "Managing an app",
  sandbox: "Managing a workspace",
  subagents: "Coordinating a helper",
  admin: "Checking workspace settings",
  guidance: "Checking instructions",
  goal: "Updating goal",
  runtime: "Checking model settings",
  context: "Managing context",
  desktop: "Interacting with desktop",
  tool_search: "Finding a tool",
  mcp_call: "Calling a connected tool",
  web_search: "Searching the web",
  web_fetch: "Reading a web page",
};

const ACTION_LABELS: Record<string, Record<string, string>> = {
  files: { read: "Reading a file", write: "Writing a file", share: "Sharing a file" },
  memory: {
    search: "Searching memory",
    read: "Reading memory",
    add: "Saving to memory",
    edit: "Updating memory",
    delete: "Updating memory",
  },
  skills: {
    list: "Listing skills",
    search: "Finding a skill",
    read: "Reading a skill",
    save: "Saving a skill",
    edit: "Updating a skill",
    share: "Sharing a skill",
  },
  cron: {
    list: "Checking schedules",
    get: "Reading a schedule",
    runs: "Checking schedule runs",
    create: "Creating a schedule",
    patch: "Updating a schedule",
    delete: "Removing a schedule",
    run: "Running a schedule",
    disable: "Pausing a schedule",
    note: "Saving a note",
  },
  apps: { publish: "Publishing an app", share: "Updating app access" },
  sandbox: {
    list: "Checking workspaces",
    status: "Checking workspace health",
    create: "Creating a workspace",
    restart: "Restarting a workspace",
    retire: "Cleaning up a workspace",
  },
  subagents: {
    open: "Starting a helper",
    wait: "Waiting on helpers",
    read: "Checking helper progress",
    send_message: "Messaging a helper",
  },
  sessions: {
    list: "Listing conversations",
    search: "Searching conversations",
    read: "Reading a conversation",
    send_message: "Messaging a conversation",
  },
  background: {
    poll: "Checking background job",
    watch: "Watching background job",
    stop: "Stopping background job",
    list: "Listing background jobs",
  },
};

function normalizeSpaces(text: string): string {
  return text
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

function resolveTaskStatus(hasPending: boolean, hasError: boolean, finalize?: boolean): PlanTaskStatus {
  if (hasPending) return finalize ? "complete" : "in_progress";
  return hasError ? "error" : "complete";
}

function clip(text: string, max: number): string {
  const clean = normalizeSpaces(text.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("\t", " "));
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function scrubStepText(raw: string, max = TITLE_MAX_CHARS): string {
  const tokens = raw
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\t", " ")
    .split(" ")
    .filter((token) => {
      if (!token) return false;
      if (token.startsWith("<@") || token.startsWith("<!") || token.startsWith("<#")) return false;
      const lower = token.toLowerCase();
      if (lower.includes("http://") || lower.includes("https://")) return false;
      if (token.includes("@") && token.includes(".")) return false;
      return true;
    });
  return clip(tokens.join(" "), max);
}

export function isHiddenStepTool(tool: string | undefined): boolean {
  if (!tool) return true;
  return HIDDEN_TOOLS.has(tool);
}

function isSensitiveTool(tool: string, body: Record<string, unknown> | undefined): boolean {
  if (SENSITIVE_TOOLS.has(tool)) return true;
  const server = typeof body?.server === "string" ? body.server.toLowerCase() : "";
  if (server && SENSITIVE_CONNECTOR_IDS.has(server)) return true;
  return false;
}

function defaultLabelForTool(tool: string, body: Record<string, unknown> | undefined): string {
  const action = typeof body?.action === "string" ? body.action : undefined;
  const byAction = action ? ACTION_LABELS[tool]?.[action] : undefined;
  if (byAction) return byAction;
  if (STATIC_LABELS[tool]) return STATIC_LABELS[tool];
  if (tool === "mcp_call" && typeof body?.server === "string" && body.server.trim()) {
    const server = body.server.trim().toLowerCase();
    if (SENSITIVE_CONNECTOR_IDS.has(server)) return "Checking a connected app";
    return `Calling ${scrubStepText(body.server.trim(), 24)}`;
  }
  return `Using ${scrubStepText(tool.replaceAll("_", " ").replaceAll("-", " "), 32)}`;
}

function labelForToolCall(
  tool: string,
  body: Record<string, unknown> | undefined,
  mode: StepDetailMode,
): { title: string; sensitive: boolean } {
  const sensitive = isSensitiveTool(tool, body);
  if (mode === "brief" || sensitive) {
    return { title: clip(defaultLabelForTool(tool, body), TITLE_MAX_CHARS), sensitive };
  }
  const purpose = typeof body?.purpose === "string" ? scrubStepText(body.purpose, TITLE_MAX_CHARS) : "";
  if (purpose) return { title: purpose, sensitive };
  return { title: clip(defaultLabelForTool(tool, body), TITLE_MAX_CHARS), sensitive };
}

function narrateToolResult(
  result: { isError?: boolean; body?: Record<string, unknown> },
  sensitive: boolean,
  mode: StepDetailMode,
): { details?: string; output?: string } {
  if (result.isError) return { output: "Step failed" };
  if (mode === "brief" || sensitive) return {};
  const exitCode = typeof result.body?.exitCode === "number" ? result.body.exitCode : undefined;
  if (exitCode !== undefined && exitCode !== 0) return { output: `Exited with status ${exitCode}` };
  const count = typeof result.body?.count === "number" ? result.body.count : undefined;
  if (count !== undefined && Number.isFinite(count) && count >= 0) {
    return { output: `${count} item${count === 1 ? "" : "s"}` };
  }
  return {};
}

function isPublicHttpUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || !host.includes(".")) return undefined;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return undefined;
  const ipKind = isIP(host);
  if (ipKind === 6) return undefined;
  if (ipKind !== 0 && isPrivateNetworkIp(host)) return undefined;
  return url;
}

const URL_LEAD_TRIM = new Set(["<", "(", "[", '"', "'", "`"]);
const URL_TRAIL_TRIM = new Set([">", ")", "]", '"', "'", "`", ",", ".", ";", "!", "?"]);

function trimUrlToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && URL_LEAD_TRIM.has(token[start]!)) start++;
  while (end > start && URL_TRAIL_TRIM.has(token[end - 1]!)) end--;
  return token.slice(start, end);
}

function extractPublicUrls(text: string): PlanTaskSource[] {
  const out: PlanTaskSource[] = [];
  const seen = new Set<string>();
  for (const token of text.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("\t", " ").split(" ")) {
    const cleaned = trimUrlToken(token);
    if (!cleaned.startsWith("https://") && !cleaned.startsWith("http://")) continue;
    const url = isPublicHttpUrl(cleaned);
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    const host = url.hostname.startsWith("www.") ? url.hostname.slice(4) : url.hostname;
    out.push({ type: "url", url: url.href, text: clip(host, 40) });
    if (out.length >= MAX_SOURCES_PER_TASK) break;
  }
  return out;
}

function extractAllowedSources(
  resultText: string | undefined,
  mode: StepDetailMode,
  sensitive: boolean,
  replyText?: string,
): PlanTaskSource[] {
  if (sensitive || !resultText) return [];
  const urls = extractPublicUrls(resultText);
  if (urls.length === 0) return [];
  if (mode === "full") return urls;
  if (!replyText) return [];
  return urls.filter((s) => replyText.includes(s.url));
}

interface CallRecord {
  callId: string;
  tool: string;
  title: string;
  sensitive: boolean;
  result?: { isError?: boolean; text?: string; body?: Record<string, unknown> };
}

export function buildPlanFromActivity(
  entries: readonly RunActivityEntry[],
  opts: {
    mode: StepDetailMode;
    branches?: readonly SessionWorkBranch[];
    replyText?: string;
    finalize?: boolean;
  },
): BuiltPlan {
  const calls: CallRecord[] = [];
  const byCallId = new Map<string, CallRecord>();

  for (const entry of entries) {
    if (!("item" in entry)) continue;
    const item = entry.item;
    if (item.kind === "Reasoning") continue;
    if (item.kind === "ToolCall") {
      if (isHiddenStepTool(item.tool ?? undefined)) continue;
      const body = item.body && typeof item.body === "object" ? (item.body as Record<string, unknown>) : undefined;
      const { title, sensitive } = labelForToolCall(item.tool ?? "", body, opts.mode);
      const callId = item.callId || `seq-${item.seq}`;
      const rec: CallRecord = { callId, tool: item.tool ?? "", title, sensitive };
      calls.push(rec);
      byCallId.set(callId, rec);
      continue;
    }
    if (item.kind === "ToolResult") {
      const rec = item.callId ? byCallId.get(item.callId) : undefined;
      if (!rec) continue;
      const body = item.body && typeof item.body === "object" ? (item.body as Record<string, unknown>) : undefined;
      const isError = body?.isError === true || body?.ok === false || body?.error === true;
      rec.result = { isError, text: item.text ?? undefined, body };
    }
  }

  interface GroupedStep {
    key: string;
    firstCallId: string;
    baseTitle: string;
    calls: CallRecord[];
  }

  const groups: GroupedStep[] = [];
  const byGroupKey = new Map<string, GroupedStep>();

  for (const call of calls) {
    const key = `${call.tool}:${call.title.toLowerCase()}`;
    let group = byGroupKey.get(key);
    if (!group) {
      group = { key, firstCallId: call.callId, baseTitle: call.title, calls: [] };
      byGroupKey.set(key, group);
      groups.push(group);
    }
    group.calls.push(call);
  }

  const branches = opts.branches ?? [];
  const maxDistinct = Math.max(1, MAX_DISTINCT_TASKS - Math.min(branches.length, 10));
  const visibleGroups = groups.slice(0, maxDistinct);
  const overflowGroups = groups.slice(maxDistinct);
  const tasks: PlanTaskSnapshot[] = [];

  for (const g of visibleGroups) {
    const title =
      g.calls.length > 1
        ? clip(`${g.baseTitle} (×${g.calls.length})`, TITLE_MAX_CHARS)
        : clip(g.baseTitle, TITLE_MAX_CHARS);
    const hasPending = g.calls.some((c) => !c.result);
    const hasError = g.calls.some((c) => c.result?.isError);
    const status = resolveTaskStatus(hasPending, hasError, opts.finalize);
    const latest = [...g.calls].reverse().find((c) => c.result) ?? g.calls[g.calls.length - 1]!;
    const narration = latest.result ? narrateToolResult(latest.result, latest.sensitive, opts.mode) : {};
    const sources: PlanTaskSource[] = [];
    const seenUrls = new Set<string>();
    for (const c of g.calls) {
      for (const src of extractAllowedSources(c.result?.text, opts.mode, c.sensitive, opts.replyText)) {
        if (seenUrls.has(src.url)) continue;
        seenUrls.add(src.url);
        sources.push(src);
        if (sources.length >= MAX_SOURCES_PER_TASK) break;
      }
      if (sources.length >= MAX_SOURCES_PER_TASK) break;
    }
    tasks.push({
      taskId: `${SLACK_STATUS_TASK_PREFIX}step:${g.firstCallId}`,
      title,
      status,
      ...(narration.details ? { details: narration.details } : {}),
      ...(narration.output ? { output: narration.output } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    });
  }

  if (overflowGroups.length > 0) {
    const overflowCalls = overflowGroups.flatMap((g) => g.calls);
    const hasPending = overflowCalls.some((c) => !c.result);
    const hasError = overflowCalls.some((c) => c.result?.isError);
    tasks.push({
      taskId: `${SLACK_STATUS_TASK_PREFIX}overflow`,
      title: `More steps… (×${overflowCalls.length})`,
      status: resolveTaskStatus(hasPending, hasError, opts.finalize),
    });
  }

  for (const branch of branches) {
    if (tasks.length >= SLACK_PLAN_MAX_TASKS) break;
    const label = branch.step
      ? `${scrubStepText(branch.title, 28)}: ${scrubStepText(branch.step, 28)}`
      : scrubStepText(branch.title, TITLE_MAX_CHARS);
    tasks.push({
      taskId: `${SLACK_STATUS_TASK_PREFIX}branch:${branch.id}`,
      title: clip(label || "Working in background", TITLE_MAX_CHARS),
      status: opts.finalize ? "complete" : "in_progress",
    });
  }

  return {
    tasks,
    totalToolCalls: calls.length,
    hasVisibleActivity: tasks.length > 0,
  };
}

function formatElapsed(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

export function planTitleForState(
  state: "working" | "done" | "stopped" | "failed" | "rolled_over",
  opts: { elapsedMs?: number; currentStep?: string } = {},
): string {
  if (state === "working") {
    const step = opts.currentStep ? scrubStepText(opts.currentStep, 48) : "";
    return step ? `Working — ${step}` : "Working…";
  }
  if (state === "rolled_over") return "Working… (continued below)";
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Stopped after an error";
  return `Worked for ${formatElapsed(opts.elapsedMs ?? 0)}`;
}

export function taskToStreamChunk(task: PlanTaskSnapshot): Record<string, unknown> {
  return {
    type: "task_update",
    id: task.taskId,
    title: task.title,
    status: task.status,
    ...(task.details ? { details: task.details } : {}),
    ...(task.output ? { output: task.output } : {}),
    ...(task.sources && task.sources.length > 0 ? { sources: task.sources } : {}),
  };
}

function taskToPlanTaskBlock(task: PlanTaskSnapshot): Record<string, unknown> {
  return {
    type: "task_card",
    task_id: task.taskId,
    title: task.title,
    status: task.status,
    ...(task.details
      ? {
          details: {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: [{ type: "text", text: task.details }] }],
          },
        }
      : {}),
    ...(task.output
      ? {
          output: {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: [{ type: "text", text: task.output }] }],
          },
        }
      : {}),
    ...(task.sources && task.sources.length > 0 ? { sources: task.sources } : {}),
  };
}

export function buildPlanBlock(
  title: string,
  tasks: readonly PlanTaskSnapshot[],
  blockId: string,
): Record<string, unknown> {
  return {
    type: "plan",
    block_id: blockId,
    title: clip(title, 150),
    tasks: tasks.slice(0, SLACK_PLAN_MAX_TASKS).map(taskToPlanTaskBlock),
  };
}
