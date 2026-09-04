import { clip, inlineCode } from "./util.ts";
import { parseDeliveryTarget } from "./delivery.ts";
import type { AgentRequestActionId } from "./agent-requests.ts";

export type ApprovalActionId = "hilo_allow_once" | "hilo_allow_session" | "hilo_allow_always" | "hilo_deny";

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
}

export interface SlackApprovalMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const APPROVAL_BLOCK_PREFIX = "hilo_approval:";

export function button(
  text: string,
  actionId: ApprovalActionId | AgentRequestActionId,
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

export function approvalMessage(approvals: readonly PendingApproval[]): SlackApprovalMessage {
  const items = approvals.length
    ? approvals
    : [{ requestId: "", command: "unknown command", reason: "requires approval" }];
  const describe = (p: (typeof items)[number]): string => {
    if (p.kind === "input") return "My security screen flagged part of this message. Allow it?";
    if (p.purpose) return `Approval needed: ${clip(p.purpose, 400)}`;
    return `Approval needed before I can run ${inlineCode(p.command)}.`;
  };
  const text = items.map(describe).join("\n");
  const blocks: Array<Record<string, unknown>> = [];
  for (const p of items) {
    const lines = [
      p.kind === "input"
        ? ":lock: *My security screen flagged part of this message. Allow it?*"
        : ":lock: *Approval needed.*",
    ];
    if (p.summary) lines.push(clip(p.summary, 400));
    if (p.purpose) lines.push(`*Why:* ${clip(p.purpose, 400)}`);
    if (p.kind !== "input") lines.push(`*Command:* ${inlineCode(p.command)}`);
    lines.push(`*Flagged as:* ${clip(p.reason, 200)}`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clip(lines.join("\n"), 2900) },
    });
    blocks.push({
      type: "actions",
      block_id: `${APPROVAL_BLOCK_PREFIX}${p.requestId || "unknown"}`.slice(0, 255),
      elements: [
        button("Allow once", "hilo_allow_once", p.requestId, "primary"),
        ...(p.grantModes?.session === false ? [] : [button("Allow session", "hilo_allow_session", p.requestId)]),
        ...(p.grantModes?.always === false ? [] : [button("Allow always", "hilo_allow_always", p.requestId)]),
        button("Deny", "hilo_deny", p.requestId, "danger"),
      ],
    });
  }
  return { text, blocks };
}

export interface StoredApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
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
  turn: Record<string, unknown>;
}

export function recoveredApprovalContext(
  stored: Pick<StoredApproval, "command" | "reason" | "purpose" | "summary" | "request">,
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
    approval: _approval,
    relayInput: _relayInput,
    intakePreambleMs: _intakePreambleMs,
    clientSentAt: _clientSentAt,
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
    turn,
  };
}

type ApprovalBegin<T> = { state: "missing" } | { state: "busy" } | { state: "ready"; ctx: T };

export interface ApprovalRegistry<T> {
  remember(id: string, ctx: T): void;
  get(id: string): T | undefined;
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
