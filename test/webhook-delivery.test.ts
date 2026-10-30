import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { createWebhookDeliveryWorker } from "../src/delivery/webhook-delivery.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { deliveryCandidatesFor } from "../src/core/orchestrator/turn-helpers.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId } from "../src/types.ts";

const threadRef = "web:alice@example.test:conversation";
const ownerScope = scopeId("personal", "alice@example.test");
const destination = {
  type: "webhook",
  target: threadRef,
  webhook: { binding: "00000000-0000-4000-8000-000000000001" },
  audienceScopeId: ownerScope,
};
const receiver = {
  url: "https://receiver.example.test/deliveries/1",
  secret: "a-distinct-delivery-secret-with-32-bytes",
};

async function setup() {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread(threadRef, "dm", ownerScope, undefined, "web");
  const deliveries = withWebTranscriptDeliveries(createDeliveryStore(), sessions);
  const delivery = await deliveries.enqueue({
    destination,
    text: "Your scheduled update",
    idempotencyKey: "cron:1:occurrence:1",
    provenance: {
      trigger: "cron",
      surface: "cron",
      sourceScopeId: ownerScope,
      sourceThreadRef: "cron:1",
      fireKey: "cron:1:occurrence:1",
    },
  });
  return { sessions, session, deliveries, delivery };
}

test("a scheduled destination retains its binding and reaches the receiver with a verifiable signature", async () => {
  const { sessions, session, deliveries, delivery } = await setup();
  const candidate = deliveryCandidatesFor(
    { surface: "web", deliveryTarget: threadRef, deliveryWebhook: destination.webhook },
    ownerScope,
  ).candidates[0]!;
  assert.deepEqual(candidate.webhook, destination.webhook);
  assert.equal(candidate.type, "webhook");
  assert.deepEqual(await deliveries.pending("web"), []);
  const worker = createWebhookDeliveryWorker(deliveries, sessions, receiver, async (url, options) => {
    assert.equal(String(url), receiver.url);
    assert.equal(options?.redirect, "error");
    const headers = options?.headers as Record<string, string>;
    const expected = signedRequestHeaders(
      receiver.secret,
      "POST",
      "/deliveries/1",
      String(options?.body),
      { "content-type": "application/json" },
      Number(headers["x-timestamp"]),
    );
    assert.deepEqual(headers, expected);
    assert.equal(JSON.parse(String(options?.body)).idempotencyKey, delivery.idempotencyKey);
    return new Response(null, { status: 204 });
  });
  await worker.drain();
  assert.notEqual((await deliveries.get(delivery.id))?.deliveredAt, null);
  assert.match(JSON.stringify(await sessions.getEntries(session.id)), /Your scheduled update/);
});

test("scheduled turns and their child metadata retain the webhook binding for further delivery", () => {
  const request = {
    surface: "cron",
    deliveryTarget: threadRef,
    origin: { kind: "automation" as const, destination },
  };
  const delivery = deliveryCandidatesFor(request, ownerScope);
  const candidate = delivery.candidates.find((item) => item.key === delivery.defaultKey)!;
  assert.equal(candidate.type, "webhook");
  assert.deepEqual(candidate.webhook, destination.webhook);
  const withoutTarget = deliveryCandidatesFor({ ...request, deliveryTarget: undefined }, ownerScope);
  assert.deepEqual(withoutTarget.candidates, []);
});

test("a restart retries the same identity after a lost acknowledgement and records context only once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.method(console, "error", () => {});
  const { sessions, session, deliveries, delivery } = await setup();
  const received = new Set<string>();
  let attempts = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    received.add(JSON.parse(String(options?.body)).idempotencyKey);
    if (++attempts === 1) throw new Error("acknowledgement lost");
    return new Response(null, { status: 204 });
  };
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  assert.equal((await deliveries.get(delivery.id))?.deliveredAt, null);
  t.mock.timers.tick(31_000);
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  assert.equal(attempts, 2);
  assert.equal(received.size, 1);
  assert.equal((await sessions.getEntries(session.id)).length, 1);
  assert.notEqual((await deliveries.get(delivery.id))?.deliveredAt, null);
});

test("busy context delays publication until it can be recorded, even after ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { sessions, session, deliveries, delivery } = await setup();
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  let attempts = 0;
  const fetcher: typeof fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  assert.equal(attempts, 0);
  assert.equal((await sessions.getEntries(session.id)).length, 0);
  assert.equal((await deliveries.get(delivery.id))?.deliveredAt, null);
  await sessions.releaseLease(lease);
  t.mock.timers.tick(11 * 60_000);
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  assert.equal(attempts, 1);
  assert.equal((await sessions.getEntries(session.id)).length, 1);
  assert.notEqual((await deliveries.get(delivery.id))?.deliveredAt, null);
});

test("revocation expires the delivery without claiming it was delivered", async () => {
  const { sessions, session, deliveries, delivery } = await setup();
  await createWebhookDeliveryWorker(
    deliveries,
    sessions,
    receiver,
    async () => new Response(null, { status: 410 }),
  ).drain();
  const rejected = await deliveries.get(delivery.id);
  assert.equal(rejected?.deliveredAt, null);
  assert.ok(rejected?.expiredAt);
  assert.deepEqual(await deliveries.pending("webhook"), []);
  assert.equal((await sessions.getEntries(session.id)).length, 1);
});

test("server and authentication failures remain queued", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const status of [401, 429, 500]) {
    const { sessions, deliveries, delivery } = await setup();
    await createWebhookDeliveryWorker(
      deliveries,
      sessions,
      receiver,
      async () => new Response(null, { status }),
    ).drain();
    const pending = await deliveries.get(delivery.id);
    assert.equal(pending?.deliveredAt, null);
    assert.equal(pending?.expiredAt, undefined);
  }
});

test("permanent payload rejection delivers a bounded notice and unblocks later updates", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  for (const status of [400, 413, 422]) {
    const { sessions, deliveries, delivery } = await setup();
    delivery.attachments = Array.from({ length: 11 }, (_, i) => ({
      blobId: `blob-${i}`,
      name: `${i}.txt`,
      mimetype: "text/plain",
      sizeBytes: 1,
    }));
    delivery.provenance!.sourceRunId = "rejected-run";
    delivery.provenance!.sourceRequestId = "original-request";
    const next = await deliveries.enqueue({ destination, text: "Next update", idempotencyKey: "next" });
    const received: (typeof delivery)[] = [];
    await createWebhookDeliveryWorker(deliveries, sessions, receiver, async (_url, options) => {
      const payload = JSON.parse(String(options?.body));
      received.push(payload);
      return new Response(null, { status: payload.attachments?.length ? status : 204 });
    }).drain();
    assert.equal(received.length, 3);
    assert.equal(received[1]!.idempotencyKey, delivery.idempotencyKey);
    assert.equal(received[1]!.attachments, undefined);
    assert.equal(received[1]!.provenance?.sourceRunId, undefined);
    assert.equal(received[1]!.provenance?.sourceRequestId, "original-request");
    assert.match(received[1]!.text, /limits/);
    assert.ok(
      errors.mock.calls.some(
        ({ arguments: args }) =>
          args.join(" ").includes(`delivery=${delivery.id}`) && args.join(" ").includes(`HTTP ${status}`),
      ),
    );
    assert.notEqual((await deliveries.get(next.id))?.deliveredAt, null);
  }
});

test("a rejected failure notice stays terminal without blocking another update", async (t) => {
  t.mock.method(console, "error", () => {});
  const { sessions, deliveries, delivery } = await setup();
  const next = await deliveries.enqueue({ destination, text: "Next update", idempotencyKey: "next" });
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    return new Response(null, { status: payload.idempotencyKey === delivery.idempotencyKey ? 400 : 204 });
  }).drain();
  assert.ok((await deliveries.get(delivery.id))?.failedReason);
  assert.notEqual((await deliveries.get(next.id))?.deliveredAt, null);
});

test("a transient failure while sending the bounded notice retries the original delivery", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.method(console, "error", () => {});
  const { sessions, deliveries, delivery } = await setup();
  let failNotice = true;
  const worker = createWebhookDeliveryWorker(deliveries, sessions, receiver, async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    if (payload.text === delivery.text) return new Response(null, { status: 413 });
    return new Response(null, { status: failNotice ? 503 : 204 });
  });
  await worker.drain();
  assert.equal((await deliveries.get(delivery.id))?.expiredAt, undefined);
  failNotice = false;
  t.mock.timers.tick(31_000);
  await worker.drain();
  assert.notEqual((await deliveries.get(delivery.id))?.deliveredAt, null);
});

test(
  "a slow destination does not hold up subsequent deliveries to another destination",
  { timeout: 5_000 },
  async () => {
    const { sessions, deliveries, delivery } = await setup();
    const otherDestination = { ...destination, target: "web:alice@example.test:other" };
    await sessions.getOrCreateByThread(otherDestination.target, "dm", ownerScope, undefined, "web");
    await deliveries.enqueue({ destination: otherDestination, text: "Fast first", idempotencyKey: "fast-first" });
    await deliveries.enqueue({ destination: otherDestination, text: "Fast second", idempotencyKey: "fast-second" });
    const slow = Promise.withResolvers<Response>();
    const received: string[] = [];
    const fastSecond = Promise.withResolvers<void>();
    const draining = createWebhookDeliveryWorker(deliveries, sessions, receiver, async (_url, options) => {
      const key = JSON.parse(String(options?.body)).idempotencyKey;
      received.push(key);
      if (key === "fast-second") fastSecond.resolve();
      return key === delivery.idempotencyKey ? slow.promise : new Response(null, { status: 204 });
    }).drain();
    try {
      await fastSecond.promise;
      assert.ok(received.includes("fast-second"));
    } finally {
      slow.resolve(new Response(null, { status: 204 }));
      await draining;
    }
  },
);

test(
  "completion during a pending claim wakes the next delivery without waiting for another target",
  { timeout: 5_000 },
  async () => {
    const { sessions, deliveries, delivery } = await setup();
    const otherDestination = { ...destination, target: "web:alice@example.test:other" };
    await sessions.getOrCreateByThread(otherDestination.target, "dm", ownerScope, undefined, "web");
    await deliveries.enqueue({ destination: otherDestination, text: "First", idempotencyKey: "fast-first" });
    await deliveries.enqueue({ destination: otherDestination, text: "Second", idempotencyKey: "fast-second" });
    const claimStarted = Promise.withResolvers<void>();
    const claimGate = Promise.withResolvers<Awaited<ReturnType<typeof deliveries.claimPending>>>();
    const slow = Promise.withResolvers<Response>();
    const first = Promise.withResolvers<Response>();
    const firstStarted = Promise.withResolvers<void>();
    const fastSecond = Promise.withResolvers<void>();
    let claims = 0;
    const received: string[] = [];
    const worker = createWebhookDeliveryWorker(
      {
        ...deliveries,
        claimPending: async (...args) => {
          if (++claims === 2) {
            claimStarted.resolve();
            return claimGate.promise;
          }
          return deliveries.claimPending(...args);
        },
      },
      sessions,
      receiver,
      async (_url, options) => {
        const key = JSON.parse(String(options?.body)).idempotencyKey;
        received.push(key);
        if (key === delivery.idempotencyKey) return slow.promise;
        if (key === "fast-first") {
          firstStarted.resolve();
          return first.promise;
        }
        if (key === "fast-second") fastSecond.resolve();
        return new Response(null, { status: 204 });
      },
    );
    const draining = worker.drain();
    try {
      await firstStarted.promise;
      void worker.drain();
      await claimStarted.promise;
      first.resolve(new Response(null, { status: 204 }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      claimGate.resolve([]);
      await fastSecond.promise;
      assert.ok(received.includes("fast-second"));
    } finally {
      claimGate.resolve([]);
      first.resolve(new Response(null, { status: 204 }));
      slow.resolve(new Response(null, { status: 204 }));
      await draining;
    }
  },
);

test("both exact-message and agent crons retain the callback binding in their durable deliveries", async () => {
  for (const exact of [true, false]) {
    const { sessions, deliveries } = await setup();
    const result = await runTrigger(
      {
        deliveries,
        sessions,
        identity: createIdentityService(testMap(), { externalMembers: testMap() }),
        idempotency: createIdempotencyStore(testMap()),
        run: async () => ({ status: "ok", reply: "computed update" }),
      },
      {
        owner: "alice@example.test",
        ownerScopeId: ownerScope,
        input: "make an update",
        fireKey: `cron:2:${exact}`,
        surface: "cron",
        destination,
        ...(exact ? { message: "exact update" } : {}),
      },
    );
    assert.equal(result.ran, true);
    const delivery = (await deliveries.pending("webhook")).find((item) => item.idempotencyKey === `cron:2:${exact}`)!;
    assert.ok(delivery);
    assert.deepEqual(delivery.destination.webhook, destination.webhook);
    assert.equal(delivery.text, exact ? "exact update" : "computed update");
  }
});

test("a newer occurrence cannot overtake a failed earlier occurrence across workers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.method(console, "error", () => {});
  const { sessions, deliveries, delivery } = await setup();
  const attempts: string[] = [];
  let fail = true;
  const fetcher: typeof fetch = async (_url, options) => {
    attempts.push(JSON.parse(String(options?.body)).idempotencyKey);
    return new Response(null, { status: fail ? 500 : 204 });
  };
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  t.mock.timers.tick(1_000);
  await deliveries.enqueue({ destination, text: "second update", idempotencyKey: "cron:1:occurrence:2" });
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  assert.deepEqual(attempts, [delivery.idempotencyKey]);
  fail = false;
  t.mock.timers.tick(30_000);
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  await createWebhookDeliveryWorker(deliveries, sessions, receiver, fetcher).drain();
  assert.deepEqual(attempts, [delivery.idempotencyKey, delivery.idempotencyKey, "cron:1:occurrence:2"]);
});

test("a repeated enqueue never revives a rejected delivery", async () => {
  const { sessions, deliveries, delivery } = await setup();
  await createWebhookDeliveryWorker(
    deliveries,
    sessions,
    receiver,
    async () => new Response(null, { status: 410 }),
  ).drain();
  const repeated = await deliveries.enqueue({
    destination,
    text: delivery.text,
    idempotencyKey: delivery.idempotencyKey,
  });
  assert.ok(repeated.failedReason);
  assert.equal(repeated.deliveredAt, null);
  assert.deepEqual(await deliveries.claimPending("webhook", 30_000, 16), []);
});

test("a response body cleanup failure does not hide a terminal receiver rejection", async (t) => {
  t.mock.method(console, "error", () => {});
  const { sessions, deliveries, delivery } = await setup();
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("body stream failed"));
    },
  });
  await createWebhookDeliveryWorker(
    deliveries,
    sessions,
    receiver,
    async () => new Response(body, { status: 410 }),
  ).drain();
  assert.ok((await deliveries.get(delivery.id))?.failedReason);
});

test("same-timestamp enqueues cannot overtake an active delivery", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const deliveries = createDeliveryStore();
  const first = await deliveries.enqueue({ destination, text: "first", idempotencyKey: "first" });
  assert.deepEqual(
    (await deliveries.claimPending("webhook", 30_000, 16)).map((row) => row.id),
    [first.id],
  );
  for (let index = 0; index < 32; index++) {
    const next = await deliveries.enqueue({ destination, text: "next", idempotencyKey: `next:${index}` });
    assert.equal(next.createdAt, first.createdAt);
    assert.deepEqual(await deliveries.claimPending("webhook", 30_000, 16), []);
  }
  await deliveries.ack(first.id, Date.now());
  assert.equal((await deliveries.claimPending("webhook", 30_000, 16))[0]?.idempotencyKey, "next:0");
});
