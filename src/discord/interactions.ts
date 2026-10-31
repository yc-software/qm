import type { CoreTurnBody, SurfaceCoreClient } from "../api/surface-core-client.ts";
import { approvalContinuation, approvalDeniedReason } from "../core/approval-continuation.ts";
import { samePerson } from "../directory/person.ts";
import type { ActorAssertion, Delivery, TurnResult } from "../types.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import { APPROVAL_EXPIRED_TEXT, keychainSettleText, parseCardCustomId, type CardKind } from "./approval-cards.ts";
import { DISCORD_DM_DELIVERY_TYPE, DISCORD_SURFACE, recipientDiscordId } from "./config.ts";
import { audienceWith, type ReaderResult } from "./readers.ts";
import { GENERIC_FAILURE_TEXT } from "../../plugins/chassis/src/failure-copy.ts";
import { refusalText } from "./turn-flow.ts";

const ONLY_REQUESTER_TEXT = "Only the person who requested this command can approve or deny it.";
const NOT_INTERNAL_TEXT = "Only people in the organization can decide this.";
const STALE_BUTTON_TEXT = "This button is no longer valid.";
const BUSY_TEXT = "Already working on that decision.";
const READERS_UNKNOWN_CLICK_TEXT =
  "I can't confirm who can read that conversation right now. Try the button again in a minute.";
const CONTINUE_FAILED_TEXT = "I couldn't continue that yet. The card is still active, so try again.";
const RETRY_PENDING_TEXT = "The request is still pending; use the web link in the thread to retry.";
const KEYCHAIN_DECISION = { once: "once", standing: "standing", deny: "deny" } as const;

export interface ButtonClick {
  customId: string;
  userId: string;
  defer(): Promise<void>;
  refuse(content: string): Promise<void>;
  settle(content: string): Promise<void>;
  settleFinal(content: string): Promise<void>;
}

export interface InteractionDeps {
  core: Pick<SurfaceCoreClient, "getDelivery" | "getApproval" | "decideDeploymentAccess" | "keychainApprovals"> & {
    discordUserIdsFor(principalId: string): string[];
  };
  classifyUser(userId: string): Promise<ActorAssertion | null>;
  readersOf(baseChannelId: string): Promise<ReaderResult>;
  continueTurn(
    body: CoreTurnBody,
    hooks: { onAccepted: () => Promise<void>; onSettled: (result: TurnResult) => Promise<void> },
  ): Promise<void>;
}

function kindOf(d: Delivery): CardKind | null {
  if (d.destination.commandApprovalId) return "cmd";
  if (d.destination.keychainAskId) return "key";
  if (d.destination.deploymentAccess) return "dep";
  return null;
}

function subjectOf(d: Delivery): string {
  return d.destination.commandApprovalId ?? d.destination.keychainAskId ?? d.id;
}

export function createInteractionHandler(deps: InteractionDeps): (click: ButtonClick) => Promise<void> {
  const busy = new Set<string>();

  async function command(d: Delivery, action: string, actor: ActorAssertion, click: ButtonClick): Promise<void> {
    const approval = await deps.core.getApproval(d.destination.commandApprovalId!);
    if (!approval) return click.settle(APPROVAL_EXPIRED_TEXT);
    if (approval.request?.surface !== DISCORD_SURFACE) return click.refuse(STALE_BUTTON_TEXT);
    const requester = (approval.request?.actor as { externalId?: string } | undefined)?.externalId;
    if (!samePerson(actor.externalId, requester)) return click.refuse(ONLY_REQUESTER_TEXT);
    const turn = approvalContinuation(approval.request);
    if (!turn) return click.settle(APPROVAL_EXPIRED_TEXT);
    const conversation = turn.conversation as CoreTurnBody["conversation"];
    let audience = conversation.audience;
    if (conversation.kind !== "dm") {
      const readers = await deps.readersOf(conversation.channelRef ?? "");
      if (!readers.ok) return click.refuse(READERS_UNKNOWN_CLICK_TEXT);
      audience = audienceWith(readers.readers, actor);
    }
    const approved = action !== "deny";
    const quoted = `\`${approval.command}\``;
    let accepted = false;
    const finalText = async (result: TurnResult): Promise<string> => {
      if (result.status === "failed") return GENERIC_FAILURE_TEXT;
      if (result.status !== "refused") {
        return approved ? `Approved (${action}): ${quoted}` : `Denied: ${quoted}`;
      }
      if (!approved && result.reason === approvalDeniedReason(approval.command)) return `Denied: ${quoted}`;
      const pending = await deps.core.getApproval(approval.requestId).then(
        (a) => a !== null,
        () => true,
      );
      return `Not approved: ${refusalText(result.reason)} ${pending ? RETRY_PENDING_TEXT : APPROVAL_EXPIRED_TEXT}`;
    };
    await deps.continueTurn(
      {
        ...turn,
        actor,
        conversation: { ...conversation, ...(audience ? { audience } : {}) },
        idempotencyKey: `discord-approval:${approval.requestId}`,
        approval: {
          requestId: approval.requestId,
          approved,
          ...(approved ? { scope: action as "once" | "session" | "always" } : {}),
        },
      } as CoreTurnBody,
      {
        onAccepted: async () => {
          accepted = true;
          await click.settle(`${approved ? "Approving" : "Denying"} ${quoted}…`);
        },
        onSettled: async (result) => {
          if (!accepted) return;
          await click
            .settleFinal(await finalText(result))
            .catch(reportFailureAs("discord: approval card final edit", undefined));
        },
      },
    );
    if (!accepted) await click.refuse(CONTINUE_FAILED_TEXT);
  }

  return async (click) => {
    await click.defer();
    const parsed = parseCardCustomId(click.customId);
    if (!parsed) return click.refuse(STALE_BUTTON_TEXT);
    const actor = await deps.classifyUser(click.userId);
    if (!actor) return click.refuse(READERS_UNKNOWN_CLICK_TEXT);
    if (actor.isExternalGuest) return click.refuse(NOT_INTERNAL_TEXT);
    const d = await deps.core.getDelivery(parsed.deliveryId);
    if (!d || kindOf(d) !== parsed.kind) return click.refuse(STALE_BUTTON_TEXT);
    if (d.destination.type !== DISCORD_DM_DELIVERY_TYPE) return click.refuse(STALE_BUTTON_TEXT);
    const recipientUserId = recipientDiscordId(d.destination.target, deps.core.discordUserIdsFor);
    if (recipientUserId !== click.userId) return click.refuse(STALE_BUTTON_TEXT);
    const subject = `${parsed.kind}:${subjectOf(d)}`;
    if (busy.has(subject)) return click.refuse(BUSY_TEXT);
    busy.add(subject);
    try {
      if (parsed.kind === "cmd") return await command(d, parsed.action, actor, click);
      if (parsed.kind === "key") {
        if (!deps.core.keychainApprovals) return click.refuse(STALE_BUTTON_TEXT);
        const action = parsed.action as keyof typeof KEYCHAIN_DECISION;
        const view = await deps.core.keychainApprovals.decide(
          d.destination.keychainAskId!,
          actor,
          KEYCHAIN_DECISION[action],
        );
        return await click.settle(keychainSettleText(view));
      }
      const text = await deps.core.decideDeploymentAccess(
        JSON.stringify(d.destination.deploymentAccess),
        actor,
        parsed.action === "approve",
      );
      return await click.settle(text);
    } catch (err) {
      reportFailure("discord: approval click", err, `subject=${subject}`);
      return click.refuse(`Couldn't complete that: ${errMessage(err)}`);
    } finally {
      busy.delete(subject);
    }
  };
}
