import type { App } from "../../api/app-types.ts";
import { refusedStatus, type Send } from "../../delivery/relay.ts";
import type { Tenant } from "../../tenants/context.ts";
import type { KeychainApprovals } from "../../credentials/keychain-approval.ts";
import type { Delivery } from "../../types.ts";
import { genericChatCard } from "./approvals.ts";
import { GenericChatHttpError } from "./client.ts";
import { uploadGenericChatFiles, type GenericChatUploads } from "./files.ts";
import { deleteGenericChatMessage, editGenericChatMessage, postGenericChatMessage } from "./messages.ts";
import { genericChatMessageId, genericChatMessageIdSchema, parseGenericChatRef } from "./protocol.ts";
import { UnknownGenericChatReaction, setGenericChatReaction } from "./reactions.ts";

class UnsupportedDelivery extends Error {}

function refusal(e: unknown): e is GenericChatHttpError {
  return e instanceof GenericChatHttpError && refusedStatus(e.status);
}

function badId(id: string | undefined): id is string {
  return id !== undefined && !genericChatMessageIdSchema.safeParse(id).success;
}

export function genericChatSender(
  deps: GenericChatUploads & {
    app: Pick<App, "ingestSurfaceEvents" | "readSurfaceMessages" | "tenantFor" | "getApproval">;
    keychainApprovals?: Pick<KeychainApprovals, "card">;
    now?: () => number;
  },
): Send {
  async function deliver(d: Delivery, tenant: Tenant): Promise<void> {
    const ref = parseGenericChatRef(d.destination.target);
    if (!ref) throw new UnsupportedDelivery(`generic-chat: unroutable target ${d.destination.target}`);
    if ((await deps.app.tenantFor("partner_chat", ref.account)) !== tenant.id)
      throw new UnsupportedDelivery(`generic-chat: account ${ref.account} is not bound to this workspace`);
    const card = await genericChatCard(deps, d);
    if (card === null) return;
    let body = card?.body ?? d.text.trim();
    const { react, delete: del, pin, edit, editRef } = d.destination;
    if (react) {
      const messageId = genericChatMessageId(react.messageTs);
      if (badId(messageId)) throw new UnsupportedDelivery(`generic-chat: bad message id ${messageId}`);
      return setGenericChatReaction(deps.client, ref, messageId, react.emoji, true);
    }
    if (pin) throw new UnsupportedDelivery("generic-chat: pins are not supported");
    if (del) return deleteGenericChatMessage(deps, ref, del.messageTs);
    if (edit) {
      if (body) return editGenericChatMessage(deps, ref, edit.messageTs, body);
      console.log(`[generic-chat] delivery ${d.id} edit skipped: no text left to write`);
      return;
    }
    const thread = d.destination.threadTs ? genericChatMessageId(d.destination.threadTs) : ref.thread;
    if (badId(thread)) throw new UnsupportedDelivery(`generic-chat: bad thread id ${thread}`);
    const { fileIds = [], failureNote } = d.attachments?.length
      ? await uploadGenericChatFiles(deps, ref, d.attachments)
      : {};
    body = [body, failureNote].filter(Boolean).join("\n\n");
    if (editRef && !fileIds.length) {
      const settled = await (
        body ? editGenericChatMessage(deps, ref, editRef, body) : deleteGenericChatMessage(deps, ref, editRef)
      ).then(
        () => true,
        (e: unknown) => {
          if (!refusal(e)) throw e;
          console.log(`[generic-chat] delivery ${d.id} could not finish in place: ${e.message}`);
          return !body;
        },
      );
      if (settled) return;
    }
    if (!body && !fileIds.length) throw new UnsupportedDelivery("generic-chat: only text or file posts are supported");
    const posted = await postGenericChatMessage(
      deps,
      { account: ref.account, kind: ref.kind, chat: ref.chat, ...(thread ? { thread } : {}) },
      {
        text: body,
        idempotencyKey: card?.key ?? d.idempotencyKey,
        fileIds,
        ...(card ? { actions: card.actions } : {}),
      },
    );
    if (!posted) console.log(`[generic-chat] delivery ${d.id} posted without a message id`);
    else if (card?.resolved) await editGenericChatMessage(deps, ref, posted, card.body, card.actions);
  }

  return async (d, tenant) => {
    try {
      await deliver(d, tenant);
    } catch (e) {
      if (e instanceof UnsupportedDelivery || e instanceof UnknownGenericChatReaction) return { refused: e.message };
      if (refusal(e)) return { refused: e.message };
      throw e;
    }
  };
}
