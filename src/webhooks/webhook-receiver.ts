import type { Webhook } from "../types.ts";
import type { WebhookStore } from "./webhook-store.ts";
import { getVerifier, type VerifierInput } from "./verifiers.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWebhookWakeEnvelope, capForEscaping } from "../core/wake-envelope.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import { isDurableControlFlow, type DurableTasks, type DurableTaskContext } from "../durable/tasks.ts";

export type DeliverResult = { status: 202 } | { status: 200; body: string } | { status: 401 } | { status: 404 };

export interface WebhookReceiver {
  deliver(id: string, req: { headers: VerifierInput["headers"]; rawBody: string }): Promise<DeliverResult>;
}

export interface WebhookReceiverDeps extends TriggerDeps {
  webhooks: WebhookStore;
  tasks?: DurableTasks;
}

const MAX_EVENT_CHARS = 16_000;

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

function renderEvent(
  wh: Webhook,
  deliveryId: string,
  parsed: unknown,
  rawBody: string,
): { input: string; securityScreenData: string } {
  const pretty = isObj(parsed) || Array.isArray(parsed) ? JSON.stringify(parsed, null, 2) : rawBody;
  const kept = capForEscaping(pretty, MAX_EVENT_CHARS, "head");
  const capped = kept.length < pretty.length ? `${kept}\n…[truncated]` : kept;
  return {
    input: buildWebhookWakeEnvelope({
      webhookId: wh.id,
      scheme: wh.verification.scheme,
      deliveryId,
      at: new Date(),
      action: wh.action,
      payload: capped,
    }),
    securityScreenData: capped,
  };
}

export function createWebhookReceiver(deps: WebhookReceiverDeps): WebhookReceiver {
  const triggerDeps: TriggerDeps = {
    deliveries: deps.deliveries,
    idempotency: deps.idempotency,
    identity: deps.identity,
    run: deps.run,
    ...(deps.directory ? { directory: deps.directory } : {}),
    ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
  };

  interface EventParams {
    webhookId: string;
    deliveryId: string;
    input: string;
    securityScreenData: string;
  }

  async function processEvent(event: EventParams, context?: DurableTaskContext): Promise<void> {
    const wh = await deps.webhooks.get(event.webhookId);
    if (!wh?.enabled) return;
    const fireKey = `webhook:${wh.id}:${event.deliveryId}`;
    const outcome = await runTrigger(
      triggerDeps,
      {
        owner: wh.owner,
        ownerScopeId: wh.ownerScopeId,
        input: event.input,
        securityScreenData: event.securityScreenData,
        fireKey,
        surface: "webhook",
        ...(wh.destination ? { destination: wh.destination } : {}),
        recipientConsentRequired: true,
        ...(wh.recipientConsent ? { recipientConsent: wh.recipientConsent } : {}),
        errorNotice: (s) => `⚠️ Webhook did not complete: ${s}`,
      },
      context,
    );
    const finish = async () => {
      if (outcome.authzFailed) await deps.webhooks.setEnabled(wh.id, false);
      await deps.webhooks.recordFire(wh.id, {
        at: Date.now(),
        deliveryId: event.deliveryId,
        ...(outcome.note ? { error: outcome.note } : {}),
      });
    };
    if (context) await context.step("webhook:finish", finish);
    else await finish();
  }

  deps.tasks?.register<EventParams, void>("webhook.event", (context, event) => processEvent(event, context));

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
      const fireKey = `webhook:${wh.id}:${deliveryId}`;
      if (await deps.idempotency.committed(fireKey)) return { status: 200, body: "duplicate" };

      const event = renderEvent(wh, deliveryId, parsed, req.rawBody);
      await deps.webhooks.recordEvent(wh.id, {
        deliveryId,
        receivedAt: Date.now(),
        payload: event.securityScreenData,
      });
      const params = { webhookId: wh.id, deliveryId, ...event };
      if (deps.tasks) {
        await deps.tasks.spawn("webhook.event", params, { idempotencyKey: fireKey });
      } else {
        void processEvent(params).catch(async (error: unknown) => {
          if (isDurableControlFlow(error)) throw error;
          const message = errMessage(error);
          await deps.webhooks.recordFire(wh.id, { at: Date.now(), error: message });
          reportFailure("webhook: fire", error, `webhook=${wh.id}`);
        });
      }

      return { status: 202 };
    },
  };
}
