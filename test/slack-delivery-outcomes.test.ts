import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackDeliverer } from "../src/slack/deliveries.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createThreadTracker } from "../src/slack/message-gating.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CLAIM_MS = 300;

function agent() {
  const store = createDeliveryStore();
  const posted: Array<{ relay: string; text: string; ts: string; metadata?: unknown }> = [];
  const makeClient = (
    relay: string,
    slowTextMs: Record<string, number> = {},
    failTextCode: Record<string, string> = {},
  ) => ({
    chat: {
      async postMessage(args: { text?: string; channel: string; metadata?: unknown }) {
        const failCode = Object.entries(failTextCode).find(([k]) => args.text?.includes(k))?.[1];
        if (failCode)
          throw Object.assign(new Error(`An API error occurred: ${failCode}`), { data: { error: failCode } });
        const delay = Object.entries(slowTextMs).find(([k]) => args.text?.includes(k))?.[1];
        if (delay) await sleep(delay);
        const ts = `${Date.now() / 1000}`;
        posted.push({ relay, text: String(args.text), ts, metadata: args.metadata });
        return { ok: true, ts, channel: args.channel };
      },
      async update() {
        return { ok: true };
      },
      async delete() {
        return { ok: true };
      },
    },
    conversations: {
      async history() {
        return { messages: posted.map((p) => ({ ts: p.ts, metadata: p.metadata })) };
      },
      async replies() {
        return { messages: posted.map((p) => ({ ts: p.ts, metadata: p.metadata })) };
      },
    },
    pins: {
      async add() {
        return {};
      },
      async remove() {
        return {};
      },
    },
  });
  const undeliverable: Array<{ id: string; reason: string }> = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const deliverer = createSlackDeliverer({
    core: {
      ackDelivery: async (id: string) => {
        await store.ack(id, Date.now());
      },
      reportDeliveryUndeliverable: async (id: string, reason: string) => {
        undeliverable.push({ id, reason });
      },
      failDelivery: async (id: string, reason: string) => {
        failed.push({ id, reason });
        await store.fail(id, reason, Date.now());
      },
    } as never,
    flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
    threads: createThreadTracker(),
    clientForIdentity: () => makeClient("identity"),
  });
  const drain = async (client: unknown): Promise<void> => {
    for (const d of await store.claimDue("slack", CLAIM_MS)) await deliverer.deliver(client, d);
  };
  return { store, posted, makeClient, drain, undeliverable, failed, deliverer };
}

test("a permanently failing post reports an undeliverable event but the row survives for the TTL", async () => {
  const { store, posted, makeClient, drain, undeliverable } = agent();
  const dead = await store.enqueue({
    destination: { type: "slack", target: "C-deleted:100.0" },
    text: "DEADCHAN notice",
    idempotencyKey: "post:dead:a",
  });
  const live = await store.enqueue({
    destination: { type: "slack", target: "C-live:100.0" },
    text: "healthy message",
    idempotencyKey: "post:dead:b",
  });
  for (let i = 0; i < 8 && undeliverable.length === 0; i++) {
    await drain(makeClient("relay", {}, { DEADCHAN: "channel_not_found" }));
    await sleep(CLAIM_MS + 50);
  }
  assert.deepEqual(
    undeliverable,
    [{ id: dead.id, reason: "channel_not_found" }],
    "the permanent code is reported to the error log once the tracker gives up",
  );
  assert.equal((await store.get(dead.id))?.expiredAt, undefined, "error codes never terminate a row");
  assert.ok(
    (await store.pending("slack")).some((d) => d.id === dead.id),
    "the row stays queued for the TTL",
  );
  assert.equal((await store.get(live.id))?.deliveredAt !== null, true, "the healthy row behind it still posts");
  assert.equal(
    posted.some((p) => p.text.includes("DEADCHAN")),
    false,
  );
});

test("a transient post error is retried, never dropped", async () => {
  const { store, makeClient, drain, undeliverable, posted } = agent();
  const flaky = await store.enqueue({
    destination: { type: "slack", target: "C-flaky:100.0" },
    text: "FLAKY message",
    idempotencyKey: "post:flaky:a",
  });
  await drain(makeClient("relay", {}, { FLAKY: "ratelimited" }));
  await sleep(20);
  assert.equal(undeliverable.length, 0, "a transient code is never reported as undeliverable");
  assert.equal((await store.get(flaky.id))?.expiredAt, undefined);
  await sleep(CLAIM_MS + 50);
  await drain(makeClient("relay"));
  await sleep(20);
  assert.equal(
    posted.some((p) => p.text.includes("FLAKY")),
    true,
    "the row posts once the destination recovers",
  );
});

test("a redeployed poller finds a finalized-in-place reply by its marker and re-posts nothing", async () => {
  const { store, drain } = agent();
  const marker = { event_type: "qm_delivery", event_payload: { idempotency_key: "run:R1" } };
  const posts: unknown[] = [];
  const scans: string[] = [];
  const client = {
    chat: {
      async postMessage(args: { channel: string }) {
        posts.push(args);
        return { ok: true, ts: "200.1", channel: args.channel };
      },
      async update() {
        throw new Error("msg_too_long");
      },
      async delete() {
        return { ok: true };
      },
    },
    conversations: {
      async history() {
        return { messages: [] };
      },
      async replies(args: { oldest: string }) {
        scans.push(args.oldest);
        return { messages: Number(args.oldest) <= 100.5 ? [{ ts: "100.5", metadata: marker }] : [] };
      },
    },
    files: {
      async uploadV2() {
        throw new Error("attachments already delivered live must not be replayed");
      },
    },
    pins: {
      async add() {
        return {};
      },
      async remove() {
        return {};
      },
    },
  };
  const d = await store.enqueue({
    destination: { type: "slack", target: "C1:100.0", editRef: "100.5" },
    text: "final reply",
    attachments: [{ name: "a.txt", mimetype: "text/plain", sizeBytes: 1, blobId: "b1" }],
    idempotencyKey: "run:R1",
  });
  d.createdAt = Date.now() - 60_000;
  await drain(client);
  assert.ok(scans.length >= 1, "the recovery probe scanned the thread");
  assert.ok(
    scans.every((oldest) => Number(oldest) <= 100.5),
    `the probe window must reach back to the edited task message, scanned from: ${scans.join(", ")}`,
  );
  assert.deepEqual(posts, [], "the live handler's finalized reply is found by its marker — never re-posted");
  assert.equal((await store.pending("slack")).length, 0, "the delivery is acked");
});

test("an in-place recovery of a marked task-list reply does not replay attachments", async () => {
  const { store, drain } = agent();
  const marker = { event_type: "qm_delivery", event_payload: { idempotency_key: "run:R2" } };
  const posts: unknown[] = [];
  const updates: unknown[] = [];
  const uploads: unknown[] = [];
  const client = {
    chat: {
      async postMessage(args: { channel: string }) {
        posts.push(args);
        return { ok: true, ts: "300.1", channel: args.channel };
      },
      async update(args: unknown) {
        updates.push(args);
        return { ok: true };
      },
      async delete() {
        return { ok: true };
      },
    },
    conversations: {
      async history() {
        return { messages: [] };
      },
      async replies(args: { oldest: string }) {
        return { messages: Number(args.oldest) <= 100.5 ? [{ ts: "100.5", metadata: marker }] : [] };
      },
    },
    files: {
      async uploadV2(args: unknown) {
        uploads.push(args);
        return { ok: true };
      },
    },
    pins: {
      async add() {
        return {};
      },
      async remove() {
        return {};
      },
    },
  };
  const d = await store.enqueue({
    destination: { type: "slack", target: "C1:100.0", editRef: "100.5" },
    text: "final reply",
    attachments: [{ name: "a.txt", mimetype: "text/plain", sizeBytes: 1, blobId: "b1" }],
    idempotencyKey: "run:R2",
  });
  d.createdAt = Date.now() - 60_000;
  await drain(client);
  assert.equal(updates.length, 1, "the recovered reply is finalized in place");
  assert.deepEqual(posts, [], "no fallback post");
  assert.deepEqual(uploads, [], "attachments behind a delivered marker are not replayed");
  assert.equal((await store.pending("slack")).length, 0, "the delivery is acked");
});

test("a post Slack refuses for good (DM to a bot) fails the row on the first attempt", async () => {
  const { store, makeClient, drain, failed } = agent();
  const dead = await store.enqueue({
    destination: { type: "slack", target: "D-bot:100.0" },
    text: "BOTDM approval card",
    idempotencyKey: "post:bot:a",
  });
  const live = await store.enqueue({
    destination: { type: "slack", target: "C-live:100.0" },
    text: "healthy message",
    idempotencyKey: "post:bot:b",
  });
  for (let i = 0; i < 4; i++) {
    await drain(makeClient("relay", {}, { BOTDM: "cannot_dm_bot" }));
    await sleep(CLAIM_MS + 50);
  }
  assert.deepEqual(failed, [{ id: dead.id, reason: "cannot_dm_bot" }], "failed exactly once, no retries");
  assert.equal((await store.get(dead.id))?.failedReason, "cannot_dm_bot");
  assert.equal((await store.pending("slack")).length, 0, "nothing left queued");
  assert.equal((await store.get(live.id))?.deliveredAt !== null, true);
});

test("a rate-limited pin is handed back to the dispatcher instead of being acked", async () => {
  const { store, makeClient, deliverer } = agent();
  const d = await store.enqueue({
    destination: { type: "slack", target: "C-pin:100.0", pin: { messageTs: "100.0" } },
    text: "",
    idempotencyKey: "pin:limited",
  });
  const client = makeClient("a");
  client.pins.add = async () => {
    throw Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 3 });
  };
  const [claimed] = await store.claimDue("slack", CLAIM_MS);
  await assert.rejects(deliverer.deliver(client, claimed!), /rate limited/);
  assert.equal((await store.get(d.id))!.deliveredAt, null);
});
