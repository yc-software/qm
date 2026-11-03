import type { App } from "../../api/app-types.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import type { Delivery } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import {
  partnerChatContainer,
  partnerChatMessageId,
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatRef,
  partnerChatToken,
} from "./protocol.ts";

const CLAIM_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
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

const permanent = (e: unknown): boolean =>
  e instanceof UnsupportedDelivery ||
  (e instanceof PartnerChatHttpError && e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status));

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createPartnerChatDeliveries(deps: {
  url: string;
  secret: string;
  deliveries: Pick<DeliveryStore, "claimPending" | "ack" | "fail">;
  app: Pick<App, "ingestSurfaceEvents">;
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const endpoint = `${deps.url.replace(/\/+$/, "")}/agent_app/messages`;
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function deliver(d: Delivery): Promise<void> {
    const ref = parsePartnerChatRef(d.destination.target);
    const body = d.text.trim();
    if (!ref) throw new UnsupportedDelivery(`partner-chat: unroutable target ${d.destination.target}`);
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
    const res = await send(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${partnerChatToken(deps.secret, ref.account)}`,
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

  let draining: Promise<void> | null = null;
  let again = false;
  async function drainOnce(): Promise<void> {
    const claimedAt = now();
    const held = new Set<string>();
    for (const d of await deps.deliveries.claimPending("partner-chat", CLAIM_MS)) {
      if (now() - claimedAt > CLAIM_MS - REQUEST_TIMEOUT_MS) return;
      const chat = partnerChatContainer(d.destination.target);
      if (held.has(chat)) continue;
      try {
        await deliver(d);
        await deps.deliveries.ack(d.id, now());
      } catch (e) {
        console.error(`[partner-chat] delivery ${d.id} failed: ${errMessage(e)}`);
        if (permanent(e)) await deps.deliveries.fail(d.id, errMessage(e), now());
        else held.add(chat);
      }
    }
  }
  function drain(): Promise<void> {
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      do {
        again = false;
        await deps.serialize(drainOnce);
      } while (again);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  return { drain };
}
