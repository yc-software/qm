import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookReceiver, type WebhookFireJob } from "../src/webhooks/webhook-receiver.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type TurnResult } from "../src/types.ts";

async function fixture(run: () => Promise<TurnResult>) {
  const webhooks = createWebhookStore();
  const webhook = await webhooks.create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    action: "Review",
    verification: { scheme: "github", secret: "secret" },
    destination: { type: "principal", target: "U1" },
  });
  const idempotency = createIdempotencyStore();
  const deliveries = createDeliveryStore();
  let fire!: (job: WebhookFireJob, signal?: AbortSignal) => Promise<void>;
  const receiver = createWebhookReceiver({
    webhooks,
    idempotency,
    deliveries,
    identity: createIdentityService(),
    run,
    jobQueue: {
      start: async (handlers) => {
        fire = handlers.onFire;
      },
      enqueueFire: async () => {},
      healthy: () => true,
      stop: async () => {},
    },
  });
  await receiver.start();
  const job = {
    webhookId: webhook.id,
    deliveryId: "delivery",
    receivedAt: Date.now(),
    input: "Review event",
    payload: "{}",
  };
  return { webhooks, webhook, idempotency, deliveries, fire, job, receiver };
}

test("completion persistence failure leaves webhook retryable and retry repairs its result", async () => {
  const f = await fixture(async () => ({ status: "ok", reply: "Completed", sessionId: "session" }));
  const finish = f.webhooks.finishFire;
  let failed = false;
  f.webhooks.finishFire = async (id, entry) => {
    if (!failed && entry.status === "ok") {
      failed = true;
      throw new Error("completion unavailable");
    }
    await finish(id, entry);
  };
  await assert.rejects(f.fire(f.job), /completion unavailable/);
  assert.equal(await f.idempotency.committed(`webhook:${f.webhook.id}:delivery`), false);
  await f.fire(f.job);
  const result = (await f.webhooks.listFires(f.webhook.id)).runs[0]!;
  assert.equal(result.status, "ok");
  assert.equal(result.reply, "Completed");
  assert.equal(result.sessionId, "session");
  assert.equal(await f.idempotency.committed(`webhook:${f.webhook.id}:delivery`), true);
  await f.receiver.stop();
});

test("an expired webhook waiter leaves the durable turn alive and only its retry publishes completion", async () => {
  const durableTurn = Promise.withResolvers<TurnResult>();
  let waits = 0;
  const f = await fixture(() => {
    waits++;
    return durableTurn.promise;
  });
  const expired = new AbortController();
  const first = f.fire(f.job, expired.signal);
  while (!waits) await new Promise((resolve) => setImmediate(resolve));
  expired.abort(new Error("queue lease expired"));
  await assert.rejects(first, /queue lease expired/);
  assert.equal(await f.idempotency.committed(`webhook:${f.webhook.id}:delivery`), false);
  const retry = f.fire(f.job, new AbortController().signal);
  while (waits < 2) await new Promise((resolve) => setImmediate(resolve));
  durableTurn.resolve({ status: "ok", reply: "Completed", sessionId: "session" });
  await retry;
  assert.equal((await f.webhooks.listFires(f.webhook.id)).runs[0]?.status, "ok");
  assert.equal((await f.deliveries.pending("principal")).length, 1);
  await f.receiver.stop();
});
