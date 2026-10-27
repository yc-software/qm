import { activityDescription, activityLabel, sessionPresentation } from "./activity-presentation";
import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import {
  BookOpen,
  Brain,
  Bot,
  ChevronRight,
  Pencil,
  Rocket,
  ScrollText,
  SquareTerminal as Terminal,
  Wrench,
  type IconNode,
} from "lucide";
import type { PendingApproval, WorkBlock } from "./core-bridge";
import { tip } from "./tooltip";
import type { Item } from "./items";
import {
  rowArgs,
  rowTool,
  toolBody,
  toolCategory,
  toolRowKind,
  sessionToolView,
  type ToolPayload,
  type ToolRowModel,
} from "./timeline";
import { formatBytes } from "./ui";
import { icon } from "./icons";
import { sessionsState } from "./sessions";
import { onSessionDragStart, endSessionDrag } from "./session-rows";

const GENERIC_DETAIL_KEYS =
  "command path query pattern glob url name action file filename database filter repository resource title".split(" ");

const toolMeta = (icon: IconNode, active: string, done: string, attempted: string) => ({
  icon,
  active,
  done,
  attempted,
});
export const TOOL_META: Record<string, ReturnType<typeof toolMeta>> = {
  execute: toolMeta(Terminal, "Running command", "Ran command", "Tried command"),
  read: toolMeta(BookOpen, "Reading file", "Read file", "Tried reading file"),
  skill: toolMeta(BookOpen, "Loading skill", "Loaded skill", "Tried loading skill"),
  write: toolMeta(Pencil, "Writing file", "Wrote file", "Tried writing file"),
  publish: toolMeta(Rocket, "Publishing", "Published", "Tried publishing"),
  recall: toolMeta(Brain, "Searching memory", "Searched memory", "Tried searching memory"),
  memory: toolMeta(Brain, "Using memory", "Used memory", "Tried using memory"),
  history: toolMeta(ScrollText, "Searching history", "Searched history", "Tried searching history"),
  background: toolMeta(Terminal, "Managing process", "Managed process", "Tried managing process"),
};
export const UNKNOWN_TOOL = toolMeta(Wrench, "Working", "Finished step", "Tried step");

function toolName(tool: string): string {
  const parts = tool.split(/__|[/:.]/).filter(Boolean);
  const meaningful = ["mcp", "connector"].includes(parts[0]?.toLowerCase() ?? "") ? parts.slice(1) : parts;
  const names: Record<string, string> = { github: "GitHub", api: "API", url: "URL", id: "ID" };
  return meaningful
    .flatMap((part) => part.split(/[-_]/))
    .filter(Boolean)
    .map((part) => names[part.toLowerCase()] ?? part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export const SUBAGENT_MAIL_NOTES: Record<string, string> = {
  final_answer: "finished",
  no_reply: "finished without a reply",
  awaiting_input: "needs an approval",
  errored: "failed",
  refused: "was refused",
};

export function firstLine(s: string, max?: number): string {
  const line = s.split("\n")[0] ?? "";
  return max !== undefined && line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function toolDetail(tool: string, call: ToolPayload, result: ToolPayload): string {
  if (typeof call.purpose === "string" && call.purpose.trim()) return call.purpose.trim();
  const query = call.query ?? result.query ?? "";
  const counted =
    result.count === undefined ? query : `${query} · ${result.count} result${result.count === 1 ? "" : "s"}`;
  switch (toolCategory(tool, { ...result, ...call })) {
    case "execute":
      return call.command ? firstLine(call.command) : "";
    case "read":
      return call.path ?? result.path ?? "";
    case "skill": {
      const name = call.name ?? result.name ?? "";
      const path = call.path ?? result.path ?? "SKILL.md";
      return path === "SKILL.md" ? name : `${name}/${path}`;
    }
    case "write": {
      const path = call.path ?? result.path ?? "";
      const bytes = result.bytes ?? call.bytes;
      return bytes !== undefined ? `${path} · ${formatBytes(bytes)}` : path;
    }
    case "publish":
      return result.url ?? result.name ?? call.name ?? "";
    case "recall":
    case "history": {
      const seq = call.seq ?? result.seq;
      if (seq !== undefined) return result.found === false ? `entry #${seq} · not found` : `entry #${seq}`;
      return counted;
    }
    case "memory": {
      const detail = result.count === undefined && result.added !== undefined ? `${result.added} saved` : counted;
      return [call.action ?? result.action ?? "", detail].filter(Boolean).join(" ");
    }
    case "background": {
      const action = call.action ?? result.action ?? "";
      const target = call.command ? firstLine(call.command, 48) : (call.process_id ?? call.monitor_id ?? "");
      return [action, target].filter(Boolean).join(" ");
    }
    default:
      return genericToolDetail(call, result);
  }
}

function genericToolDetail(call: ToolPayload, result: ToolPayload): string {
  for (const source of [call, nestedToolInput(call), result, nestedToolInput(result)]) {
    for (const key of GENERIC_DETAIL_KEYS) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return firstLine(value.trim());
    }
  }
  return "";
}

function nestedToolInput(payload: ToolPayload): ToolPayload {
  const record = payload as Record<string, unknown>;
  for (const key of ["input", "arguments", "args"]) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as ToolPayload;
  }
  return {};
}

function toolPayloadText(payload: ToolPayload): string {
  const hidden = new Set(["tool", "callId", "workStartedAt", "workFinishedAt", "isError", "retrySafe", "rerun"]);
  const entries = Object.entries(payload as Record<string, unknown>).filter(
    ([key, value]) => !hidden.has(key) && value !== undefined,
  );
  if (!entries.length) return "";
  if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1] as string;
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

function toolPayloadCard(label: string | null, text: string, loadFull?: () => void): TemplateResult | typeof nothing {
  if (!text) return nothing;
  return html`<div class="tool-payload-card">
    ${label ? html`<div class="tool-payload-label">${label}</div>` : nothing}
    <pre class="tool-payload-body">${text}</pre>
    ${loadFull ? html`<div class="code-card-foot"><button class="show-full-btn" type="button" @click=${loadFull}>Show full ${label?.toLowerCase() ?? "command"}</button></div>` : nothing}
  </div>`;
}

export function approvalSummaryView(a: PendingApproval, expanded = false): TemplateResult {
  const summary = firstLine(a.command, 80);
  const truncated = a.command.includes("\n") || a.command.length > 80;
  return html`
    <div class="approval-head">
      <span class="approval-title">Approval needed</span>
      ${a.reason ? html`<span class="approval-reason-badge">${a.reason}</span>` : nothing}
    </div>
    ${a.summary ? html`<div class="approval-summary-line">${a.summary}</div>` : nothing}
    ${a.purpose ? html`<div class="approval-why"><span class="approval-why-label">Why</span>${a.purpose}</div>` : nothing}
    ${
      expanded
        ? html`<code class="approval-cmd approval-cmd-full">${a.command}</code>`
        : html`<code class="approval-summary" ${tip(a.command)}>${summary}</code>`
    }
    ${
      a.matched
        ? html`<div class="approval-match">
            <span class="approval-match-label">Triggered by</span
            ><code class="approval-match-snippet">${a.matched}</code>
          </div>`
        : nothing
    }
    ${
      !expanded && truncated
        ? html`<details class="approval-full">
            <summary>Show full command</summary>
            <code class="approval-cmd">${a.command}</code>
          </details>`
        : nothing
    }
  `;
}

export function approvalMarker(a: PendingApproval): TemplateResult {
  return html`<div class="approval-card inline-approval-marker">
    <div class="approval-text">${approvalSummaryView(a)}</div>
  </div>`;
}

export function createToolRows({
  loadFullItem,
  openSessionById,
}: {
  loadFullItem: (work: WorkBlock, item: Item) => Promise<void>;
  openSessionById: (id: string) => Promise<unknown>;
}) {
  function subagentChip(title: string, sessionId?: string): TemplateResult {
    const session = sessionsState.list.find((row) => row.id === sessionId);
    const inner = html`<span dir="auto">${session?.title || title}</span>`;
    if (!sessionId) return html`<span class="subagent-chip">${inner}</span>`;
    return html`<button
      class="subagent-chip"
      type="button"
      title="Open subagent · Drag to the sidebar to make a top-level session"
      draggable=${session ? "true" : "false"}
      @dragstart=${(e: DragEvent) => {
        if (session) onSessionDragStart(e, session);
        else e.preventDefault();
      }}
      @dragend=${endSessionDrag}
      @click=${(e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        void openSessionById(sessionId);
      }}
    >
      ${inner}
    </button>`;
  }
  function toolDisclosure(
    tool: string,
    call: ToolPayload,
    result: ToolPayload,
    work: WorkBlock,
    row: ToolRowModel,
  ): TemplateResult {
    const execution = toolCategory(tool, { ...result, ...call }) === "execute";
    const input = execution ? (call.command ?? "") : toolPayloadText(call);
    const text = row.result?.text ?? null;
    const output = execution ? "" : toolPayloadText({ ...result, ...(text !== null ? { result: text } : {}) });
    return html`<div class="tool-disclosure">
      ${toolPayloadCard(execution ? null : "Input", input, row.call?.truncated ? () => void loadFullItem(work, row.call!) : undefined)}
      ${toolPayloadCard("Result", output, row.result?.truncated ? () => void loadFullItem(work, row.result!) : undefined)}
    </div>`;
  }
  function toolRow(row: ToolRowModel, work: WorkBlock, status: WorkBlock["status"], stale = false): TemplateResult {
    if (row.approval) {
      const p = toolBody(row.approval);
      return html`<div class="tool-row tool-approval">
        <span class="tool-icon">${icon(Wrench, 13)}</span>
        <span class="tool-label"
          >Approval
          needed${p.reason ? html` <span class="tool-detail">${firstLine(p.reason, 90)}</span>` : nothing}</span
        >
      </div>`;
    }
    const call = toolBody(row.call);
    const result = toolBody(row.result);
    const tool = rowTool(row) ?? "unknown";
    const knownMeta = TOOL_META[toolCategory(tool, rowArgs(row))];
    const meta = knownMeta ?? UNKNOWN_TOOL;
    const name = toolName(tool) || "Tool";
    const kind = toolRowKind(row, status);
    let label = knownMeta ? meta.attempted : `Tried ${name}`;
    if (kind === "approval") label = row.pending ? "Approval needed" : "Approval requested";
    else if (kind === "running") {
      const active = knownMeta ? meta.active : name;
      label = stale ? `${active} — interrupted` : active;
    } else if (kind === "ok") label = knownMeta ? meta.done : name;
    else if (kind === "failed") label = `Failed ${name}`;
    let why = "";
    if (kind === "approval") why = firstLine(result.reason ?? "", 90);
    else if (kind === "failed") why = firstLine(result.error ?? result.reason ?? "", 90);
    const base = kind === "approval" ? "" : toolDetail(tool, call, result);
    const attempts = row.attempts && row.attempts > 1 ? `${row.attempts} attempts` : "";
    const detail = [base, why, attempts].filter(Boolean).join(" · ");
    const semantic = activityLabel(row, status);
    const visible = semantic
      ? [semantic, why, attempts, stale && kind === "running" ? "interrupted" : ""].filter(Boolean).join(" · ")
      : [label, detail].filter(Boolean).join(" ");
    const description = activityDescription(row);
    const session = sessionPresentation(row, status);
    const sessionView = session ? sessionToolView(row, sessionsState.list) : null;
    const sessionDetail = [sessionView?.detail, session?.preview].filter(Boolean).join(" · ");
    const sessionText = session ? [session.label, sessionDetail].filter(Boolean).join(" ") : null;
    const rowIcon = session ? Bot : { read: BookOpen, execute: meta.icon, other: meta.icon }[description.category];
    const classes = ["tool-row", `tool-${kind}`].join(" ");
    const head = html`<span class="tool-icon">${icon(rowIcon, 15)}</span>
      ${session && sessionView?.chipTitle ? html`<span class="session-action">${session.label}</span>${subagentChip(sessionView.chipTitle, sessionView.sessionId)}${sessionDetail ? html`<span class="tool-label session-message" title=${sessionDetail}>${sessionDetail}</span>` : nothing}` : html`<span class="tool-label" title=${sessionText ?? (detail ? `${label}: ${detail}` : label)}>${sessionText ?? visible}</span>`}`;
    if (!row.call && !row.result) return html`<div class="${classes}">${head}</div>`;
    const renderDisclosure = (details: HTMLDetailsElement): void => {
      const host = details.querySelector<HTMLElement>(".tool-disclosure-host");
      if (host) render(details.open ? toolDisclosure(tool, call, result, work, row) : nothing, host);
    };
    return html`<details
      class="${classes} tool-expandable"
      @toggle=${(event: Event) => renderDisclosure(event.currentTarget as HTMLDetailsElement)}
    >
      <summary class="tool-summary">${head}<span class="activity-chevron">${icon(ChevronRight, 14)}</span></summary>
      <div
        class="tool-disclosure-host"
        ${ref((element) => {
          const details = element?.closest<HTMLDetailsElement>("details");
          if (details) renderDisclosure(details);
        })}
      ></div>
    </details>`;
  }
  return { toolRow, subagentChip };
}
