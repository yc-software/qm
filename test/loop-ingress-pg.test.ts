import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createLoopIngress, type LoopIngress, type IngressDelivery } from "../src/loops/ingress.ts";

test(
  "event import and model work reuse one PostgreSQL advisory session",
  { skip: !process.env.DATABASE_URL, timeout: 10_000 },
  async () => {
    configurePgPooling({ sessionMax: 1 });
    const pg = createPgPool(process.env.DATABASE_URL!);
    try {
      const lock = createPostgresAdvisoryLock(pg);
      const loops = createLoopStore();
      const { loop } = await loops.create({
        owner: "qa",
        createdBy: "qa",
        ownerScopeId: "personal:qa",
        name: "PG ingress",
        playbook: "Review",
        successCondition: "Reviewed",
      });
      const items = createLoopItemLedger(undefined, undefined, { lock, accepts: async () => true });
      let worked = false;
      const ingress = createLoopIngress({
        enabledFor: async () => true,
        sources: createMemoryMap<LoopIngress>(),
        deliveries: createMemoryMap<IngressDelivery>(),
        loops,
        items,
        outputs: createLoopOutputStore(),
        lock,
        fire: {
          fire: async () =>
            lock.withLock(`loop-lifecycle:${loop.id}`, async () => {
              worked = true;
              return { status: "ok" };
            }),
        },
      });
      const source = await ingress.create(loop, { kind: "webhook" });
      const rawBody = JSON.stringify({ title: "Test event" });
      await ingress.receive(source.id, {
        rawBody,
        headers: { "x-signature": createHmac("sha256", source.secret!).update(rawBody).digest("hex") },
      });
      await ingress.process(source.id);
      assert.equal(worked, true);
      assert.equal((await items.byLoop(loop.id)).length, 1);
    } finally {
      await pg.close();
      configurePgPooling({});
    }
  },
);
