// Schema helpers, result capping and list/cron formatting shared by the agent tool families.

import { Type } from "typebox";
import { MAX_OUTBOUND_FILES } from "../../core/attachments.ts";
import type { PublishAudienceDescriptor } from "../../tools/primitives.ts";
import type { CronFireLogEntry } from "../../types.ts";
import { headTailSlice } from "../../util/text.ts";
import { utcMinute } from "../../util/time.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";

export function describePublishAudience(a: PublishAudienceDescriptor | undefined): string {
  if (!a) return "Owned by you.";
  const note = a.note ? ` (note: ${a.note})` : "";
  if (a.kind === "org") return `Owned by you; reachable by anyone at ${a.orgId ?? "your org"}.${note}`;
  if (a.kind === "members") {
    if (a.memberCount === undefined)
      return `Owned by you; access follows the visibility and membership of its shared scopes.${note}`;
    const n = a.memberCount;
    const who = a.channelRef
      ? `the ${n} ${n === 1 ? "person" : "people"} currently in #${a.channelRef}`
      : `${n} ${n === 1 ? "person" : "people"} you've shared it with`;
    return `Owned by you; reachable by ${who} (from any surface they sign in to).${note}`;
  }
  return `Owned by you; owner-only (only you can reach it — use apps action share to widen).${note}`;
}

export const optionalString = (description: string) => Type.Optional(Type.String({ description }));
export const optionalBoolean = (description: string) => Type.Optional(Type.Boolean({ description }));
export const optionalInteger = (description: string) => Type.Optional(Type.Integer({ description }));

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

export function isPolicyNotice(summary: Record<string, unknown>): boolean {
  return summary.blocked !== undefined || summary.denied !== undefined;
}

const MAX_TOOL_RESULT_CHARS = 100_000;
export const PRESSURE_WARN_FULL60 = 50;
const TRUNCATED_TAIL_CHARS = 10_000;

export function capResultText(t: string): string {
  return headTailSlice(
    t,
    MAX_TOOL_RESULT_CHARS,
    TRUNCATED_TAIL_CHARS,
    `\n…[truncated — full result was ${t.length} chars and the middle was dropped; ` +
      `refetch narrower (filter or paginate the call, or redirect to a file and read it in pieces) if you need it]…\n`,
  );
}

export function capPayloadStrings(v: unknown): unknown {
  if (typeof v === "string") return capResultText(v);
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const c = capPayloadStrings(v[i]);
      if (c !== v[i]) (out ??= v.slice())[i] = c;
    }
    return out ?? v;
  }
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(v)) {
      const c = capPayloadStrings(x);
      if (c !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = c;
    }
    return out ?? v;
  }
  return v;
}

export function capText(t: string): string {
  return t.length > MAX_TOOL_RESULT_CHARS ? `${t.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : t;
}

export function fmtStatus(s: { state: "running" } | { state: "exited"; code: number }): string {
  return s.state === "exited" ? `exited ${s.code}` : "running";
}

function fmtCronSchedule(c: {
  schedule: { cron?: string; timezone?: string; everyMs?: number; firstFireAt?: number };
}): string {
  const s = c.schedule;
  if (s.cron) return `${s.cron}${s.timezone ? ` (${s.timezone})` : ""}`;
  if (s.everyMs != null) return `every ${Math.max(1, Math.round(s.everyMs / 60_000))}m`;
  if (s.firstFireAt != null) return `once at ${new Date(s.firstFireAt).toISOString()}`;
  return "no schedule";
}

interface CronLike {
  runtime?: import("../harness.ts").RuntimeChoice | null;
  id: string;
  title?: string;
  enabled: boolean;
  archived?: boolean;
  schedule: { cron?: string; timezone?: string; everyMs?: number; firstFireAt?: number };
  action?: string;
  message?: string;
  nextFireAt?: number;
  destination?: { type: string; target: string };
  lastFireNote?: { text: string; at: number; by?: string };
  unattendedGrants?: string[];
}

export const SURFACE_ACTIONS = [
  "post",
  "reach",
  "react",
  "edit",
  "delete",
  "read_thread",
  "whats_new",
  "search",
  "read_members",
  "read_file",
] as const;
const LIST_PAGE_SIZE = 25;
export const CRON_ID_ACTIONS = new Set(["get", "runs", "patch", "delete", "disable", "run", "note"]);
export const SENDER_WEBHOOK_SCHEMES = WEBHOOK_SCHEMES.filter(
  (scheme) => scheme !== "hmac-sha256" && scheme !== "google-pubsub",
);
const LIST_PAGE_MAX = 100;
const LIST_TASK_PREVIEW_CHARS = 200;
export const WEBHOOK_ACTION_PREVIEW_CHARS = 2000;

const flatText = (s: string): string => s.replace(/[\s\u0085]+/g, " ").trim();

export function previewText(s: string, max = LIST_TASK_PREVIEW_CHARS): string {
  const f = flatText(s);
  if (f.length <= max) return f;
  let cut = f.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export const previewTrims = (s: string | undefined): boolean =>
  s !== undefined && flatText(s).length > LIST_TASK_PREVIEW_CHARS;

export function listOrder(
  a: { id: string; enabled: boolean; archived?: boolean; createdAt: number },
  b: { id: string; enabled: boolean; archived?: boolean; createdAt: number },
): number {
  const rank = (c: { enabled: boolean; archived?: boolean }): number => {
    if (c.archived) return 2;
    if (c.enabled) return 0;
    return 1;
  };
  return rank(a) - rank(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export function pageOf<T>(
  items: T[],
  opts: { offset?: number; limit?: number },
): { page: T[]; offset: number; note: string | null } {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? LIST_PAGE_SIZE), LIST_PAGE_MAX);
  const page = items.slice(offset, offset + limit);
  const last = offset + page.length;
  if (page.length === 0) return { page, offset, note: `nothing at offset ${offset} — ${items.length} total` };
  if (items.length > last)
    return { page, offset, note: `showing ${offset + 1}–${last} of ${items.length}; next page: offset: ${last}` };
  if (offset > 0) return { page, offset, note: `showing ${offset + 1}–${last} of ${items.length}; end of list` };
  return { page, offset, note: null };
}

export function fmtCronLine(c: CronLike, preview = false): string {
  const body = c.action || c.message;
  let shown: string | undefined;
  if (body) shown = preview ? previewText(body) : body;
  const what = shown ? `${c.action ? "task" : "text"}: ${shown}` : "";
  let state = " [paused]";
  if (c.archived) state = " [archived]";
  else if (c.enabled) state = "";
  const dest = c.destination ? ` → ${c.destination.type}:${c.destination.target}` : "";
  const next = c.nextFireAt ? ` (next ${new Date(c.nextFireAt).toISOString()})` : "";
  const note =
    !preview && c.lastFireNote && Number.isFinite(c.lastFireNote.at)
      ? `\n    shift-change note (${utcMinute(c.lastFireNote.at)}${c.lastFireNote.by ? `, by ${c.lastFireNote.by}` : ""}): ${c.lastFireNote.text}`
      : "";
  const runtime = c.runtime
    ? `\n    runtime: ${c.runtime.modelId}${c.runtime.effortLevel ? ` (${c.runtime.effortLevel})` : ""}`
    : "";
  const grants = c.unattendedGrants?.length ? `\n    unattended grants: ${c.unattendedGrants.join(", ")}` : "";
  return `${c.id}${c.title ? ` "${c.title}"` : ""} — ${fmtCronSchedule(c)}${dest}${state}${next}${what ? `\n    ${what}` : ""}${runtime}${grants}${note}`;
}

export function fmtCronCreated(r: {
  cron: CronLike;
  recipient?: { displayName: string };
  channel?: { name: string };
}): string {
  let to = "";
  if (r.recipient) to = `\nAddressed to ${r.recipient.displayName} (DM).`;
  else if (r.channel) to = `\nAddressed to #${r.channel.name}.`;
  return `Created cron ${fmtCronLine(r.cron)}${to}`;
}

export function fmtCronRunLine(entry: CronFireLogEntry): string {
  let lifecycle: string | null = null;
  if (entry.status === "running") {
    lifecycle = `in flight for ${Math.max(0, Math.round((Date.now() - entry.firedAt) / 60_000))}m`;
  } else if (entry.endedAt !== undefined) {
    lifecycle = `took ${Math.max(0, Math.round((entry.endedAt - entry.firedAt) / 1000))}s`;
  }
  const bits = [
    new Date(entry.firedAt).toISOString(),
    `status=${entry.status ?? "unknown"}`,
    lifecycle,
    `fireKey=${entry.fireKey}`,
    entry.note ? `note=${entry.note}` : null,
    entry.reply ? `reply=${entry.reply}` : null,
  ].filter((bit): bit is string => bit !== null);
  return `- ${bits.join("; ")}`;
}

export const CLIENT_TOOL_DEFAULT_TIMEOUT_MS = 10_000;
export const CLIENT_TOOL_TIMEOUT_TEXT = "The page didn't respond in time. It may have been closed or navigated away.";

export const outsideWorkspace = (path: string): string =>
  `[not in the computer's workspace: ${path}; only workspace files can be read, so copy it there or name it relative to the workspace]`;

export const outboundFilesSchema = Type.Array(
  Type.Union([
    Type.String({ minLength: 1 }),
    Type.Object({ file_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  ]),
  { maxItems: MAX_OUTBOUND_FILES, description: 'Workspace paths or {file_id: "stored Files ID"} objects.' },
);
export const outboundSandboxSchema = Type.Optional(
  Type.String({
    minLength: 1,
    description: "Sandbox for workspace paths.",
  }),
);
export const sandboxSelector = (description: string) => Type.Optional(Type.String({ minLength: 1, description }));
export const FILE_SEND_GUIDANCE =
  "execute, files, skills and apps use the default sandbox when sandbox_id is omitted. Send files with the surface `post` action's `files` if present, else `attach` (workspace paths or {file_id}); background jobs cannot deliver files. ";
