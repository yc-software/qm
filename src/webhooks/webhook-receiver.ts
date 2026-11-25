import type { Webhook } from "../triggers/types.ts";
import type { WebhookFire, WebhookStore } from "./webhook-store.ts";
import { getVerifier, type VerifierInput } from "./verifiers.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWebhookWakeEnvelope, capForEscaping } from "../wake/wake-envelope.ts";
import { errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import { TransientTurnFailure } from "../core/turn-error.ts";
import { DEFAULT_FIRE_RUNNING_STALE_MS, redriveHandedOffFires } from "../triggers/redrive.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { claimThenBind } from "../tenants/claim.ts";

export type DeliverResult =
  { status: 202 } | { status: 200; body: string } | { status: 401; reason?: string } | { status: 404 };

export interface WebhookReceiver {
  deliver(id: string, req: Omit<VerifierInput, "secret">): Promise<DeliverResult>;
  redrive(now: number): Promise<void>;
}

export interface WebhookReceiverDeps extends TriggerDeps {
  webhooks: WebhookStore;
  advisoryLock: AdvisoryLock;
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

function renderEvent(parsed: unknown, rawBody: string): string {
  const pretty = isObj(parsed) || Array.isArray(parsed) ? JSON.stringify(parsed, null, 2) : rawBody;
  const kept = capForEscaping(pretty, MAX_EVENT_CHARS, "head");
  return kept.length < pretty.length ? `${kept}\n…[truncated]` : kept;
}

function dropReason(wh: Webhook | null, fire: WebhookFire, now: number): string | undefined {
  if (!wh) return "its webhook was deleted";
  if (!wh.enabled) return "its webhook is disabled";
  if (fire.receivedAt < now - DEFAULT_FIRE_RUNNING_STALE_MS) return "it stayed unfinished for over 24 hours";
  return undefined;
}

function wakeInput(wh: Webhook, deliveryId: string, payload: string, at: number): string {
  return buildWebhookWakeEnvelope({
    webhookId: wh.id,
    scheme: wh.verification.scheme,
    deliveryId,
    at: new Date(at),
    action: wh.action,
    payload,
  });
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

  return {
    async deliver(id, req) {
      const wh = await deps.webhooks.get(id);
      if (!wh || !wh.enabled) return { status: 404 };

      const verifier = getVerifier(wh.verification.scheme);
      if (!verifier) return { status: 404 };

      const input: VerifierInput = {
        ...(wh.verification.secret ? { secret: wh.verification.secret } : {}),
        ...req,
      };
      const verdict = verifier.verify(input);
      if (verdict !== true) return { status: 401, ...(verdict ? { reason: verdict } : {}) };

      const parsed = parseBody(req.headers, req.rawBody);

      const hs = verifier.handshake?.(input, parsed);
      if (hs != null) return { status: 200, body: hs };

      if (!passesFilters(wh.filters, parsed)) return { status: 200, body: "skipped" };

      const deliveryId = verifier.deliveryId(input);
      const fireKey = `webhook:${wh.id}:${deliveryId}`;
      if (await deps.idempotency.committed(fireKey)) return { status: 200, body: "duplicate" };

      const payload = renderEvent(parsed, req.rawBody);
      const receivedAt = Date.now();
      await deps.webhooks.recordEvent(wh.id, { deliveryId, receivedAt, payload });

      const fire = { fireKey, webhookId: wh.id, deliveryId, receivedAt, payload };
      await deps.webhooks.beginFire(fire);
      startFire(wh, fire);
      return { status: 202 };
    },

    async redrive(now) {
      await claimThenBind(deps.webhooks.claimFireTenants, async () => {
        await redriveHandedOffFires(
          (await deps.webhooks.unsettledFires()).map((fire) => ({ ...fire, firedAt: fire.receivedAt })),
          {
            now,
            idempotency: deps.idempotency,
            refire: async (fire) => {
              const wh = await deps.webhooks.get(fire.webhookId);
              const dropped = dropReason(wh, fire, now);
              if (!wh || dropped) {
                await deps.webhooks.settleFire(fire.fireKey);
                console.warn(`[webhook] dropped handed-off fire ${fire.fireKey}: ${dropped}`);
                if (wh)
                  await deps.webhooks.recordFire(wh.id, {
                    at: now,
                    error: `delivery ${fire.deliveryId} was cut off by a restart and not re-driven because ${dropped}`,
                  });
                return;
              }
              startFire(wh, fire);
            },
          },
        );
      });
    },
  };

  function startFire(wh: Webhook, fire: WebhookFire): void {
    const { fireKey, deliveryId } = fire;
    const settle = () =>
      deps.webhooks.settleFire(fireKey).catch(reportFailureAs("webhook: settle fire", undefined, `webhook=${wh.id}`));
    void deps.advisoryLock
      .tryWithLock(`webhook-fire:${fireKey}`, () =>
        runTrigger(triggerDeps, {
          owner: wh.owner,
          ownerScopeId: wh.ownerScopeId,
          input: wakeInput(wh, deliveryId, fire.payload, fire.receivedAt),
          securityScreenData: fire.payload,
          fireKey,
          surface: "webhook",
          sourceId: wh.id,
          redrivesHandOff: true,
          ...(wh.title ? { title: wh.title } : {}),
          ...(wh.destination ? { destination: wh.destination } : {}),
          errorNotice: (s) => `⚠️ Webhook did not complete: ${s}`,
        }),
      )
      .then(async (outcome) => {
        if (!outcome) return;
        if (outcome.ran || outcome.authzFailed || (await deps.idempotency.committed(fireKey))) await settle();
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
      })
      .catch(async (e: unknown) => {
        if (e instanceof TransientTurnFailure) {
          console.warn(`[webhook] ${fireKey} handed off for re-drive after restart: ${e.message}`);
          return;
        }
        await settle();
        const msg = errMessage(e);
        void deps.webhooks
          .recordFire(wh.id, { at: Date.now(), error: msg })
          .catch(reportFailureAs("webhook: persist fire failure", undefined, `webhook=${wh.id}`));
        reportFailure("webhook: fire", e, `webhook=${wh.id}`);
      });
  }
}
