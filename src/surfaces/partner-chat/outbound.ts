import type { App } from "../../api/app-types.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import type { Delivery } from "../../types.ts";
import { errMessage, reportFailureAs } from "../../util/errors.ts";
import { isTerminal, type RunStore } from "../../runs/run-store.ts";
import type { SurfaceCache } from "../../surface-cache/surface-cache.ts";
import {
  findMessage,
  partnerChatMessageId,
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatRef,
  signPartnerChat,
  type PartnerChatRef,
} from "./protocol.ts";

const CLAIM_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MESSAGE_ID = /^\d+$/;
const SELF_AUTHOR = "self";
const RUN_KEY = /^(ack|placeholder|settle|notice|post|run):([0-9a-f-]{36})(?::|$)/;

interface RunKey {
  kind: "ack" | "placeholder" | "settle" | "notice" | "post" | "run";
  runId: string;
}

function runKey(idempotencyKey: string): RunKey | undefined {
  const m = RUN_KEY.exec(idempotencyKey);
  return m ? { kind: m[1] as RunKey["kind"], runId: m[2]! } : undefined;
}

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
  app: Pick<App, "setRunDeliveryState" | "ingestSurfaceEvents">;
  runs: Pick<RunStore, "get">;
  surfaceCache: Pick<SurfaceCache, "readMessages">;
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
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

  async function recordOwn(ref: PartnerChatRef, messageId: string, body: string, edited: boolean): Promise<void> {
    const container = partnerChatRef({ account: ref.account, kind: ref.kind, chat: ref.chat });
    const at = now();
    const prior = edited ? await findMessage(deps.surfaceCache, container, messageId, { self: true }) : undefined;
    if (edited && !prior) return;
    await deps.app.ingestSurfaceEvents(
      [
        {
          surface: "partner-chat",
          container,
          ts: prior?.ts ?? partnerChatTs(new Date(at).toISOString(), messageId),
          sub: prior ? (prior.sub ?? null) : (ref.thread ?? null),
          authorId: SELF_AUTHOR,
          text: body,
          self: true,
          bot: true,
          handled: true,
          createdAt: prior?.createdAt ?? at,
          ...(edited ? { editedAt: at } : {}),
        },
      ],
      "partner-chat",
    );
  }

  async function post(d: Delivery, ref: PartnerChatRef, body: string): Promise<string | undefined> {
    const thread = d.destination.threadTs ? partnerChatMessageId(d.destination.threadTs) : ref.thread;
    if (thread !== undefined && !MESSAGE_ID.test(thread))
      throw new PartnerChatHttpError(400, `bad thread id ${thread}`);
    const posted = await call("/qm_surface/messages", {
      client_message_id: d.idempotencyKey,
      chat_id: ref.chat,
      ...(thread ? { thread_id: thread } : {}),
      body,
    });
    if (!posted.message_id) {
      console.log(`[partner-chat] delivery ${d.id} posted without a message id`);
      return undefined;
    }
    await recordOwn({ ...ref, ...(thread ? { thread } : {}) }, posted.message_id, body, false).catch(
      reportFailureAs("partner-chat: mirror own post", undefined),
    );
    return posted.message_id;
  }

  async function edit(ref: PartnerChatRef, editRef: string, body: string): Promise<void> {
    const id = partnerChatMessageId(editRef);
    if (!MESSAGE_ID.test(id)) throw new PartnerChatHttpError(400, `bad message id ${id}`);
    await call(`/qm_surface/messages/${id}/update`, { body });
    await recordOwn(ref, id, body, true).catch(reportFailureAs("partner-chat: mirror own edit", undefined));
  }

  async function editOrPost(d: Delivery, ref: PartnerChatRef, editRef: string, body: string): Promise<void> {
    try {
      await edit(ref, editRef, body);
    } catch (e) {
      if (!permanent(e)) throw e;
      console.log(`[partner-chat] delivery ${d.id} could not edit ${editRef}, posting instead: ${errMessage(e)}`);
      await post(d, ref, body);
    }
  }

  const setSlot = (runId: string, editRef: string) =>
    deps.app.setRunDeliveryState(runId, { editRef }).catch(reportFailureAs("partner-chat: record reply slot", false));

  async function deliverForRun(d: Delivery, ref: PartnerChatRef, body: string, key: RunKey): Promise<void> {
    const run = await deps.runs.get(key.runId);
    const slot = run?.deliveryState?.editRef;
    const inSlot = d.destination.target === run?.request.deliveryTarget;
    if (key.kind === "placeholder") {
      if (!run || isTerminal(run.status) || slot !== undefined) return;
      const id = await post(d, ref, body);
      if (id) await setSlot(key.runId, id);
      return;
    }
    if (key.kind === "settle") {
      if (!slot) return;
      await edit(ref, slot, body).catch((e: unknown) => {
        if (!permanent(e)) throw e;
        console.log(`[partner-chat] delivery ${d.id} could not settle ${slot}: ${errMessage(e)}`);
      });
      await setSlot(key.runId, "");
      return;
    }
    if (key.kind === "notice") {
      if (slot === "") return;
      if (slot) await editOrPost(d, ref, slot, body);
      else await post(d, ref, body);
      await setSlot(key.runId, "");
      return;
    }
    if (key.kind === "ack") {
      if (slot === "") return;
      if (slot) return editOrPost(d, ref, slot, body);
      const id = await post(d, ref, body);
      if (id) await setSlot(key.runId, id);
      return;
    }
    const explicit = d.destination.editRef;
    const editRef = explicit || (inSlot && slot ? slot : undefined);
    if (editRef) await editOrPost(d, ref, editRef, body);
    else await post(d, ref, body);
    if (explicit ? explicit === slot : inSlot && slot !== "") await setSlot(key.runId, "");
  }

  async function deliver(d: Delivery): Promise<void> {
    const ref = parsePartnerChatRef(d.destination.target);
    const text = d.text.trim();
    const body = text && d.destination.editNote ? `${text}\n\n${d.destination.editNote}` : text;
    if (!ref) throw new PartnerChatHttpError(400, `unroutable target ${d.destination.target}`);
    if (d.destination.react || d.destination.delete || d.destination.pin || d.attachments?.length || !body)
      throw new PartnerChatHttpError(400, "only non-empty text posts and edits are supported");
    const key = runKey(d.idempotencyKey);
    if (d.destination.edit) {
      const edited = partnerChatMessageId(d.destination.edit.messageTs);
      await edit(ref, edited, body);
      if (key && (await deps.runs.get(key.runId))?.deliveryState?.editRef === edited) await setSlot(key.runId, "");
      return;
    }
    if (key) return deliverForRun(d, ref, body, key);
    if (d.destination.editRef) await edit(ref, d.destination.editRef, body);
    else await post(d, ref, body);
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
        await deps.serialize(drainOnce);
      } while (again);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  return { drain };
}
