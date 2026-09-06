import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  backfillDeliverySourceCronIdBatch,
  createPostgresDeliveryStore,
} from "../src/delivery/postgres-delivery-store.ts";
import {
  exerciseDeliveryExpiry,
  exerciseDeliveryExpiryRevive,
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

test("pg delivery store: undelivered rows expire after the TTL instead of clogging the queue", { skip }, async () => {
  await exerciseDeliveryExpiry((opts) => createPostgresDeliveryStore(URL!, opts));
});

test("pg delivery store: once-ever keys revive after a TTL drop instead of deadlocking", { skip }, async () => {
  await exerciseDeliveryExpiryRevive((opts) => createPostgresDeliveryStore(URL!, opts));
});

test(
  "pg delivery store: source_cron_id is stamped at insert and the read path survives unstamped rows",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({ connectionString: URL });
    try {
      const store = createPostgresDeliveryStore(URL!);
      const provenance = (cronId: string, sessionId: string) => ({
        trigger: "cron",
        surface: "cron",
        fireKey: `agent:main:cron:${cronId}`,
        sourceScopeId: "personal:U-carol",
        sourceThreadRef: `agent:main:cron:${cronId}`,
        sourceSessionId: sessionId,
      });
      const stamped = await store.enqueue({
        destination: { type: "principal", target: "U-alice" },
        text: "stamped at insert",
        idempotencyKey: "col:stamped",
        provenance: provenance("col-a", "run-1"),
      });
      const plain = await store.enqueue({
        destination: { type: "slack", target: "C-plain" },
        text: "no provenance at all",
        idempotencyKey: "col:plain",
      });
      const column = async (id: string) =>
        (await p.query("SELECT source_cron_id FROM deliveries WHERE id = $1", [id])).rows[0]!.source_cron_id;
      assert.equal(await column(stamped.id), "col-a");
      assert.equal(await column(plain.id), null);

      const unstamped = ["col:legacy-1", "col:legacy-2", "col:conversation"];
      await store.enqueue({
        destination: { type: "principal", target: "U-alice" },
        text: "pre-migration row",
        idempotencyKey: unstamped[0]!,
        provenance: provenance("col-a", "run-2"),
      });
      await store.enqueue({
        destination: { type: "principal", target: "U-alice" },
        text: "pre-migration row, legacy thread shape",
        idempotencyKey: unstamped[1]!,
        provenance: { ...provenance("col-b", "run-3"), sourceThreadRef: "cron:col-b:slot" },
      });
      await store.enqueue({
        destination: { type: "slack", target: "C-plain" },
        text: "pre-migration row from a conversation",
        idempotencyKey: unstamped[2]!,
        provenance: { ...provenance("col-a", "run-4"), sourceThreadRef: "ch:C1:thread" },
      });
      await p.query("UPDATE deliveries SET source_cron_id = NULL WHERE idempotency_key = ANY($1)", [unstamped]);
      const before = await store.sentRunCountsByCron(["col-a", "col-b"]);
      assert.equal(before.get("col-a"), 2, "an unstamped row still counts through the regex fallback");
      assert.equal(before.get("col-b"), 1);

      const q = async (text: string, params?: unknown[]) =>
        (await p.query(text, params)).rows as Record<string, unknown>[];
      const columns = async () =>
        (await q("SELECT idempotency_key, source_cron_id FROM deliveries WHERE idempotency_key = ANY($1)", [unstamped]))
          .map((r) => [r.idempotency_key, r.source_cron_id])
          .sort();
      let batches = 0;
      let updated = 0;
      for (
        let n = await backfillDeliverySourceCronIdBatch(q, 1);
        n > 0;
        n = await backfillDeliverySourceCronIdBatch(q, 1)
      ) {
        batches++;
        updated += n;
      }
      assert.equal(updated, 2, "the backfill touches exactly the unstamped cron rows");
      assert.equal(batches, 2, "the backfill works in bounded batches until nothing is left");
      assert.deepEqual(
        await columns(),
        [
          ["col:conversation", null],
          ["col:legacy-1", "col-a"],
          ["col:legacy-2", "col-b"],
        ],
        "the backfill derives the same values the insert path writes and leaves non-cron rows alone",
      );
      assert.deepEqual(
        await store.sentRunCountsByCron(["col-a", "col-b"]),
        before,
        "backfilled rows count identically",
      );
    } finally {
      await p.end();
    }
  },
);
