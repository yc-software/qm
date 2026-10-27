import type { Destination, Webhook } from "../types.ts";
import type { WebhookStore } from "./webhook-store.ts";
import { getVerifier, type VerifierInput } from "./verifiers.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWebhookWakeEnvelope, capForEscaping } from "../core/wake-envelope.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import type { JobWorker } from "../jobs/job-worker.ts";
import { isObj } from "../util/objects.ts";
import { MAX_SCREEN_CHARS } from "../security/security-screen.ts";

export type DeliverResult = { status: 202 } | { status: 200; body: string } | { status: 401 } | { status: 404 };

export interface WebhookReceiver {
  deliver(id: string, req: { headers: VerifierInput["headers"]; rawBody: string }): Promise<DeliverResult>;
}

export interface WebhookReceiverDeps extends TriggerDeps {
  webhooks: WebhookStore;
  jobs: Pick<JobWorker, "handle" | "spawn">;
}

const WEBHOOK_FIRE_JOB = "webhook-fire";

interface WebhookFireJob {
  webhookId: string;
  deliveryId: string;
  input: string;
  securityScreenData: string;
}

const TRUNCATED_MARK = "\n…[truncated]";
const MAX_EVENT_CHARS = MAX_SCREEN_CHARS - TRUNCATED_MARK.length;

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
  const capped = kept.length < pretty.length ? `${kept}${TRUNCATED_MARK}` : kept;
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
  async function fire({ webhookId, deliveryId, input, securityScreenData }: WebhookFireJob): Promise<void> {
    const wh = await deps.webhooks.get(webhookId);
    if (!wh || !wh.enabled) return;
    const destination: Destination | undefined = wh.destination;
    try {
      const outcome = await runTrigger(deps, {
        owner: wh.owner,
        ownerScopeId: wh.ownerScopeId,
        input,
        securityScreenData,
        fireKey: `webhook:${wh.id}:${deliveryId}`,
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
      await deps.webhooks
        .recordFire(wh.id, { at: Date.now(), error: errMessage(e) })
        .catch(reportFailureAs("webhook: persist fire failure", undefined, `webhook=${wh.id}`));
      reportFailure("webhook: fire", e, `webhook=${wh.id}`);
    }
  }
  deps.jobs.handle(WEBHOOK_FIRE_JOB, async (params) => {
    await fire(params as WebhookFireJob);
    return "done";
  });

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
      if (!(await verifier.verify(input))) return { status: 401 };

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

      const job: WebhookFireJob = { webhookId: wh.id, deliveryId, ...event };
      await deps.jobs.spawn(WEBHOOK_FIRE_JOB, job, fireKey);
      return { status: 202 };
    },
  };
}
