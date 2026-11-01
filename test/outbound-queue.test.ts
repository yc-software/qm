import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutboundQueue, type OutboundChannel } from "../src/delivery/outbound-queue.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { webhookChannel, webhookSigningKey } from "../src/delivery/webhook-channel.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import type { Delivery } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the outbound queue tests";

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test(
  "outbound deliveries keep order per conversation without one conversation holding up another",
  { skip },
  async () => {
    const url = testDatabaseUrl();
    const store = createPostgresDeliveryStore(url);
    const sent: string[] = [];
    let failuresLeft = 1;
    const channel: OutboundChannel = {
      type: "webhook",
      async send(d) {
        if (d.text === "refuse") return { refused: "receiver returned HTTP 422" };
        if (d.text === "a1" && failuresLeft-- > 0) throw new Error("receiver returned HTTP 503");
        sent.push(d.text);
      },
    };
    const queue = createOutboundQueue(url, store, [channel]);
    await queue.start();
    try {
      const enqueue = (target: string, text: string) =>
        store.enqueue({ destination: { type: "webhook", target }, text, idempotencyKey: `${target}:${text}` });
      const refused = await enqueue("conversation-c", "refuse");
      await enqueue("conversation-a", "a1");
      await enqueue("conversation-a", "a2");
      await enqueue("conversation-b", "b1");
      await until(() => sent.length === 3);
      assert.ok(sent.indexOf("b1") < sent.indexOf("a1"), "a stuck conversation does not hold up another");
      assert.ok(sent.indexOf("a1") < sent.indexOf("a2"), "a conversation keeps its order through a retry");
      assert.deepEqual(await store.pending("webhook"), []);
      assert.equal((await store.get(refused.id))?.failedReason, "receiver returned HTTP 422");
    } finally {
      await queue.stop();
    }
  },
);

test("the webhook channel signs with a key core does not accept and reports refusals with the receiver's reason", async () => {
  const secret = "s".repeat(32);
  const requests: Request[] = [];
  const statuses = [200, 422];
  const channel = webhookChannel(secret, (async (u: URL, init: RequestInit) => {
    requests.push(new Request(u, init));
    const status = statuses.shift()!;
    return new Response(status === 200 ? null : "binding unknown", { status });
  }) as typeof fetch);
  const d = {
    id: "d1",
    destination: { type: "webhook", target: "t", webhook: { binding: "b", url: "https://receiver.example/qm?v=1" } },
    text: "hi",
    idempotencyKey: "k",
    createdAt: 0,
    deliveredAt: null,
  } satisfies Delivery;
  assert.equal(await channel.send(d), undefined);
  const req = requests[0]!;
  const body = await req.text();
  const ts = Number(req.headers.get("x-timestamp"));
  const canonical = `POST\n/qm?v=1\n${body}`;
  assert.equal(req.headers.get("x-signature"), signRequest(webhookSigningKey(secret), ts, canonical));
  assert.notEqual(req.headers.get("x-signature"), signRequest(secret, ts, canonical));
  assert.deepEqual(await channel.send(d), { refused: "receiver returned HTTP 422: binding unknown" });
});
