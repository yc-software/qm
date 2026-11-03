import type { App } from "../../api/app-types.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import type { Delivery } from "../../types.ts";
import { errMessage, reportFailureAs } from "../../util/errors.ts";
import { partnerChatMessageId, parsePartnerChatRef, signPartnerChat } from "./protocol.ts";

const CLAIM_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MESSAGE_ID = /^\d+$/;

class PartnerChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`partner-chat ${status}: ${body}`);
    this.status = status;
  }
}

const permanent = (e: unknown): boolean =>
  e instanceof PartnerChatHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

export function createPartnerChatDeliveries(deps: {
  url: string;
  secret: string;
  deliveries: Pick<DeliveryStore, "claimPending" | "ack" | "fail">;
  app: Pick<App, "setRunDeliveryState">;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const base = deps.url.replace(/\/+$/, "");
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function call(path: string, payload: Record<string, unknown>): Promise<{ message_id?: string }> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const res = await send(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qm-timestamp": timestamp,
        "x-qm-signature": signPartnerChat(deps.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new PartnerChatHttpError(res.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    const messageId = (parsed as { message_id?: unknown } | null)?.message_id;
    return typeof messageId === "string" || typeof messageId === "number" ? { message_id: String(messageId) } : {};
  }

  async function deliver(d: Delivery): Promise<void> {
    const ref = parsePartnerChatRef(d.destination.target);
    const body = d.text.trim();
    const editId = d.destination.editRef ? partnerChatMessageId(d.destination.editRef) : undefined;
    if (!ref) throw new PartnerChatHttpError(400, `unroutable target ${d.destination.target}`);
    if (d.destination.react || d.destination.delete || d.destination.pin || d.attachments?.length || !body)
      throw new PartnerChatHttpError(400, "only non-empty text posts and edits are supported");
    if (editId !== undefined) {
      if (!MESSAGE_ID.test(editId)) throw new PartnerChatHttpError(400, `bad message id ${editId}`);
      await call(`/qm_surface/messages/${editId}/update`, { body });
      return;
    }
    const thread = d.destination.threadTs ? partnerChatMessageId(d.destination.threadTs) : ref.thread;
    if (thread !== undefined && !MESSAGE_ID.test(thread))
      throw new PartnerChatHttpError(400, `bad thread id ${thread}`);
    const posted = await call("/qm_surface/messages", {
      client_message_id: d.idempotencyKey,
      chat_id: ref.chat,
      ...(thread ? { thread_id: thread } : {}),
      body,
    });
    const ackRun = d.idempotencyKey.startsWith("ack:") ? d.idempotencyKey.slice("ack:".length) : undefined;
    if (!posted.message_id) console.log(`[partner-chat] delivery ${d.id} posted without a message id`);
    if (ackRun && posted.message_id)
      await deps.app
        .setRunDeliveryState(ackRun, { editRef: posted.message_id })
        .catch(reportFailureAs("partner-chat: record ack message", false));
  }

  let draining: Promise<void> | null = null;
  let again = false;
  async function drainOnce(): Promise<void> {
    const claimedAt = now();
    for (const d of await deps.deliveries.claimPending("partner-chat", CLAIM_MS)) {
      if (now() - claimedAt > CLAIM_MS - REQUEST_TIMEOUT_MS) return;
      try {
        await deliver(d);
        await deps.deliveries.ack(d.id, now());
      } catch (e) {
        console.error(`[partner-chat] delivery ${d.id} failed: ${errMessage(e)}`);
        if (permanent(e)) await deps.deliveries.fail(d.id, errMessage(e), now());
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
        await drainOnce();
      } while (again);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  return { drain };
}
