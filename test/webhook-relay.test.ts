import { test } from "node:test";
import assert from "node:assert/strict";
import { startOutboundRelay } from "../src/delivery/relay.ts";
import { webhookChannel } from "../src/delivery/webhook-channel.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import type { Delivery } from "../src/types.ts";

const secret = "s".repeat(32);
const row = (id: string): Delivery => ({
  id,
  destination: {
    type: "webhook",
    target: "web:alice:conversation",
    webhook: { binding: "binding", url: "https://receiver.example/qm/deliveries?v=1" },
  },
  text: `update ${id}`,
  idempotencyKey: id,
  createdAt: Date.now(),
  deliveredAt: null,
});

async function relay(statuses: number[], rows: Delivery[]) {
  const posts: Request[] = [];
  const acked: string[] = [];
  const failed: [string, string][] = [];
  let queue = [...rows];
  let drained!: () => void;
  const done = new Promise<void>((resolve) => (drained = resolve));
  const fetcher = (async (url: URL, init: RequestInit) => {
    posts.push(new Request(url, init));
    return new Response(null, { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  const handle = startOutboundRelay(webhookChannel(secret, fetcher), {
    claim: async () => {
      const claimed = queue;
      queue = [];
      if (!claimed.length) setTimeout(drained, 10);
      return claimed;
    },
    ack: async (id) => void acked.push(id),
    fail: async (id, reason) => void failed.push([id, reason]),
    lease: createNoopLeaderLease(),
    onEnqueued: () => () => {},
  });
  await Promise.race([done, new Promise((r) => setTimeout(r, 200))]);
  handle.stop();
  return { posts, acked, failed };
}

test("the webhook relay signs each delivery for its bound receiver and acks accepted ones", async () => {
  const { posts, acked, failed } = await relay([200], [row("d1")]);
  assert.deepEqual(acked, ["d1"]);
  assert.deepEqual(failed, []);
  const post = posts[0]!;
  assert.equal(post.url, "https://receiver.example/qm/deliveries?v=1");
  const body = await post.text();
  assert.equal(JSON.parse(body).id, "d1");
  const ts = Number(post.headers.get("x-timestamp"));
  assert.equal(post.headers.get("x-signature"), signRequest(secret, ts, `POST\n/qm/deliveries?v=1\n${body}`));
});

test("a refused delivery is failed with its reason and an unavailable receiver stops the drain in order", async () => {
  const refused = await relay([422, 200], [row("d1"), row("d2")]);
  assert.deepEqual(refused.failed, [["d1", "receiver returned HTTP 422"]]);
  assert.deepEqual(refused.acked, ["d2"]);
  const down = await relay([503, 200], [row("d1"), row("d2")]);
  assert.equal(down.posts.length, 1);
  assert.deepEqual([...down.acked, ...down.failed], []);
});
