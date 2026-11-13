import type { App } from "../../api/app-types.ts";
import { userFacingFailureClause } from "../../core/failure-copy.ts";
import type { KeychainApprovalView, KeychainApprovals } from "../../credentials/keychain-approval.ts";
import { samePerson } from "../../directory/person.ts";
import { isSystemActor, type ActorAssertion, type Delivery, type Destination, type TurnRequest } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import { headSlice } from "../../util/text.ts";
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
  toolCallView,
  type ApprovalDecision,
  type CardButton,
  type PendingApproval,
} from "../approval-cards.ts";
import type { SurfaceAction } from "../contract.ts";
import type { PartnerChatClient } from "./client.ts";
import { editPartnerChatMessage, postPartnerChatMessage } from "./messages.ts";
import { parsePartnerChatRef } from "./protocol.ts";

const DETAIL_MAX = 12_000;
const SUBJECT_MAX = 150;

type ApprovalSubject = Pick<PendingApproval, "command" | "summary" | "kind">;

interface Card {
  body: string;
  actions: SurfaceAction[];
}

export interface PartnerChatCard extends Card {
  key: string;
  resolved?: true;
}

export interface PartnerChatActionClick {
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

function surfaceAction(button: CardButton): SurfaceAction {
  return {
    id: `${button.actionId}:${encodeURIComponent(button.value)}`,
    label: button.label,
    style: button.style ?? "default",
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
  return `\`${text.replaceAll("`", "'").replace(/\s+/g, " ")}\``;
}

function block(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
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

function commandApprovalCard(p: PendingApproval): Card {
  const title = toolTitle(p);
  let heading = title ? `🔒 **Approval needed:** ${title}` : "🔒 **Approval needed.**";
  if (p.kind === "input") heading = "🔒 **My security screen flagged part of this message. Allow it?**";
  const detail = commandDetail(p);
  const reviewable = detail.length <= DETAIL_MAX;
  const lines = [
    heading,
    p.summary && !title ? headSlice(p.summary, 400) : "",
    p.purpose ? `**Why:** ${headSlice(p.purpose, 400)}` : "",
    reviewable ? detail : "**Command:** too long to show here, so it can only be denied from this chat.",
    `**Flagged as:** ${headSlice(p.reason, 200)}`,
  ];
  return { body: lines.filter(Boolean).join("\n\n"), actions: approvalButtons(p, reviewable).map(surfaceAction) };
}

function commandDecisionBody(p: ApprovalSubject, decision: ApprovalDecision, by?: string): string {
  const subject = p.kind === "input" ? "flagged message" : (toolTitle(p) ?? inline(headSlice(p.command, SUBJECT_MAX)));
  const who = by ? ` by ${by}` : "";
  return `${decision === "deny" ? "" : "✅ "}${APPROVAL_DECISION_LABEL[decision]}${who} · ${subject}`;
}

function keychainCard(view: KeychainApprovalView): Card {
  const { pending, duration, status } = keychainCardWording(view);
  const summary = `Use your **${headSlice(view.service, 150)}** credential in ${view.conversation}${duration}.`;
  return {
    body: `${pending ? "🔒 **Approval needed.**" : `**${status}**`}\n\n${summary}`,
    actions: pending ? keychainButtons(view.ask).map(surfaceAction) : [],
  };
}

export function partnerChatApprovalCardRoute(request: TurnRequest): Destination | undefined {
  const ref = request.deliveryTarget ? parsePartnerChatRef(request.deliveryTarget) : null;
  if (!ref || !request.liveReplies || isSystemActor(request.actor.externalId)) return undefined;
  return {
    type: "partner-chat",
    target: request.deliveryTarget!,
    account: { id: ref.account, workspace: ref.account },
  };
}

export async function partnerChatCard(
  deps: { app: Pick<App, "getApproval">; keychainApprovals?: Pick<KeychainApprovals, "card"> },
  d: Pick<Delivery, "destination" | "idempotencyKey">,
): Promise<PartnerChatCard | null | undefined> {
  const { commandApprovalId, keychainAskId } = d.destination;
  if (commandApprovalId) {
    const record = await deps.app.getApproval(commandApprovalId);
    if (!record || d.idempotencyKey !== approvalDeliveryKey(commandApprovalId, record)) return null;
    return {
      ...commandApprovalCard({ ...record, requestId: commandApprovalId, reason: record.reason ?? "Approval required" }),
      key: d.idempotencyKey,
    };
  }
  if (keychainAskId) {
    const view = await deps.keychainApprovals?.card(keychainAskId);
    if (!view) return null;
    const key = `ask:${keychainAskId}:notice`;
    return { ...keychainCard(view), key, ...(d.idempotencyKey === key ? {} : { resolved: true as const }) };
  }
  return undefined;
}

export function createPartnerChatApprovals(deps: {
  client: PartnerChatClient;
  app: Pick<App, "turn" | "getApproval" | "ingestSurfaceEvents" | "readSurfaceMessages">;
  keychainApprovals?: Pick<KeychainApprovals, "decide">;
}) {
  async function invoke(click: PartnerChatActionClick): Promise<void> {
    const parsed = parseAction(click.actionId);
    if (!parsed) return;
    const where = { account: click.account, kind: click.kind, chat: click.chat };
    const settle = (card: Card): Promise<void> =>
      editPartnerChatMessage(deps, where, click.messageId, card.body, card.actions);
    const tell = async (text: string): Promise<void> => {
      await postPartnerChatMessage(
        deps,
        { ...where, ...(click.thread ? { thread: click.thread } : {}) },
        { text, idempotencyKey: `action:${click.eventId}`, recipientUserId: click.userId },
      );
    };

    const command = APPROVAL_ACTION_IDS.find((id) => id === parsed.actionId);
    if (command) {
      const record = await deps.app.getApproval(parsed.value);
      const request = record?.request;
      const ref = request?.deliveryTarget ? parsePartnerChatRef(request.deliveryTarget) : null;
      if (!record || !request || ref?.account !== click.account || ref.chat !== click.chat)
        return settle({ body: `_${APPROVAL_EXPIRED}_`, actions: [] });
      if (!samePerson(request.actor.externalId, click.actor.externalId)) return tell(APPROVAL_REQUESTER_ONLY);
      const decision = approvalDecision(command);
      const {
        idempotencyKey: _idempotencyKey,
        redeliveryKey: _redeliveryKey,
        approval: _approval,
        ...replay
      } = request;
      const queued = await deps.app.turn({
        ...replay,
        actor: click.actor,
        approval: {
          requestId: parsed.value,
          approved: decision !== "deny",
          ...(decision !== "deny" ? { scope: decision } : {}),
        },
        async: true,
        idempotencyKey: `partner-chat:action:${click.eventId}`,
      });
      if (!queued.runId && queued.status === "pending_approval")
        return tell(
          `${queued.reason ?? AWAITING_APPROVAL} This approval stays pending; try again once the conversation is unblocked.`,
        );
      const line = commandDecisionBody(record, decision, click.actor.displayName);
      return settle({
        body: queued.runId ? line : `${line}\n\nI can't continue — ${userFacingFailureClause(queued)}.`,
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
    return settle(keychainCard(view));
  }

  return { invoke };
}
