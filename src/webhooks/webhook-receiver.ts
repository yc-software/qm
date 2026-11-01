import { ADMISSION_CLOSED_RETRY_MS, WorkAdmissionClosed } from "../util/admitted-work.ts";
import type { Destination } from "../types.ts";
import type { Webhook } from "../triggers/types.ts";
import type { WebhookEvent, WebhookStore } from "./webhook-store.ts";
import { getVerifier, type VerifierInput } from "./verifiers.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWebhookWakeEnvelope, capForEscaping } from "../wake/wake-envelope.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import type { JobWorker } from "../jobs/job-worker.ts";

export type DeliverResult = { status: 202 } | { status: 200; body: string } | { status: 401 } | { status: 404 };

export interface WebhookReceiver {
  deliver(id: string, req: { headers: VerifierInput["headers"]; rawBody: string }): Promise<DeliverResult>;
}

export interface WebhookReceiverDeps extends TriggerDeps {
  webhooks: WebhookStore;
  jobs: Pick<JobWorker, "handle" | "spawn">;
}

const MAX_EVENT_CHARS = 16_000;
const WEBHOOK_FIRE_JOB = "webhook-fire";
const WEBHOOK_FIRE_MAX_ATTEMPTS = 3;

interface WebhookFireJob {
  webhookId: string;
  deliveryId: string;
}

const webhookFireKey = (webhookId: string, deliveryId: string) => `webhook:${webhookId}:${deliveryId}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseBody(headers: VerifierInput["headers"], rawBody: string): unknown {
  const ctRaw = headers["content-type"];
  const ct = ((Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      const payload = params.get("payload");
      return payload ? JSON.parse(payload) : Object.fromEntries(params.entries());
    }
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

function passesFilters(filters: Webhook["filters"], parsed: unknown): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => {
    const v = getPath(parsed, f.path);
    return v != null && f.in.includes(String(v));
  });
}

function renderEvent(wh: Webhook, event: WebhookEvent): { input: string; securityScreenData: string } {
  return {
    input: buildWebhookWakeEnvelope({
      webhookId: wh.id,
      scheme: wh.verification.scheme,
      deliveryId: event.deliveryId,
      at: new Date(event.receivedAt),
      action: wh.action,
      payload: event.payload,
    }),
    securityScreenData: event.payload,
  };
}

function capEvent(parsed: unknown, rawBody: string): string {
  const pretty = isObj(parsed) || Array.isArray(parsed) ? JSON.stringify(parsed, null, 2) : rawBody;
  const kept = capForEscaping(pretty, MAX_EVENT_CHARS, "head");
  return kept.length < pretty.length ? `${kept}\n…[truncated]` : kept;
}

export function createWebhookReceiver(deps: WebhookReceiverDeps): WebhookReceiver {
  const triggerDeps: TriggerDeps = {
    deliveries: deps.deliveries,
    idempotency: deps.idempotency,
    identity: deps.identity,
    run: deps.run,
    ...(deps.directory ? { directory: deps.directory } : {}),
    ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
    ...(deps.resolveRecipient ? { resolveRecipient: deps.resolveRecipient } : {}),
  };

  async function fire({ webhookId, deliveryId }: WebhookFireJob): Promise<void> {
    const wh = await deps.webhooks.get(webhookId);
    if (!wh) return;
    let handedBack = false;
    try {
      if (wh.enabled) await fireEvent(wh, deliveryId);
    } catch (e) {
      handedBack = e instanceof WorkAdmissionClosed;
      throw e;
    } finally {
      if (!handedBack)
        await deps.webhooks
          .settleEvent(wh.id, deliveryId)
          .catch(reportFailureAs("webhook: settle event", undefined, `webhook=${wh.id}`));
    }
  }

  async function fireEvent(wh: Webhook, deliveryId: string): Promise<void> {
    const event = (await deps.webhooks.listEvents(wh.id)).find((e) => e.deliveryId === deliveryId);
    if (!event?.pending) return;
    const rendered = renderEvent(wh, event);
    const destination: Destination | undefined = wh.destination;
    try {
      const outcome = await runTrigger(triggerDeps, {
        owner: wh.owner,
        ownerScopeId: wh.ownerScopeId,
        input: rendered.input,
        securityScreenData: rendered.securityScreenData,
        fireKey: webhookFireKey(wh.id, deliveryId),
        surface: "webhook",
        ...(destination ? { destination } : {}),
        errorNotice: (s) => `⚠️ Webhook did not complete: ${s}`,
      });
      if (outcome.authzFailed) {
        await deps.webhooks.setEnabled(wh.id, false);
        await deps.webhooks.recordFire(wh.id, { at: Date.now(), error: outcome.note ?? "fail-closed" });
        return;
      }
      await deps.webhooks.recordFire(wh.id, {
        at: Date.now(),
        deliveryId,
        ...(outcome.note ? { error: outcome.note } : {}),
      });
    } catch (e) {
      if (e instanceof WorkAdmissionClosed) throw e;
      reportFailure("webhook: fire", e, `webhook=${wh.id}`);
      await deps.webhooks
        .recordFire(wh.id, { at: Date.now(), error: errMessage(e) })
        .catch(reportFailureAs("webhook: persist fire failure", undefined, `webhook=${wh.id}`));
    }
  }
  deps.jobs.handle(
    WEBHOOK_FIRE_JOB,
    async (params) => {
      try {
        await fire(params as WebhookFireJob);
        return "done";
      } catch (e) {
        if (e instanceof WorkAdmissionClosed) return Date.now() + ADMISSION_CLOSED_RETRY_MS;
        throw e;
      }
    },
    { maxAttempts: WEBHOOK_FIRE_MAX_ATTEMPTS },
  );

  return {
    async deliver(id, req) {
      const wh = await deps.webhooks.get(id);
      if (!wh || !wh.enabled) return { status: 404 };

      const verifier = getVerifier(wh.verification.scheme);
      if (!verifier) return { status: 404 };

      const input: VerifierInput = {
        ...(wh.verification.secret ? { secret: wh.verification.secret } : {}),
        headers: req.headers,
        rawBody: req.rawBody,
      };
      if (!verifier.verify(input)) return { status: 401 };

      const parsed = parseBody(req.headers, req.rawBody);

      const hs = verifier.handshake?.(input, parsed);
      if (hs != null) return { status: 200, body: hs };

      if (!passesFilters(wh.filters, parsed)) return { status: 200, body: "skipped" };

      const deliveryId = verifier.deliveryId(input);
      const fireKey = webhookFireKey(wh.id, deliveryId);
      if (await deps.idempotency.committed(fireKey)) return { status: 200, body: "duplicate" };

      await deps.webhooks.recordEvent(wh.id, {
        deliveryId,
        receivedAt: Date.now(),
        payload: capEvent(parsed, req.rawBody),
      });
      const job: WebhookFireJob = { webhookId: wh.id, deliveryId };
      await deps.jobs.spawn(WEBHOOK_FIRE_JOB, job, fireKey);
      return { status: 202 };
    },
  };
}
