import { createPgPool } from "../src/persistence/pg-pool.ts";
import { backfillDeliverySourceCronIdBatch } from "../src/delivery/postgres-delivery-store.ts";
import { backfillSessionOriginBatch } from "../src/sessions/postgres-session-store.ts";
import { sleep } from "../src/util/async.ts";
import { databaseUrl } from "./lib/backfill-runner.ts";

const BATCH = 5000;
const PAUSE_MS = 250;

const db = createPgPool(databaseUrl());
for (const [table, backfillBatch] of [
  ["sessions", backfillSessionOriginBatch],
  ["deliveries", backfillDeliverySourceCronIdBatch],
] as const) {
  let total = 0;
  for (;;) {
    const updated = await backfillBatch(db.q, BATCH);
    if (updated === 0) break;
    total += updated;
    console.log(`backfilled ${total} ${table}`);
    await sleep(PAUSE_MS);
  }
  console.log(`done: ${total} ${table} backfilled, none left to derive`);
}
await db.close();
