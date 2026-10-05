import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { statusPlaceholderKey } from "../src/slack/lib.ts";

const RECOVERED_AGE_MS = 60_000;

function harness(opts: {
  thread?: Array<Record<string, unknown>>;
  reactions?: Array<{ name: string; count: number }>;
  pinned?: string[];
  repliesError?: string;
}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const record =
    (method: string, result: unknown = {}) =>
    async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === "conversations.replies" && opts.repliesError) {
        throw Object.assign(new Error(opts.repliesError), { data: { error: opts.repliesError } });
      }
      return typeof result === "function" ? result(args) : result;
    };
  const client = {
    conversations: {
      replies: record("conversations.replies", () => ({ messages: opts.thread ?? [] })),
      history: record("conversations.history", () => ({ messages: opts.thread ?? [] })),
    },
    reactions: {
      get: record("reactions.get", { message: { reactions: opts.reactions ?? [] } }),
      add: record("reactions.add"),
    },
    pins: {
      list: record("pins.list", { items: (opts.pinned ?? []).map((ts) => ({ message: { ts } })) }),
      add: record("pins.add"),
      remove: record("pins.remove"),
    },
    chat: {
      postMessage: record("chat.postMessage", { ts: "900.100" }),
      update: record("chat.update"),
      delete: record("chat.delete"),
    },
  };
  const acknowledgements: string[] = [];
  const checkpoints: Array<[string, string]> = [];
  const queue: unknown[] = [];
  const core = {
    reportRunEditRef: async (runId: string, editRef: string) => {
      checkpoints.push([runId, editRef]);
    },
    holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    claimDeliveries: async () => queue.splice(0),
    ackDelivery: async (id: string) => {
      acknowledgements.push(id);
    },
  };
  const poller = createDeliveryPoller({
    core: core as never,
    flow: { inFlightRuns: new Set<string>() } as never,
    threads: { mark: () => {} } as never,
    clientForIdentity: () => client,
  });
  return {
    calls,
    acknowledgements,
    checkpoints,
    methods: () => calls.map((c) => c.method),
    deliver: async (row: {
      destination: Record<string, unknown>;
      idempotencyKey?: string;
      text?: string;
      ageMs?: number;
    }) => {
      queue.push({
        id: "D1",
        idempotencyKey: row.idempotencyKey ?? "post:k1",
        text: row.text ?? "",
        destination: { type: "slack", target: "C1:100.200", ...row.destination },
        createdAt: Date.now() - (row.ageMs ?? 0),
      });
      await poller.pollDeliveries(client);
    },
  };
}

test("a recovered run reply adopts the status placeholder it finds by metadata instead of posting beside it", async () => {
  const h = harness({
    thread: [
      { ts: "100.200", text: "the question" },
      {
        ts: "100.300",
        text: "Working on it…",
        metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: statusPlaceholderKey("r1") } },
      },
    ],
  });
  await h.deliver({ destination: {}, idempotencyKey: "run:r1", text: "the answer", ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["conversations.replies", "chat.update"]);
  const update = h.calls[1]!.args;
  assert.equal(update.ts, "100.300");
  assert.equal(update.text, "the answer");
  assert.deepEqual(update.metadata, { event_type: "qm_delivery", event_payload: { idempotency_key: "run:r1" } });
  assert.deepEqual(
    h.checkpoints,
    [["r1", "100.300"]],
    "the adopted placeholder is checkpointed before it is finalized",
  );
  assert.deepEqual(h.acknowledgements, ["D1"]);
});

test("a recovered run reply with no placeholder in the thread posts normally after the probe", async () => {
  const h = harness({ thread: [{ ts: "100.200", text: "the question" }] });
  await h.deliver({ destination: {}, idempotencyKey: "run:r1", text: "the answer", ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["conversations.replies", "conversations.replies", "chat.postMessage"]);
  assert.equal(h.calls[2]!.args.text, "the answer");
  assert.deepEqual(h.checkpoints, []);
});

test("a recovered empty run reply deletes the orphaned placeholder it finds by metadata", async () => {
  const h = harness({
    thread: [
      {
        ts: "100.300",
        metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: statusPlaceholderKey("r1") } },
      },
    ],
  });
  await h.deliver({ destination: {}, idempotencyKey: "run:r1", text: "", ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["conversations.replies", "chat.delete"]);
  assert.equal(h.calls[1]!.args.ts, "100.300");
});

test("a recorded editRef skips the placeholder probe", async () => {
  const h = harness({});
  await h.deliver({
    destination: { editRef: "100.300" },
    idempotencyKey: "run:r1",
    text: "the answer",
    ageMs: RECOVERED_AGE_MS,
  });
  assert.deepEqual(h.methods(), ["chat.update"]);
});

test("a recovered reaction row is a no-op when Slack already shows the reaction", async () => {
  const h = harness({ reactions: [{ name: "eyes", count: 1 }] });
  await h.deliver({ destination: { react: { messageTs: "100.200", emoji: "eyes" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["reactions.get"]);
  assert.deepEqual(h.acknowledgements, ["D1"]);
});

test("a recovered reaction row still reacts when Slack lacks the reaction", async () => {
  const h = harness({ reactions: [{ name: "tada", count: 1 }] });
  await h.deliver({ destination: { react: { messageTs: "100.200", emoji: "eyes" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["reactions.get", "reactions.add"]);
});

test("a fresh reaction row reacts without probing", async () => {
  const h = harness({ reactions: [{ name: "eyes", count: 1 }] });
  await h.deliver({ destination: { react: { messageTs: "100.200", emoji: "eyes" } } });
  assert.deepEqual(h.methods(), ["reactions.add"]);
});

test("recovered pin and unpin rows are no-ops when the message is already in the requested state", async () => {
  const pinned = harness({ pinned: ["100.200"] });
  await pinned.deliver({ destination: { pin: { messageTs: "100.200" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(pinned.methods(), ["pins.list"]);
  assert.deepEqual(pinned.acknowledgements, ["D1"]);

  const unpinned = harness({ pinned: [] });
  await unpinned.deliver({ destination: { pin: { messageTs: "100.200", remove: true } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(unpinned.methods(), ["pins.list"]);
});

test("recovered pin and unpin rows act when Slack disagrees with the requested state", async () => {
  const pin = harness({ pinned: [] });
  await pin.deliver({ destination: { pin: { messageTs: "100.200" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(pin.methods(), ["pins.list", "pins.add"]);

  const unpin = harness({ pinned: ["100.200"] });
  await unpin.deliver({ destination: { pin: { messageTs: "100.200", remove: true } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(unpin.methods(), ["pins.list", "pins.remove"]);
});

test("a recovered delete row is a no-op once the message is gone", async () => {
  const gone = harness({ thread: [] });
  await gone.deliver({ destination: { delete: { messageTs: "100.500" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(gone.methods(), ["conversations.replies"]);
  assert.deepEqual(gone.acknowledgements, ["D1"]);

  const missingThread = harness({ repliesError: "thread_not_found" });
  await missingThread.deliver({ destination: { delete: { messageTs: "100.500" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(missingThread.methods(), ["conversations.replies"]);
});

test("a recovered delete row deletes when the message still exists, and a fresh row deletes without probing", async () => {
  const present = harness({ thread: [{ ts: "100.500", text: "to remove" }] });
  await present.deliver({ destination: { delete: { messageTs: "100.500" } }, ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(present.methods(), ["conversations.replies", "chat.delete"]);
  assert.equal(present.calls[0]!.args.ts, "100.500");

  const fresh = harness({ thread: [] });
  await fresh.deliver({ destination: { delete: { messageTs: "100.500" } } });
  assert.deepEqual(fresh.methods(), ["chat.delete"]);
});
