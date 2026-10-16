import { withAbort } from "../util/async.ts";
import { normalizeAutomationTitle } from "../triggers/automation-store.ts";
import type { AutomationJobQueue } from "../triggers/job-queue.ts";
import type { AdmittedWork } from "../util/admitted-work.ts";
import { runRecordedTrigger } from "../triggers/run-record.ts";
import type { Destination, Webhook } from "../types.ts";
import type { WebhookStore } from "./webhook-store.ts";
import { getVerifier, type VerifierInput } from "./verifiers.ts";
import { type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWebhookWakeEnvelope, capForEscaping } from "../core/wake-envelope.ts";
import { reportFailure } from "../util/errors.ts";

export type DeliverResult = { status: 202 } | { status: 200; body: string } | { status: 401 } | { status: 404 };

export interface WebhookFireJob {
  webhookId: string;
  deliveryId: string;
  receivedAt: number;
  input: string;
  payload: string;
}

export interface WebhookReceiver {
  start(): Promise<void>;
  stopClaims(): Promise<void>;
  drained(): Promise<void>;
  stop(): Promise<void>;
  deliver(id: string, req: { headers: VerifierInput["headers"]; rawBody: string }): Promise<DeliverResult>;
}

export interface WebhookReceiverDeps extends TriggerDeps {
  webhooks: WebhookStore;
  jobQueue?: AutomationJobQueue<WebhookFireJob>;
  admittedWork?: AdmittedWork;
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

function renderPayload(parsed: unknown, rawBody: string): string {
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
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
  };

  const pending = new Set<Promise<void>>();
  async function fire(job: WebhookFireJob, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const wh = await deps.webhooks.get(job.webhookId);
    const fireKey = `webhook:${job.webhookId}:${job.deliveryId}`;
    if (!wh || !wh.enabled || wh.archived) {
      await deps.webhooks.finishFire(job.webhookId, {
        fireKey,
        threadRef: fireKey,
        firedAt: job.receivedAt,
        endedAt: Date.now(),
        status: "refused",
        note: "Webhook disabled, archived, or deleted before execution",
        deliveryId: job.deliveryId,
        payload: job.payload,
      });
      return;
    }
    const deliveryId = job.deliveryId;
    const destination: Destination | undefined = wh.destination;
    const outcome = await runRecordedTrigger(
      { ...triggerDeps, run: (request) => withAbort(() => deps.run(request), signal) },
      {
        owner: wh.owner,
        ownerScopeId: wh.ownerScopeId,
        input: job.input,
        securityScreenData: job.payload,
        fireKey,
        surface: "webhook",
        title: wh.title ?? normalizeAutomationTitle(wh.action) ?? "Webhook run",
        ...(destination ? { destination } : {}),
        recipientConsentRequired: true,
        ...(wh.recipientConsent ? { recipientConsent: wh.recipientConsent } : {}),
        errorNotice: (s) => `⚠️ Webhook did not complete: ${s}`,
      },
      {
        entry: {
          fireKey,
          threadRef: fireKey,
          firedAt: job.receivedAt,
          status: "running",
          payload: job.payload,
          deliveryId,
        },
        begin: (entry) => deps.webhooks.beginFire(wh.id, entry),
        record: (entry) => deps.webhooks.finishFire(wh.id, entry),
        now: Date.now,
      },
    );

    if (!outcome.ran && !outcome.authzFailed) return;
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
  }
  function trackedFire(job: WebhookFireJob, signal?: AbortSignal) {
    const work = deps.admittedWork ? deps.admittedWork.run(() => fire(job, signal)) : fire(job, signal);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }
  let starting: Promise<void> | undefined;
  return {
    start() {
      return (starting ??=
        deps.jobQueue?.start({ onFire: trackedFire }).catch((error) => {
          starting = undefined;
          throw error;
        }) ?? Promise.resolve());
    },
    async stopClaims() {
      await starting?.catch(() => {});
      await deps.jobQueue?.stopClaims?.();
      starting = undefined;
    },
    async drained() {
      while (pending.size) await Promise.allSettled(pending);
    },
    async stop() {
      await this.stopClaims();
      await this.drained();
      await deps.jobQueue?.stop();
    },
    async deliver(id, req) {
      const wh = await deps.webhooks.get(id);
      if (!wh || !wh.enabled || wh.archived) return { status: 404 };

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

      const payload = renderPayload(parsed, req.rawBody);
      const receivedAt = Date.now();
      const receipt = await deps.webhooks.recordEvent(wh.id, {
        deliveryId,
        receivedAt,
        payload,
      });

      const job: WebhookFireJob = {
        webhookId: wh.id,
        deliveryId,
        receivedAt: receipt.receivedAt,
        input: buildWebhookWakeEnvelope({
          webhookId: wh.id,
          scheme: wh.verification.scheme,
          deliveryId,
          at: new Date(receipt.receivedAt),
          action: wh.action,
          payload: receipt.payload,
        }),
        payload: receipt.payload,
      };
      if (deps.jobQueue) await deps.jobQueue.enqueueFire(job);
      else void trackedFire(job).catch((error: unknown) => reportFailure("webhook: fire", error, `webhook=${wh.id}`));

      return { status: 202 };
    },
  };
}
