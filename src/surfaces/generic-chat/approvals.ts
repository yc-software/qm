import type { App } from "../../api/app-types.ts";
import { userFacingFailureClause } from "../../core/failure-copy.ts";
import type { KeychainApprovalView, KeychainApprovals } from "../../credentials/keychain-approval.ts";
import { samePerson } from "../../directory/person.ts";
import { automationDestination } from "../../core/turn-origin.ts";
import { isSystemActor, type ActorAssertion, type Delivery, type Destination, type TurnRequest } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import {
  APPROVAL_ACTION_IDS,
  APPROVAL_DECISION_LABEL,
  APPROVAL_EXPIRED,
  APPROVAL_REQUESTER_ONLY,
  AWAITING_APPROVAL,
  KEYCHAIN_ACTION_IDS,
  approvalButtons,
  approvalDecision,
  approvalDeliveryKey,
  argText,
  keychainButtons,
  keychainCardWording,
  keychainDecision,
  replayableTurn,
  toolCallView,
  type ApprovalDecision,
  type CardButton,
  type PendingApproval,
} from "../approval-cards.ts";
import type { SurfaceAction } from "../contract.ts";
import type { GenericChatClient } from "./client.ts";
import { editGenericChatMessage, postGenericChatMessage } from "./messages.ts";
import { GENERIC_CHAT, genericChatUserIds, parseGenericChatAccount, parseGenericChatRef } from "./protocol.ts";

type ApprovalSubject = Pick<PendingApproval, "command" | "summary" | "kind">;

interface Card {
  body: string;
  actions: SurfaceAction[];
}

export interface GenericChatCard extends Card {
  key: string;
  resolved?: true;
}

export interface GenericChatActionClick {
  eventId: string;
  account: string;
  kind: "group" | "dm";
  chat: string;
  thread?: string;
  messageId: string;
  actionId: string;
  userId: string;
  actor: ActorAssertion;
}

function surfaceAction(button: CardButton, userIds: string[] | undefined): SurfaceAction {
  return {
    id: `${button.actionId}:${encodeURIComponent(button.value)}`,
    label: button.label,
    style: button.style ?? "default",
    ...(userIds ? { userIds } : {}),
  };
}

function parseAction(id: string): { actionId: string; value: string } | undefined {
  const colon = id.indexOf(":");
  if (colon < 1) return undefined;
  try {
    return { actionId: id.slice(0, colon), value: decodeURIComponent(id.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

function inline(text: string): string {
  const line = text
    .replaceAll("`", "'")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return `\`${line}\``;
}

function block(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}\n${text}\n${fence}`;
}

function toolTitle(p: ApprovalSubject): string | undefined {
  const view = toolCallView(p);
  if (!view) return undefined;
  return view.tool ? `${view.label} · ${inline(view.tool)}` : inline(view.label);
}

function commandDetail(p: ApprovalSubject): string {
  if (p.kind === "input") return "";
  const view = toolCallView(p);
  if (!view) return `**Command:**\n${block(p.command)}`;
  return Object.entries(view.args)
    .map(([key, value]) => {
      const text = argText(value);
      return text.includes("\n") ? `${key}:\n${block(text)}` : `${key}: ${inline(text)}`;
    })
    .join("\n");
}

function commandApprovalCard(p: PendingApproval, userIds: string[] | undefined): Card {
  const title = toolTitle(p);
  let heading = title ? `🔒 **Approval needed:** ${title}` : "🔒 **Approval needed.**";
  if (p.kind === "input") heading = "🔒 **My security screen flagged part of this message. Allow it?**";
  const lines = [
    heading,
    p.summary && !title ? p.summary : "",
    p.purpose ? `**Why:** ${p.purpose}` : "",
    commandDetail(p),
    `**Flagged as:** ${p.reason}`,
  ];
  return {
    body: lines.filter(Boolean).join("\n\n"),
    actions: approvalButtons(p).map((b) => surfaceAction(b, userIds)),
  };
}

function commandDecisionBody(p: ApprovalSubject, decision: ApprovalDecision, by?: string): string {
  const subject = p.kind === "input" ? "flagged message" : (toolTitle(p) ?? inline(p.command));
  const who = by ? ` by ${by}` : "";
  return `${decision === "deny" ? "" : "✅ "}${APPROVAL_DECISION_LABEL[decision]}${who} · ${subject}`;
}

function keychainCard(view: KeychainApprovalView, account: string | undefined): Card {
  const { pending, duration, status } = keychainCardWording(view);
  const summary = `Use your **${view.service}** credential in ${view.conversation}${duration}.`;
  return {
    body: `${pending ? "🔒 **Approval needed.**" : `**${status}**`}\n\n${summary}`,
    actions: pending
      ? keychainButtons(view.ask).map((b) =>
          surfaceAction(b, account ? genericChatUserIds(view.ask.ownerSurfaceUser, account) : undefined),
        )
      : [],
  };
}

export function genericChatApprovalCardRoute(request: TurnRequest): Destination | undefined {
  if (isSystemActor(request.actor.externalId)) return undefined;
  const dest = automationDestination(request);
  if (dest?.type === GENERIC_CHAT) return dest;
  const ref = request.deliveryTarget ? parseGenericChatRef(request.deliveryTarget) : null;
  if (!ref || !request.liveReplies) return undefined;
  return {
    type: GENERIC_CHAT,
    target: request.deliveryTarget!,
    account: { id: ref.account, workspace: ref.account },
  };
}

export async function genericChatCard(
  deps: { app: Pick<App, "getApproval">; keychainApprovals?: Pick<KeychainApprovals, "card"> },
  d: Pick<Delivery, "destination" | "idempotencyKey">,
): Promise<GenericChatCard | null | undefined> {
  const { commandApprovalId, keychainAskId } = d.destination;
  const account = parseGenericChatRef(d.destination.target)?.account;
  if (commandApprovalId) {
    const record = await deps.app.getApproval(commandApprovalId);
    if (!record || d.idempotencyKey !== approvalDeliveryKey(commandApprovalId, record)) return null;
    const userIds = account ? genericChatUserIds(record.request?.surfaceOrigin?.author, account) : undefined;
    return {
      ...commandApprovalCard(
        { ...record, requestId: commandApprovalId, reason: record.reason ?? "Approval required" },
        userIds,
      ),
      key: d.idempotencyKey,
    };
  }
  if (keychainAskId) {
    const view = await deps.keychainApprovals?.card(keychainAskId);
    if (!view) return null;
    const key = `ask:${keychainAskId}:notice`;
    return { ...keychainCard(view, account), key, ...(d.idempotencyKey === key ? {} : { resolved: true as const }) };
  }
  return undefined;
}

export function createGenericChatApprovals(deps: {
  client: GenericChatClient;
  app: Pick<App, "turn" | "getApproval" | "ingestSurfaceEvents" | "readSurfaceMessages">;
  keychainApprovals?: Pick<KeychainApprovals, "decide">;
}) {
  async function invoke(click: GenericChatActionClick): Promise<void> {
    const parsed = parseAction(click.actionId);
    if (!parsed) return;
    const eventId = parseGenericChatAccount(click.account)?.origin
      ? `${click.account}:${click.eventId}`
      : click.eventId;
    const where = { account: click.account, kind: click.kind, chat: click.chat };
    const settle = (card: Card): Promise<void> =>
      editGenericChatMessage(deps, where, click.messageId, card.body, card.actions);
    const tell = async (text: string): Promise<void> => {
      await postGenericChatMessage(
        deps,
        { ...where, ...(click.thread ? { thread: click.thread } : {}) },
        { text, idempotencyKey: `action:${eventId}`, recipientUserId: click.userId },
      );
    };

    const command = APPROVAL_ACTION_IDS.find((id) => id === parsed.actionId);
    if (command) {
      const record = await deps.app.getApproval(parsed.value);
      const request = record?.request;
      const dest = request ? automationDestination(request) : undefined;
      const target = request?.deliveryTarget ?? (dest?.type === GENERIC_CHAT ? dest.target : undefined);
      const ref = target ? parseGenericChatRef(target) : null;
      if (!record || !request || ref?.account !== click.account || ref.chat !== click.chat)
        return settle({ body: `_${APPROVAL_EXPIRED}_`, actions: [] });
      if (!samePerson(request.actor.externalId, click.actor.externalId)) return tell(APPROVAL_REQUESTER_ONLY);
      const decision = approvalDecision(command);
      const queued = await deps.app.turn({
        ...replayableTurn(request),
        surface: request.surface,
        actor: click.actor,
        approval: {
          requestId: parsed.value,
          approved: decision !== "deny",
          ...(decision !== "deny" ? { scope: decision } : {}),
        },
        async: true,
        idempotencyKey: `${GENERIC_CHAT}:action:${eventId}`,
      });
      if (!queued.runId && queued.status === "pending_approval")
        return tell(
          `${queued.reason ?? AWAITING_APPROVAL} This approval stays pending; try again once the conversation is unblocked.`,
        );
      const line = commandDecisionBody(record, decision, click.actor.displayName);
      return settle({
        body:
          queued.runId || queued.status === "queued"
            ? line
            : `${line}\n\nI can't continue — ${userFacingFailureClause(queued)}.`,
        actions: [],
      });
    }

    const keychain = KEYCHAIN_ACTION_IDS.find((id) => id === parsed.actionId);
    if (!keychain) return;
    if (!deps.keychainApprovals)
      return tell("Couldn't complete this approval: approvals aren't available right now. Try again shortly.");
    let view: KeychainApprovalView;
    try {
      view = await deps.keychainApprovals.decide(parsed.value, click.actor, keychainDecision(keychain));
    } catch (error) {
      return tell(`Couldn't complete this approval: ${errMessage(error)} You can try the button again.`);
    }
    return settle(keychainCard(view, click.account));
  }

  return { invoke };
}
