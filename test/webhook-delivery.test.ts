import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { WEBHOOK_CLAIM_MS, webhookSender, webhookSigningKey } from "../src/delivery/webhook-delivery.ts";
import { createDeliveryRelay } from "../src/delivery/relay.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import type { Delivery } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the webhook delivery tests";

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const enqueuer = (store: ReturnType<typeof createPostgresDeliveryStore>) => (target: string, text: string) =>
  store.enqueue({ destination: { type: "webhook", target }, text, idempotencyKey: `${target}:${text}` });

test("only the oldest row of each conversation is claimed, and not while one is out", { skip }, async () => {
  const store = createPostgresDeliveryStore(testDatabaseUrl());
  const enqueue = enqueuer(store);
  const claim = async () =>
    (await store.claimPending("webhook", 300, { oldestPerConversation: true })).map((d) => d.text);
  const a1 = await enqueue("a", "a1");
  await enqueue("a", "a2");
  await enqueue("b", "b1");
  assert.deepEqual(await claim(), ["a1", "b1"]);
  await enqueue("c", "c1");
  assert.deepEqual(await claim(), ["c1"]);
  await store.ack(a1.id, Date.now());
  assert.deepEqual(await claim(), ["a2"]);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await claim(), ["a2", "b1", "c1"]);
});

test(
  "deliveries keep order per conversation, refusals fail once, and a slow receiver holds up only its own",
  { skip },
  async () => {
    const store = createPostgresDeliveryStore(testDatabaseUrl());
    const enqueue = enqueuer(store);
    const sent: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const delivery = createDeliveryRelay(store, {
      type: "webhook",
      claimMs: WEBHOOK_CLAIM_MS,
      send: async (d) => {
        if (d.text === "refuse") return { refused: "receiver returned HTTP 422" };
        if (d.text === "slow1") await slow;
        sent.push(d.text);
      },
    });
    delivery.start();
    try {
      const refused = await enqueue("c", "refuse");
      await enqueue("s", "slow1");
      await enqueue("s", "slow2");
      await enqueue("a", "a1");
      await enqueue("a", "a2");
      await until(() => sent.includes("a2"));
      await enqueue("a", "a3");
      await until(() => sent.includes("a3"));
      assert.deepEqual(sent, ["a1", "a2", "a3"], "the slow conversation holds up nobody else");
      release();
      await until(() => sent.includes("slow2"));
      assert.ok(sent.indexOf("slow1") < sent.indexOf("slow2"));
      assert.deepEqual(await store.pending("webhook"), []);
      assert.equal((await store.get(refused.id))?.failedReason, "receiver returned HTTP 422");
    } finally {
      release();
      await delivery.stop();
    }
  },
);

test("the webhook sender signs with a key core does not accept and reports refusals with the receiver's reason", async () => {
  const secret = "s".repeat(32);
  const requests: Request[] = [];
  const statuses = [200, 422, 401];
  const send = webhookSender(secret, (async (u: URL, init: RequestInit) => {
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
  assert.equal(await send(d), undefined);
  const req = requests[0]!;
  const body = await req.text();
  const ts = Number(req.headers.get("x-timestamp"));
  const canonical = `POST\n/qm?v=1\n${body}`;
  assert.equal(req.headers.get("x-signature"), signRequest(webhookSigningKey(secret), ts, canonical));
  assert.notEqual(req.headers.get("x-signature"), signRequest(secret, ts, canonical));
  assert.deepEqual(await send(d), { refused: "receiver returned HTTP 422: binding unknown" });
  await assert.rejects(send(d), /HTTP 401/, "an auth failure is retried, not refused");
});
