import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { currentTenant } from "../src/tenants/context.ts";
import {
  exerciseDeliveryExpiry,
  exerciseDeliveryExpiryRevive,
  exerciseDeliveryFail,
  exerciseDeliveryStore,
} from "./delivery-store-contract.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres delivery-store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS deliveries CASCADE");
  await p.end();
});

test("pg delivery store: idempotent enqueue, pending-by-type, ack, get", { skip }, async () => {
  await exerciseDeliveryStore(createPostgresDeliveryStore(URL!));
});

test("pg delivery store: recovered reply text is safe to persist and retry", { skip }, async () => {
  const store = createPostgresDeliveryStore(URL!);
  const input = {
    destination: { type: "slack" as const, target: "C-recovered" },
    text: "\u0000Report\u0000 ready 🚀\n\uD800end\uDC00\u0000",
    idempotencyKey: "recovered-reply",
  };
  const queued = await store.enqueue(input);
  assert.equal(queued.text, "Report ready 🚀\n\uFFFDend\uFFFD");
  assert.equal((await store.get(queued.id))?.text, queued.text);
  const duplicate = await store.enqueue(input);
  assert.equal(duplicate.id, queued.id);
  assert.equal(duplicate.text, queued.text);
  await store.ack(queued.id, Date.now());
});

test("pg delivery store: the queue survives across store instances (deploy/multi-instance)", { skip }, async () => {
  const writer = createPostgresDeliveryStore(URL!);
  const queued = await writer.enqueue({
    destination: { type: "slack", target: "C-durable" },
    text: "survives a deploy",
    idempotencyKey: "fire-durable",
  });

  const reader = createPostgresDeliveryStore(URL!);
  const pending = await reader.pending("slack");
  assert.ok(
    pending.some((p) => p.id === queued.id),
    "another instance reads the queued delivery",
  );
  assert.equal((await reader.get(queued.id))?.text, "survives a deploy");

  await reader.ack(queued.id, 999);
  assert.equal(
    (await writer.pending("slack")).some((p) => p.id === queued.id),
    false,
  );
  assert.equal((await writer.get(queued.id))?.deliveredAt, 999);

  const dup = await reader.enqueue({
    destination: { type: "slack", target: "C-durable" },
    text: "retry after deploy",
    idempotencyKey: "fire-durable",
  });
  assert.equal(dup.id, queued.id, "idempotency keys dedupe across instances");
});

test(
  "pg delivery store: concurrent claims from two instances never hand out the same row (rolling-deploy race)",
  { skip },
  async () => {
    const oldTask = createPostgresDeliveryStore(URL!);
    const newTask = createPostgresDeliveryStore(URL!);
    const queued = await oldTask.enqueue({
      destination: { type: "group", target: "C-overlap" },
      text: "enqueued mid-deploy",
      idempotencyKey: "fire-overlap",
    });
    const [a, b] = await Promise.all([oldTask.claimPending("group", 15_000), newTask.claimPending("group", 15_000)]);
    assert.equal(a.length + b.length, 1, "exactly one instance claims the row");
    assert.equal([...a, ...b][0]!.id, queued.id);
    await oldTask.ack(queued.id, 111);
  },
);

test("pg delivery store: one target's same-millisecond rows are claimed in creation order", { skip }, async (t) => {
  const store = createPostgresDeliveryStore(URL!);
  const enqueue = (i: number, text: string) =>
    store.enqueue({ destination: { type: "webhook", target: `tie-${i}` }, text, idempotencyKey: `tie-${i}-${text}` });
  for (let i = 0; i < 20; i += 2) await enqueue(i, "second");
  await createPostgresDeliveryStore(URL!, { maxAgeMs: 0 }).claimDue("webhook", 60_000);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (let i = 0; i < 20; i++) for (const text of ["first", "second"]) await enqueue(i, text);
  t.mock.restoreAll();
  const sent = new Map<string, string[]>();
  for (let rows; (rows = await store.claimDue("webhook", 60_000)).length;)
    for (const d of rows) {
      sent.set(d.destination.target, [...(sent.get(d.destination.target) ?? []), d.text]);
      await store.ack(d.id, now);
    }
  assert.deepEqual(new Set([...sent.values()].map(String)), new Set(["first,second"]));
});

test("pg delivery store: undelivered rows expire after the TTL instead of clogging the queue", { skip }, async () => {
  await exerciseDeliveryExpiry((opts) => createPostgresDeliveryStore(URL!, opts));
});

test("pg delivery store: once-ever keys revive after a TTL drop instead of deadlocking", { skip }, async () => {
  await exerciseDeliveryExpiryRevive((opts) => createPostgresDeliveryStore(URL!, opts));
});

test("pg delivery store: a permanently refused row fails once and never revives", { skip }, async () => {
  await exerciseDeliveryFail((opts) => createPostgresDeliveryStore(URL!, opts));
});

test(
  "pg delivery store: undelivered web rows beyond the oldest 200 still reach the transcript sweep",
  { skip },
  async () => {
    const store = createPostgresDeliveryStore(URL!);
    const ids = new Set<string>();
    for (let i = 0; i < 205; i++) {
      const queued = await store.enqueue({
        destination: { type: "web", target: "web:backlog" },
        text: `backlog ${i}`,
        idempotencyKey: `web-backlog-${i}`,
      });
      ids.add(queued.id);
    }
    assert.ok((await store.undeliveredTenants("web")).some((row) => row.tenantId === currentTenant()));
    const listed = new Set((await store.pending("web")).map((row) => row.id));
    for (const id of ids) assert.ok(listed.has(id));
    for (const id of ids) await store.ack(id, Date.now());
  },
);
