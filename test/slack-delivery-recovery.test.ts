import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { statusPlaceholderKey } from "../src/slack/lib.ts";

const RECOVERED_AGE_MS = 60_000;

function harness(opts: { thread?: Array<Record<string, unknown>>; errors?: Record<string, string> }) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const record =
    (method: string, result: unknown = {}) =>
    async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      const error = opts.errors?.[method];
      if (error) throw Object.assign(new Error(error), { data: { error } });
      return typeof result === "function" ? result(args) : result;
    };
  const client = {
    conversations: {
      replies: record("conversations.replies", () => ({ messages: opts.thread ?? [] })),
      history: record("conversations.history", () => ({ messages: opts.thread ?? [] })),
    },
    reactions: { add: record("reactions.add") },
    pins: { add: record("pins.add"), remove: record("pins.remove") },
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

for (const [label, destination, method, error] of [
  ["reaction", { react: { messageTs: "100.200", emoji: "eyes" } }, "reactions.add", "already_reacted"],
  ["pin", { pin: { messageTs: "100.200" } }, "pins.add", "already_pinned"],
  ["unpin", { pin: { messageTs: "100.200", remove: true } }, "pins.remove", "no_pin"],
  ["unpin", { pin: { messageTs: "100.200", remove: true } }, "pins.remove", "not_pinned"],
  ["delete", { delete: { messageTs: "100.500" } }, "chat.delete", "message_not_found"],
] as const) {
  test(`a recovered ${label} row acts without probing and acks when Slack answers ${error}`, async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      const h = harness({ errors: { [method]: error } });
      await h.deliver({ destination, ageMs: RECOVERED_AGE_MS });
      assert.deepEqual(h.methods(), [method]);
      assert.deepEqual(h.acknowledgements, ["D1"]);
      assert.deepEqual(errors, []);
    } finally {
      console.error = original;
    }
  });
}

test("a delete refused for a reason other than a missing message still acks but is logged", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const h = harness({ errors: { "chat.delete": "cant_delete_message" } });
    await h.deliver({ destination: { delete: { messageTs: "100.500" } }, ageMs: RECOVERED_AGE_MS });
    assert.deepEqual(h.acknowledgements, ["D1"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /cant_delete_message/);
  } finally {
    console.error = original;
  }
});

test("fresh and recovered reaction, pin and delete rows act directly", async () => {
  for (const ageMs of [0, RECOVERED_AGE_MS]) {
    const react = harness({});
    await react.deliver({ destination: { react: { messageTs: "100.200", emoji: "eyes" } }, ageMs });
    assert.deepEqual(react.methods(), ["reactions.add"]);
    assert.deepEqual(react.acknowledgements, ["D1"]);

    const pin = harness({});
    await pin.deliver({ destination: { pin: { messageTs: "100.200" } }, ageMs });
    assert.deepEqual(pin.methods(), ["pins.add"]);

    const remove = harness({});
    await remove.deliver({ destination: { delete: { messageTs: "100.500" } }, ageMs });
    assert.deepEqual(remove.methods(), ["chat.delete"]);
    assert.equal(remove.calls[0]!.args.ts, "100.500");
    assert.deepEqual(remove.acknowledgements, ["D1"]);
  }
});
