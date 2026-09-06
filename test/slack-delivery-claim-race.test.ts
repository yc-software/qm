import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createThreadTracker } from "../src/slack/message-gating.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CLAIM_MS = 300;

function harness() {
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
  const slowDrainReports: Array<{ durationMs: number; rows: number }> = [];
  const undeliverable: Array<{ id: string; reason: string }> = [];
  const makePoller = (opts: { slowDrainMs?: number } = {}) =>
    createDeliveryPoller({
      core: {
        claimDeliveries: (type: string, ms: number) => store.claimPending(type, ms),
        ackDelivery: async (id: string) => {
          await store.ack(id, Date.now());
        },
        holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
        reportSlowDeliveryDrain: async (info: { durationMs: number; rows: number }) => {
          slowDrainReports.push(info);
        },
        reportDeliveryUndeliverable: async (id: string, reason: string) => {
          undeliverable.push({ id, reason });
        },
      } as never,
      flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
      mirror: { mirrorSelfPost() {} } as never,
      threads: createThreadTracker(),
      clientForIdentity: () => makeClient("identity"),
      claimMs: CLAIM_MS,
      ...(opts.slowDrainMs !== undefined ? { slowDrainMs: opts.slowDrainMs } : {}),
    });
  return { store, posted, makeClient, makePoller, slowDrainReports, undeliverable };
}

test("a sibling relay re-claiming an expired batch does not double-post the tail delivery", async () => {
  const { store, posted, makeClient, makePoller } = harness();
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "SLOW head-of-line",
    idempotencyKey: "post:s:a",
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "Done — all 44 unpinned.",
    idempotencyKey: "post:s:b",
  });
  const relayA = makePoller().pollDeliveries(makeClient("A", { SLOW: 800 }));
  await sleep(CLAIM_MS + 100);
  const relayB = makePoller().pollDeliveries(makeClient("B"));
  await Promise.all([relayA, relayB]);
  const done = posted.filter((p) => p.text.includes("unpinned"));
  assert.equal(done.length, 1, `tail delivery must post exactly once, saw: ${JSON.stringify(done)}`);
});

test("a lone relay renews its own expired claim and still delivers the tail", async () => {
  const { store, posted, makeClient, makePoller } = harness();
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "SLOW head-of-line",
    idempotencyKey: "post:s:a",
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "tail reply",
    idempotencyKey: "post:s:b",
  });
  await makePoller().pollDeliveries(makeClient("A", { SLOW: 800 }));
  assert.deepEqual(
    posted.map((p) => p.text.includes("tail")),
    [false, true],
    "tail still delivered after claim renewal",
  );
  const pending = await store.pending("slack");
  assert.equal(pending.length, 0, "both deliveries acked");
});

test("a transient claim failure at re-claim time does not strand an owned row", async () => {
  const { store, posted, makeClient } = harness();

  let failNext = 0;
  const flakyStore = {
    ...store,
    claimPending(type: string, ms: number) {
      if (failNext > 0) {
        failNext--;
        throw new Error("transient store error");
      }
      return store.claimPending(type, ms);
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: (type: string, ms: number) => flakyStore.claimPending(type, ms),
      ackDelivery: async (id: string) => {
        await store.ack(id, Date.now());
      },
      holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    } as never,
    flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
    mirror: { mirrorSelfPost() {} } as never,
    threads: createThreadTracker(),
    clientForIdentity: () => makeClient("identity"),
    claimMs: CLAIM_MS,
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "SLOW head-of-line",
    idempotencyKey: "post:s:a",
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "tail reply",
    idempotencyKey: "post:s:b",
  });
  const run = poller.pollDeliveries(makeClient("A", { SLOW: 800 }));
  setTimeout(() => {
    failNext = 1;
  }, 700);
  await run;
  const tail = posted.filter((p) => p.text.includes("tail"));
  assert.equal(tail.length, 1, "the owned row is retried, not treated as stolen");
  assert.equal((await store.pending("slack")).length, 0, "both deliveries acked");
});

test("with a shared dispatch lease, a second relay never posts at all (single dispatcher)", async () => {
  const { store, posted, makeClient } = harness();

  let held = false;
  const lease = async (fn: (lost: Promise<void>) => Promise<unknown>): Promise<unknown> => {
    if (held) return null;
    held = true;
    try {
      return await fn(new Promise<void>(() => {}));
    } finally {
      held = false;
    }
  };
  const makeLeaderPoller = () =>
    createDeliveryPoller({
      core: {
        claimDeliveries: (type: string, ms: number) => store.claimPending(type, ms),
        ackDelivery: async (id: string) => {
          await store.ack(id, Date.now());
        },
        holdDeliveryDispatch: lease,
      } as never,
      flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
      mirror: { mirrorSelfPost() {} } as never,
      threads: createThreadTracker(),
      clientForIdentity: () => makeClient("identity"),
      claimMs: CLAIM_MS,
    });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "SLOW head-of-line",
    idempotencyKey: "post:s:a",
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "Done — all 44 unpinned.",
    idempotencyKey: "post:s:b",
  });
  const relayA = makeLeaderPoller().pollDeliveries(makeClient("A", { SLOW: 800 }));
  await sleep(CLAIM_MS + 100);
  const ranB = await makeLeaderPoller().pollDeliveries(makeClient("B"));
  assert.equal(ranB, false, "the follower is refused the dispatch lease");
  assert.equal(await relayA, true, "the leader ran");
  const done = posted.filter((p) => p.text.includes("unpinned"));
  assert.equal(done.length, 1, "exactly one post despite expired claims");
  assert.equal(done[0]!.relay, "A", "only the leader posted");
});

test("lease loss mid-drain stops posting; rows recover via the claim TTL", async () => {
  const { store, posted, makeClient } = harness();
  let notifyLost!: () => void;
  const lostPromise = new Promise<void>((r) => (notifyLost = r));
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: (type: string, ms: number) => store.claimPending(type, ms),
      ackDelivery: async (id: string) => {
        await store.ack(id, Date.now());
      },
      holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(lostPromise),
    } as never,
    flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
    mirror: { mirrorSelfPost() {} } as never,
    threads: createThreadTracker(),
    clientForIdentity: () => makeClient("identity"),
    claimMs: CLAIM_MS,
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "SLOW first",
    idempotencyKey: "post:s:a",
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "second",
    idempotencyKey: "post:s:b",
  });
  setTimeout(() => notifyLost(), 100);
  const ran = await poller.pollDeliveries(makeClient("A", { SLOW: 400 }));
  assert.equal(ran, false, "a lease-lost drain reports false so the caller retries quickly");
  assert.equal(posted.filter((p) => p.text.includes("second")).length, 0, "no posting after lease loss");
  await sleep(CLAIM_MS + 50);
  assert.equal(
    (await store.claimPending("slack", CLAIM_MS)).length,
    1,
    "the unposted row recovers for the next leader",
  );
});

test("a drain cycle slower than the alarm threshold reports exactly one slow-drain event", async () => {
  const { store, makeClient, makePoller, slowDrainReports } = harness();
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "SLOW poster",
    idempotencyKey: "post:alarm:a",
  });
  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "quick one",
    idempotencyKey: "post:alarm:b",
  });
  await makePoller({ slowDrainMs: 40 }).pollDeliveries(makeClient("relay", { SLOW: 60 }));
  await sleep(10);
  assert.equal(slowDrainReports.length, 1, "one slow cycle, one event");
  assert.equal(slowDrainReports[0]!.rows, 2);
  assert.ok(slowDrainReports[0]!.durationMs >= 40);

  await store.enqueue({
    destination: { type: "slack", target: "C1:100.0" },
    text: "fast follow-up",
    idempotencyKey: "post:alarm:c",
  });
  await makePoller().pollDeliveries(makeClient("relay"));
  await sleep(10);
  assert.equal(slowDrainReports.length, 1, "a fast cycle under the default threshold stays quiet");
});

test("a permanently failing post reports an undeliverable event but the row survives for the TTL", async () => {
  const { store, posted, makeClient, makePoller, undeliverable } = harness();
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
  const poller = makePoller();
  for (let i = 0; i < 8 && undeliverable.length === 0; i++) {
    await poller.pollDeliveries(makeClient("relay", {}, { DEADCHAN: "channel_not_found" }));
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
  const { store, makeClient, makePoller, undeliverable, posted } = harness();
  const flaky = await store.enqueue({
    destination: { type: "slack", target: "C-flaky:100.0" },
    text: "FLAKY message",
    idempotencyKey: "post:flaky:a",
  });
  const poller = makePoller();
  await poller.pollDeliveries(makeClient("relay", {}, { FLAKY: "ratelimited" }));
  await sleep(20);
  assert.equal(undeliverable.length, 0, "a transient code is never reported as undeliverable");
  assert.equal((await store.get(flaky.id))?.expiredAt, undefined);
  await sleep(CLAIM_MS + 50);
  await poller.pollDeliveries(makeClient("relay"));
  await sleep(20);
  assert.equal(
    posted.some((p) => p.text.includes("FLAKY")),
    true,
    "the row posts once the destination recovers",
  );
});

test("a redeployed poller finds a finalized-in-place reply by its marker and re-posts nothing", async () => {
  const { store, makePoller } = harness();
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
  await makePoller().pollDeliveries(client);
  assert.ok(scans.length >= 1, "the recovery probe scanned the thread");
  assert.ok(
    scans.every((oldest) => Number(oldest) <= 100.5),
    `the probe window must reach back to the edited task message, scanned from: ${scans.join(", ")}`,
  );
  assert.deepEqual(posts, [], "the live handler's finalized reply is found by its marker — never re-posted");
  assert.equal((await store.pending("slack")).length, 0, "the delivery is acked");
});

test("an in-place recovery of a marked task-list reply does not replay attachments", async () => {
  const { store, makePoller } = harness();
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
  await makePoller().pollDeliveries(client);
  assert.equal(updates.length, 1, "the recovered reply is finalized in place");
  assert.deepEqual(posts, [], "no fallback post");
  assert.deepEqual(uploads, [], "attachments behind a delivered marker are not replayed");
  assert.equal((await store.pending("slack")).length, 0, "the delivery is acked");
});
