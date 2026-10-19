import { createPgPool } from "../src/persistence/pg-pool.ts";
import { backfillDeliverySourceCronIdBatch } from "../src/delivery/postgres-delivery-store.ts";
import { sleep } from "../src/util/async.ts";
import { databaseUrl } from "./lib/backfill-runner.ts";

const BATCH = 5000;
const PAUSE_MS = 250;

const db = createPgPool(databaseUrl());
let total = 0;
for (;;) {
  const updated = await backfillDeliverySourceCronIdBatch(db.q, BATCH);
  if (updated === 0) break;
  total += updated;
  console.log(`backfilled ${total} deliveries`);
  await sleep(PAUSE_MS);
}
console.log(`done: ${total} deliveries backfilled, none left to derive`);
await db.close();
