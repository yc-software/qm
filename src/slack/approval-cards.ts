import { clip, inlineCode } from "./util.ts";
import { parseDeliveryTarget } from "./delivery.ts";
import type { AgentRequestActionId } from "./agent-requests.ts";
import { MESSAGE_APPROVAL_LIMITS, type MessageApprovalCardView } from "../core/message-approval.ts";

export type ApprovalActionId = "hilo_allow_once" | "hilo_allow_session" | "hilo_allow_always" | "hilo_deny";
export type MessageApprovalActionId = "message_approval_approve" | "message_approval_edit" | "message_approval_reject";

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  blocksInput?: boolean;
}

export interface SlackApprovalMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const APPROVAL_BLOCK_PREFIX = "hilo_approval:";

export function button(
  text: string,
  actionId: ApprovalActionId | AgentRequestActionId | MessageApprovalActionId,
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

function encodeMessageApprovalAction(record: Pick<MessageApprovalCardView, "id" | "version">): string {
  return `${record.id}:${record.version}`;
}

export function decodeMessageApprovalAction(value: unknown): { id: string; version: number } | null {
  const match = /^([^:]+):(\d+)$/.exec(String(value ?? ""));
  if (!match) return null;
  const version = Number(match[2]);
  if (match[1]!.length > 200 || !Number.isSafeInteger(version) || version < 1) return null;
  return { id: match[1]!, version };
}

function plainTextSections(text: string): Array<Record<string, unknown>> {
  const characters = Array.from(text);
  const blocks: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < characters.length; offset += 3000) {
    blocks.push({
      type: "section",
      text: { type: "plain_text", text: characters.slice(offset, offset + 3000).join(""), emoji: false },
    });
  }
  return blocks;
}

export function messageApprovalMessage(record: MessageApprovalCardView): SlackApprovalMessage {
  const blocks: Array<Record<string, unknown>> = [
    ...plainTextSections(record.title),
    ...plainTextSections(`Recipient\n${record.recipient}`),
    ...plainTextSections(`Subject\n${record.subject ?? "None"}`),
    ...plainTextSections("Message"),
    ...plainTextSections(record.body),
  ];
  const value = encodeMessageApprovalAction(record);
  if (record.state === "pending") {
    blocks.push({
      type: "actions",
      block_id: `message_approval:${record.id}:${record.version}`.slice(0, 255),
      elements: [
        button("Approve draft", "message_approval_approve", value, "primary"),
        button("Edit and approve draft", "message_approval_edit", value),
        button("Reject", "message_approval_reject", value, "danger"),
      ],
    });
    return { text: `Draft approval needed: ${record.title}`, blocks };
  }
  let status = "Draft approved; continuation queued.\nContinuing in the original conversation.";
  if (record.continuationStatus === "running") {
    status = "Draft approved; continuation running.\nContinuing in the original conversation.";
  }
  if (record.continuationStatus === "waiting") {
    status = "Draft approved; continuation waiting for an explicit command approval in the original conversation.";
  }
  if (record.continuationStatus === "completed") {
    status = "Draft approved; continuation completed.\nContinuing in the original conversation.";
  }
  if (record.continuationUnconfirmed) {
    status = "Draft approved; QM could not confirm the operation and manual reconciliation is required.";
  } else if (record.continuationStatus === "failed" || record.state === "failed") {
    status = "Draft approved; continuation failed.\nContinuing in the original conversation was not completed.";
  }
  if (record.state === "rejected") status = "Rejected.";
  if (record.state === "expired") status = "Draft approval expired.";
  blocks.push(...plainTextSections(`Status\n${status}`));
  return { text: `${record.title}: ${status}`, blocks };
}

export function messageApprovalEditModal(record: MessageApprovalCardView): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "message_approval_edit",
    private_metadata: encodeMessageApprovalAction(record),
    title: { type: "plain_text", text: "Edit draft" },
    submit: { type: "plain_text", text: "Approve draft" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "recipient",
        label: { type: "plain_text", text: "Recipient" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: record.recipient,
          max_length: MESSAGE_APPROVAL_LIMITS.recipient,
        },
      },
      {
        type: "input",
        block_id: "subject",
        optional: true,
        label: { type: "plain_text", text: "Subject" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(record.subject ? { initial_value: record.subject } : {}),
          max_length: MESSAGE_APPROVAL_LIMITS.subject,
        },
      },
      {
        type: "input",
        block_id: "body",
        label: { type: "plain_text", text: "Message" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: record.body,
          max_length: MESSAGE_APPROVAL_LIMITS.body,
        },
      },
    ],
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
  matched?: string;
  purpose?: string;
  summary?: string;
  summaryDetail?: string;
  approvalKey?: string;
  grantModes?: { session: boolean; always: boolean };
  blocksInput?: boolean;
  kind?: "approval" | "input";
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
  grantModes?: { session: boolean; always: boolean };
  blocksInput?: boolean;
  kind?: "approval" | "input";
  turn: Record<string, unknown>;
}

export function recoveredApprovalContext(
  stored: Pick<
    StoredApproval,
    "command" | "reason" | "purpose" | "summary" | "grantModes" | "blocksInput" | "kind" | "request"
  >,
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
    ...(stored.grantModes ? { grantModes: structuredClone(stored.grantModes) } : {}),
    ...(stored.blocksInput === undefined ? {} : { blocksInput: stored.blocksInput }),
    ...(stored.kind ? { kind: stored.kind } : {}),
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
