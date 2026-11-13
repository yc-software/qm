import type { App } from "../../api/app-types.ts";
import { refusedStatus, type Send } from "../../delivery/relay.ts";
import type { Tenant } from "../../tenants/context.ts";
import type { KeychainApprovals } from "../../credentials/keychain-approval.ts";
import type { Delivery } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import type { AddressFetch } from "../../util/network.ts";
import type { BlobSource } from "../attachments.ts";
import { partnerChatCard } from "./approvals.ts";
import { PartnerChatHttpError, type PartnerChatClient } from "./client.ts";
import { uploadPartnerChatFiles } from "./files.ts";
import { deletePartnerChatMessage, editPartnerChatMessage, postPartnerChatMessage } from "./messages.ts";
import { partnerChatMessageId, parsePartnerChatRef } from "./protocol.ts";
import { UnknownPartnerChatReaction, addPartnerChatReaction } from "./reactions.ts";

const MESSAGE_ID = /^\d+$/;
const UPLOAD_FAILED = "I couldn't attach the file(s). Try again in a moment.";

class UnsupportedDelivery extends Error {}

function refusal(e: unknown): e is PartnerChatHttpError {
  return e instanceof PartnerChatHttpError && refusedStatus(e.status);
}

export function partnerChatSender(deps: {
  client: PartnerChatClient;
  blobs: BlobSource;
  storageFetch?: AddressFetch;
  app: Pick<App, "ingestSurfaceEvents" | "readSurfaceMessages" | "tenantFor" | "getApproval">;
  keychainApprovals?: Pick<KeychainApprovals, "card">;
  now?: () => number;
}): Send {
  async function deliver(d: Delivery, tenant: Tenant): Promise<void> {
    const ref = parsePartnerChatRef(d.destination.target);
    if (!ref) throw new UnsupportedDelivery(`partner-chat: unroutable target ${d.destination.target}`);
    if ((await deps.app.tenantFor("partner_chat", ref.account)) !== tenant.id)
      throw new UnsupportedDelivery(`partner-chat: account ${ref.account} is not bound to this workspace`);
    const card = await partnerChatCard(deps, d);
    if (card === null) return;
    let body = card?.body ?? d.text.trim();
    const { react, delete: del, pin, edit, editRef } = d.destination;
    if (react) {
      const messageId = partnerChatMessageId(react.messageTs);
      if (!MESSAGE_ID.test(messageId)) throw new UnsupportedDelivery(`partner-chat: bad message id ${messageId}`);
      await addPartnerChatReaction(deps.client, { account: ref.account, chat: ref.chat, messageId }, react.emoji);
      return;
    }
    if (pin) throw new UnsupportedDelivery("partner-chat: pins are not supported");
    if (del) return deletePartnerChatMessage(deps, ref, del.messageTs);
    if (edit) {
      if (body) return editPartnerChatMessage(deps, ref, edit.messageTs, body);
      console.log(`[partner-chat] delivery ${d.id} edit skipped: no text left to write`);
      return;
    }
    const thread = d.destination.threadTs ? partnerChatMessageId(d.destination.threadTs) : ref.thread;
    if (thread !== undefined && !MESSAGE_ID.test(thread))
      throw new UnsupportedDelivery(`partner-chat: bad thread id ${thread}`);
    let fileIds: string[] = [];
    if (d.attachments?.length) {
      try {
        fileIds = await uploadPartnerChatFiles(
          deps.client,
          ref.account,
          ref.chat,
          d.attachments,
          deps.blobs,
          deps.storageFetch,
        );
      } catch (e) {
        console.error(`[partner-chat] delivery ${d.id} attachment upload failed: ${errMessage(e)}`);
        body = [body, UPLOAD_FAILED].filter(Boolean).join("\n\n");
      }
    }
    if (editRef && !fileIds.length) {
      const settled = await (
        body ? editPartnerChatMessage(deps, ref, editRef, body) : deletePartnerChatMessage(deps, ref, editRef)
      ).then(
        () => true,
        (e: unknown) => {
          if (!refusal(e)) throw e;
          console.log(`[partner-chat] delivery ${d.id} could not finish in place: ${e.message}`);
          return !body;
        },
      );
      if (settled) return;
    }
    if (!body && !fileIds.length) throw new UnsupportedDelivery("partner-chat: only text or file posts are supported");
    const posted = await postPartnerChatMessage(
      deps,
      { account: ref.account, kind: ref.kind, chat: ref.chat, ...(thread ? { thread } : {}) },
      {
        text: body,
        idempotencyKey: card?.key ?? d.idempotencyKey,
        fileIds,
        ...(card ? { actions: card.actions } : {}),
      },
    );
    if (!posted) console.log(`[partner-chat] delivery ${d.id} posted without a message id`);
    else if (card?.resolved) await editPartnerChatMessage(deps, ref, posted, card.body, card.actions);
  }

  return async (d, tenant) => {
    try {
      await deliver(d, tenant);
    } catch (e) {
      if (e instanceof UnsupportedDelivery || e instanceof UnknownPartnerChatReaction) return { refused: e.message };
      if (refusal(e)) return { refused: e.message };
      throw e;
    }
  };
}
