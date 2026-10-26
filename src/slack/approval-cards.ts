import { clip, inlineCode } from "./util.ts";
import { escapeSlackText, slackSectionBlocks } from "./mrkdwn.ts";
import { isObj } from "../util/objects.ts";
import { parseDeliveryTarget } from "./delivery.ts";

export const APPROVAL_ACTION_IDS = ["hilo_allow_once", "hilo_allow_session", "hilo_allow_always", "hilo_deny"] as const;
export type ApprovalActionId = (typeof APPROVAL_ACTION_IDS)[number];

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  originUrl?: string;
}

export interface SlackApprovalMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const APPROVAL_BLOCK_PREFIX = "hilo_approval:";
const INLINE_COMMAND_MAX = 1_800;
const COMMAND_SECTIONS_MAX = 6;

function button(
  text: string,
  actionId: ApprovalActionId,
  value: string,
  style?: "primary" | "danger",
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

export interface ApprovalCardDestination {
  toDm: boolean;
  channelPointer: string;
}

export function approvalCardDestination(threadOnly: boolean): ApprovalCardDestination {
  return threadOnly
    ? { toDm: true, channelPointer: "I sent you a DM to approve before I run that." }
    : { toDm: false, channelPointer: "" };
}

interface ToolCallView {
  label: string;
  tool?: string;
  args: Record<string, unknown>;
}

const ARG_VALUE_MAX = 500;
const DECISION_SUBJECT_MAX = 150;
const DECISION_DETAIL_MAX = 1_500;

function toolCallView(p: { command: string; summary?: string; kind?: string }): ToolCallView | null {
  if (p.kind === "input" || !p.summary || !p.command.startsWith(`${p.summary} {`)) return null;
  let params: unknown;
  try {
    params = JSON.parse(p.command.slice(p.summary.length + 1));
  } catch {
    return null;
  }
  if (!isObj(params) || Array.isArray(params)) return null;
  if (
    params.operation === "invoke" &&
    typeof params.tool === "string" &&
    isObj(params.arguments ?? {}) &&
    !Array.isArray(params.arguments)
  )
    return { label: p.summary, tool: params.tool, args: (params.arguments ?? {}) as Record<string, unknown> };
  return { label: p.summary, args: params };
}

function argText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function argLines(args: Record<string, unknown>): string[] {
  return Object.entries(args).map(([key, value]) => {
    const text = clip(argText(value), ARG_VALUE_MAX);
    return text.includes("\n")
      ? `${escapeSlackText(key)}:\n\`\`\`${escapeSlackText(text.replaceAll("`", "'"))}\`\`\``
      : `${escapeSlackText(key)}: ${inlineCode(escapeSlackText(text))}`;
  });
}

function toolTitle(view: ToolCallView): string {
  return view.tool
    ? `${escapeSlackText(view.label)} · ${inlineCode(escapeSlackText(view.tool))}`
    : inlineCode(escapeSlackText(view.label));
}

export function approvalMessage(approvals: readonly PendingApproval[]): SlackApprovalMessage {
  const items = approvals.length
    ? approvals
    : [{ requestId: "", command: "unknown command", reason: "requires approval" }];
  const describe = (p: (typeof items)[number]): string => {
    if (p.kind === "input") return "My security screen flagged part of this message. Allow it?";
    if (p.purpose) return `Approval needed: ${clip(p.purpose, 400)}`;
    const view = toolCallView(p);
    if (view) return `Approval needed: ${toolTitle(view)}`;
    return `Approval needed before I can run ${inlineCode(p.command)}.`;
  };
  const text = items.map(describe).join("\n");
  const blocks: Array<Record<string, unknown>> = [];
  for (const p of items) {
    const view = toolCallView(p);
    const viewArgs = view ? argLines(view.args) : [];
    let heading = view ? `:lock: *Approval needed:* ${toolTitle(view)}` : ":lock: *Approval needed.*";
    if (p.kind === "input") heading = ":lock: *My security screen flagged part of this message. Allow it?*";
    const lines = [heading];
    if (p.summary && !view) lines.push(clip(p.summary, 400));
    if (p.purpose) lines.push(`*Why:* ${clip(p.purpose, 400)}`);
    const shownArgs = view !== null && viewArgs.join("\n").length <= INLINE_COMMAND_MAX;
    const longText = view ? JSON.stringify(view.args, null, 2) : p.command;
    const longCommand = p.kind !== "input" && !shownArgs && p.command.length > INLINE_COMMAND_MAX;
    const sections = longCommand ? slackSectionBlocks(longText, { code: true }) : [];
    const shown = sections.length <= COMMAND_SECTIONS_MAX;
    const commandHeading = view ? "*Arguments:*" : "*Command:*";
    if (shownArgs) lines.push(...viewArgs);
    else if (longCommand)
      lines.push(
        shown
          ? commandHeading
          : `${commandHeading} too long to show in Slack. Open ${p.originUrl && /^https?:\/\//.test(p.originUrl) ? `<${p.originUrl.replaceAll("|", "%7C").replaceAll(">", "%3E")}|this conversation in QM>` : "this conversation in QM"} on the web to review and approve it.`,
      );
    else if (p.kind !== "input") lines.push(`*Command:* ${inlineCode(p.command)}`);
    lines.push(`*Flagged as:* ${clip(p.reason, 200)}`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clip(lines.join("\n"), 2900) },
    });
    if (longCommand && shown) blocks.push(...sections);
    blocks.push({
      type: "actions",
      block_id: `${APPROVAL_BLOCK_PREFIX}${p.requestId || "unknown"}`.slice(0, 255),
      elements: [
        ...(longCommand && !shown
          ? []
          : [
              button("Allow once", "hilo_allow_once", p.requestId, "primary"),
              ...(p.grantModes?.session === false ? [] : [button("Allow session", "hilo_allow_session", p.requestId)]),
              ...(p.grantModes?.always === false ? [] : [button("Allow always", "hilo_allow_always", p.requestId)]),
            ]),
        button("Deny", "hilo_deny", p.requestId, "danger"),
      ],
    });
  }
  return { text, blocks };
}

type ApprovalDecision = "deny" | "once" | "session" | "always";

export interface ApprovalDecisionRecord {
  decision: ApprovalDecision;
  by?: string;
  at: number;
  state: "pending" | "done";
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  deny: "Denied",
  once: "Allowed once",
  session: "Allowed for this conversation",
  always: "Allowed always",
};

function slackDate(at: number): string {
  const seconds = Math.floor(at / 1000);
  return `<!date^${seconds}^{date_short_pretty} at {time}|${new Date(at).toISOString()}>`;
}

function approvalDecisionLine(
  p: { command: string; summary?: string; kind?: string },
  record: ApprovalDecisionRecord,
): string {
  const view = toolCallView(p);
  let subject = view ? toolTitle(view) : inlineCode(clip(p.command, DECISION_SUBJECT_MAX));
  if (p.kind === "input") subject = "flagged message";
  const by = record.by ? ` by <@${record.by}>` : "";
  if (record.state === "pending")
    return record.decision === "deny"
      ? `:hourglass_flowing_sand: Denying · ${subject}…`
      : `:hourglass_flowing_sand: ${DECISION_LABEL[record.decision]}${by} · ${subject} — running…`;
  const icon = record.decision === "deny" ? ":x:" : ":white_check_mark:";
  return `${icon} ${DECISION_LABEL[record.decision]}${by} · ${subject} · ${slackDate(record.at)}`;
}

function approvalDecisionDetail(p: { command: string; summary?: string; kind?: string }): string | null {
  if (p.kind === "input") return null;
  const view = toolCallView(p);
  if (view) {
    const entries = Object.entries(view.args);
    if (!entries.length) return null;
    return clip(
      entries.map(([key, value]) => `${escapeSlackText(key)}: ${escapeSlackText(argText(value))}`).join(" · "),
      DECISION_DETAIL_MAX,
    );
  }
  return p.command.length > DECISION_SUBJECT_MAX ? inlineCode(clip(p.command, DECISION_DETAIL_MAX)) : null;
}

export function approvalDecisionMessage(
  p: { command: string; summary?: string; kind?: string },
  record: ApprovalDecisionRecord,
  extra: string[] = [],
): SlackApprovalMessage {
  const line = approvalDecisionLine(p, record);
  const detail = approvalDecisionDetail(p);
  return {
    text: [line, ...extra].join("\n"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: clip([line, ...extra].join("\n"), 2900) } },
      ...(detail ? [{ type: "context", elements: [{ type: "mrkdwn", text: detail }] }] : []),
    ],
  };
}

export interface StoredApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  request?: Record<string, unknown>;
}

export interface RecoveredApprovalContext {
  requesterId: string;
  channel: string;
  replyThreadTs?: string;
  threadOnly: boolean;
  approvalChannel: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  turn: Record<string, unknown>;
}

export function recoveredApprovalContext(
  stored: Pick<StoredApproval, "command" | "reason" | "purpose" | "summary" | "kind" | "grantModes" | "request">,
  click: { channel: string; threadTs?: string },
): RecoveredApprovalContext | null {
  const req = stored.request as
    | (Record<string, unknown> & {
        actor?: { externalId?: unknown };
        conversation?: { kind?: unknown };
        deliveryTarget?: unknown;
      })
    | undefined;
  if (!req || typeof req.actor?.externalId !== "string" || typeof req.text !== "string") return null;
  const kind = req.conversation?.kind;
  if (kind !== "dm" && kind !== "channel" && kind !== "group") return null;
  const {
    surface: _surface,
    async: _async,
    idempotencyKey: _idempotencyKey,
    redeliveryKey: _redeliveryKey,
    approval: _approval,
    relayInput: _relayInput,
    ...turn
  } = req;
  const origin =
    typeof req.deliveryTarget === "string" && req.deliveryTarget
      ? parseDeliveryTarget(req.deliveryTarget)
      : { channel: click.channel, ...(click.threadTs ? { threadTs: click.threadTs } : {}) };
  return {
    requesterId: req.actor.externalId,
    channel: origin.channel,
    ...(origin.threadTs ? { replyThreadTs: origin.threadTs } : {}),
    threadOnly: kind === "channel",
    approvalChannel: click.channel,
    command: stored.command,
    reason: stored.reason ?? "requires approval",
    ...(stored.purpose ? { purpose: stored.purpose } : {}),
    ...(stored.summary ? { summary: stored.summary } : {}),
    ...(stored.kind ? { kind: stored.kind } : {}),
    ...(stored.grantModes ? { grantModes: stored.grantModes } : {}),
    turn,
  };
}

type ApprovalBegin<T> = { state: "missing" } | { state: "busy" } | { state: "ready"; ctx: T };

export interface ApprovalRegistry<T> {
  remember(id: string, ctx: T): void;
  get(id: string): T | undefined;
  busy(id: string): boolean;
  begin(id: string): ApprovalBegin<T>;
  settle(id: string): void;
  release(id: string): void;
}

export function createApprovalRegistry<T>(): ApprovalRegistry<T> {
  const pending = new Map<string, { ctx: T; inFlight: boolean }>();
  return {
    remember(id, ctx) {
      pending.set(id, { ctx, inFlight: false });
    },
    get(id) {
      return pending.get(id)?.ctx;
    },
    busy(id) {
      return pending.get(id)?.inFlight === true;
    },
    begin(id) {
      const entry = pending.get(id);
      if (!entry) return { state: "missing" };
      if (entry.inFlight) return { state: "busy" };
      entry.inFlight = true;
      return { state: "ready", ctx: entry.ctx };
    },
    settle(id) {
      pending.delete(id);
    },
    release(id) {
      const entry = pending.get(id);
      if (entry) entry.inFlight = false;
    },
  };
}
