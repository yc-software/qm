import { isObj } from "../util/objects.ts";
import { parseScopeId, type PendingApprovalRecord } from "../types.ts";
import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";

export const APPROVAL_ACTION_IDS = ["hilo_allow_once", "hilo_allow_session", "hilo_allow_always", "hilo_deny"] as const;
export type ApprovalActionId = (typeof APPROVAL_ACTION_IDS)[number];

export const KEYCHAIN_ACTION_IDS = ["keychain_allow_once", "keychain_allow_always", "keychain_deny"] as const;
export type KeychainActionId = (typeof KEYCHAIN_ACTION_IDS)[number];

export const APPROVAL_EXPIRED =
  "That approval request expired or was withdrawn — let me know when you want to try again.";
export const APPROVAL_REQUESTER_ONLY = "Only the person who requested this command can approve or deny it.";
export const AWAITING_APPROVAL = "This conversation is waiting on a pending approval.";

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

export interface CardButton {
  actionId: string;
  value: string;
  label: string;
  style?: "primary" | "danger";
}

export function approvalButtons(p: Pick<PendingApproval, "requestId" | "grantModes">, reviewable = true): CardButton[] {
  const allow: CardButton[] = [
    { actionId: "hilo_allow_once", value: p.requestId, label: "Allow once", style: "primary" },
    ...(p.grantModes?.session === false
      ? []
      : [{ actionId: "hilo_allow_session", value: p.requestId, label: "Allow session" }]),
    ...(p.grantModes?.always === false
      ? []
      : [{ actionId: "hilo_allow_always", value: p.requestId, label: "Allow always" }]),
  ];
  return [...(reviewable ? allow : []), { actionId: "hilo_deny", value: p.requestId, label: "Deny", style: "danger" }];
}

type ReplayedFields = "surface" | "async" | "idempotencyKey" | "redeliveryKey" | "approval";

export function replayableTurn<T extends object>(request: T): Omit<T, ReplayedFields> {
  const {
    surface: _surface,
    async: _async,
    idempotencyKey: _idempotencyKey,
    redeliveryKey: _redeliveryKey,
    approval: _approval,
    ...turn
  } = request as T & Partial<Record<ReplayedFields, unknown>>;
  return turn;
}

export type ApprovalDecision = "deny" | "once" | "session" | "always";

export function approvalDecision(actionId: ApprovalActionId): ApprovalDecision {
  if (actionId === "hilo_allow_once") return "once";
  if (actionId === "hilo_allow_session") return "session";
  if (actionId === "hilo_allow_always") return "always";
  return "deny";
}

export interface ApprovalDecisionRecord {
  decision: ApprovalDecision;
  by?: string;
  at: number;
  state: "pending" | "done";
}

export const APPROVAL_DECISION_LABEL: Record<ApprovalDecision, string> = {
  deny: "Denied",
  once: "Allowed once",
  session: "Allowed for this conversation",
  always: "Allowed always",
};

export interface ToolCallView {
  label: string;
  tool?: string;
  args: Record<string, unknown>;
}

export function toolCallView(p: { command: string; summary?: string; kind?: string }): ToolCallView | null {
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

export function argText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function keychainButtons(ask: { id: string; requestedMode?: "once" | "standing" }): CardButton[] {
  const once: CardButton = { actionId: "keychain_allow_once", value: ask.id, label: "Allow once" };
  const always: CardButton = { actionId: "keychain_allow_always", value: ask.id, label: "Allow" };
  const [first, second] = ask.requestedMode === "once" ? [once, always] : [always, once];
  return [
    { ...first!, style: "primary" },
    second!,
    { actionId: "keychain_deny", value: ask.id, label: "Deny", style: "danger" },
  ];
}

export function keychainDecision(actionId: KeychainActionId): "once" | "standing" | "deny" {
  if (actionId === "keychain_allow_once") return "once";
  return actionId === "keychain_allow_always" ? "standing" : "deny";
}

export function keychainCardWording(view: KeychainApprovalView): {
  pending: boolean;
  duration: string;
  status: string;
} {
  const { ask } = view;
  const pending = ask.status === "pending";
  const { kind } = parseScopeId(ask.requesterScopeId);
  let audience = "this group";
  if (kind === "personal") audience = "your personal conversations";
  if (kind === "channel") audience = "this channel";
  const standing = `ongoing access across ${audience}`;
  const duration = pending ? ` (${ask.requestedMode === "once" ? "one-time access" : standing})` : "";
  let status = "This request expired.";
  if (ask.status === "approved") status = `Approved — ${view.mode === "standing" ? standing : "one-time access"}.`;
  if (ask.status === "declined") status = "Denied.";
  return { pending, duration, status };
}
