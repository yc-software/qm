import type { App } from "../../api/app-types.ts";
import { refusedStatus, type Send } from "../../delivery/relay.ts";
import type { Tenant } from "../../tenants/context.ts";
import type { Delivery } from "../../types.ts";
import { PartnerChatHttpError, type PartnerChatClient } from "./client.ts";
import { deletePartnerChatMessage, editPartnerChatMessage, postPartnerChatMessage } from "./messages.ts";
import { partnerChatMessageId, parsePartnerChatRef } from "./protocol.ts";

const MESSAGE_ID = /^\d+$/;

class UnsupportedDelivery extends Error {}

function refusal(e: unknown): e is PartnerChatHttpError {
  return e instanceof PartnerChatHttpError && refusedStatus(e.status);
}

export function partnerChatSender(deps: {
  client: PartnerChatClient;
  app: Pick<App, "ingestSurfaceEvents" | "readSurfaceMessages" | "tenantFor">;
  now?: () => number;
}): Send {
  async function deliver(d: Delivery, tenant: Tenant): Promise<void> {
    const ref = parsePartnerChatRef(d.destination.target);
    const body = d.text.trim();
    if (!ref) throw new UnsupportedDelivery(`partner-chat: unroutable target ${d.destination.target}`);
    if ((await deps.app.tenantFor("partner_chat", ref.account)) !== tenant.id)
      throw new UnsupportedDelivery(`partner-chat: account ${ref.account} is not bound to this workspace`);
    const { react, delete: del, pin, edit, editRef } = d.destination;
    if (react || pin) throw new UnsupportedDelivery("partner-chat: reactions and pins are not supported");
    if (del) return deletePartnerChatMessage(deps, ref, del.messageTs);
    if (edit) {
      if (body) return editPartnerChatMessage(deps, ref, edit.messageTs, body);
      console.log(`[partner-chat] delivery ${d.id} edit skipped: no text left to write`);
      return;
    }
    if (editRef) {
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
    if (!body) throw new UnsupportedDelivery("partner-chat: only non-empty text posts are supported");
    if (d.attachments?.length)
      console.log(`[partner-chat] delivery ${d.id} posts its text without ${d.attachments.length} attachment(s)`);
    const thread = d.destination.threadTs ? partnerChatMessageId(d.destination.threadTs) : ref.thread;
    if (thread !== undefined && !MESSAGE_ID.test(thread))
      throw new UnsupportedDelivery(`partner-chat: bad thread id ${thread}`);
    const posted = await postPartnerChatMessage(
      deps,
      { account: ref.account, kind: ref.kind, chat: ref.chat, ...(thread ? { thread } : {}) },
      { text: body, idempotencyKey: d.idempotencyKey },
    );
    if (!posted) console.log(`[partner-chat] delivery ${d.id} posted without a message id`);
  }

  return async (d, tenant) => {
    try {
      await deliver(d, tenant);
    } catch (e) {
      if (e instanceof UnsupportedDelivery) return { refused: e.message };
      if (refusal(e)) return { refused: e.message };
      throw e;
    }
  };
}
