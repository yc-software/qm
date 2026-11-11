import type { App } from "../../api/app-types.ts";
import { refusedStatus, type Send } from "../../delivery/relay.ts";
import type { Tenant } from "../../tenants/context.ts";
import type { Delivery } from "../../types.ts";
import {
  partnerChatMessageId,
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatRef,
  signPartnerChatPost,
  ACCOUNT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./protocol.ts";
import { trimTrailingSlashes } from "../../util/text.ts";

const REQUEST_TIMEOUT_MS = 15_000;
export const PARTNER_CHAT_CLAIM_MS = 4 * REQUEST_TIMEOUT_MS;
const MESSAGE_ID = /^\d+$/;
const SELF_AUTHOR = "self";

class PartnerChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(`partner-chat ${status}: ${reason}`);
    this.status = status;
  }
}

class UnsupportedDelivery extends Error {}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function partnerChatSender(deps: {
  url: string;
  secret: string;
  app: Pick<App, "ingestSurfaceEvents" | "tenantFor">;
  fetch?: typeof fetch;
  now?: () => number;
}): Send {
  const endpoint = `${trimTrailingSlashes(deps.url)}/agent_app/messages`;
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function deliver(d: Delivery, tenant: Tenant): Promise<void> {
    const ref = parsePartnerChatRef(d.destination.target);
    const body = d.text.trim();
    if (!ref) throw new UnsupportedDelivery(`partner-chat: unroutable target ${d.destination.target}`);
    if ((await deps.app.tenantFor("partner_chat", ref.account)) !== tenant.id)
      throw new UnsupportedDelivery(`partner-chat: account ${ref.account} is not bound to this workspace`);
    const { react, delete: del, pin, edit, editRef } = d.destination;
    if (react || del || pin || edit || editRef || !body)
      throw new UnsupportedDelivery("partner-chat: only non-empty text posts are supported");
    if (d.attachments?.length)
      console.log(`[partner-chat] delivery ${d.id} posts its text without ${d.attachments.length} attachment(s)`);
    const thread = d.destination.threadTs ? partnerChatMessageId(d.destination.threadTs) : ref.thread;
    if (thread !== undefined && !MESSAGE_ID.test(thread))
      throw new UnsupportedDelivery(`partner-chat: bad thread id ${thread}`);
    const payload = JSON.stringify({
      client_message_id: d.idempotencyKey,
      chat_id: ref.chat,
      ...(thread ? { thread_id: thread } : {}),
      body,
    });
    const timestamp = String(Math.floor(now() / 1000));
    const res = await send(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ACCOUNT_HEADER]: ref.account,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signPartnerChatPost(deps.secret, timestamp, ref.account, payload),
      },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const reply = await res.text();
    const parsed = parseJson(reply);
    if (!res.ok)
      throw new PartnerChatHttpError(
        res.status,
        typeof parsed.error === "string" ? parsed.error : reply.slice(0, 200) || res.statusText,
      );
    const messageId = parsed.message_id;
    if (typeof messageId !== "string" && typeof messageId !== "number") {
      console.log(`[partner-chat] delivery ${d.id} posted without a message id`);
      return;
    }
    const at = now();
    await deps.app.ingestSurfaceEvents(
      [
        {
          surface: "partner-chat",
          container: partnerChatRef({ account: ref.account, kind: ref.kind, chat: ref.chat }),
          ts: partnerChatTs(new Date(at).toISOString(), String(messageId)),
          sub: thread ?? null,
          authorId: SELF_AUTHOR,
          text: body,
          self: true,
          bot: true,
          handled: true,
          createdAt: at,
        },
      ],
      "partner-chat",
    );
  }

  return async (d, tenant) => {
    try {
      await deliver(d, tenant);
    } catch (e) {
      if (e instanceof UnsupportedDelivery) return { refused: e.message };
      if (e instanceof PartnerChatHttpError && refusedStatus(e.status)) return { refused: e.message };
      throw e;
    }
  };
}
