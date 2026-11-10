import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { createPostgresRunStore, type PostgresRuntime } from "../src/runs/postgres-run-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPostgresMapFactory, type PostgresArtifactMaps } from "../src/persistence/durable-map.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the serving claim tests";
const actor: Principal = { id: "internal:U1", type: "internal" };
const serving = randomUUID();
const parked = randomUUID();
let owner: pg.Pool;
let runtime: PostgresRuntime;
let deliveries: DeliveryStore;
let maps: PostgresArtifactMaps;

function turn(threadRef: string): OrchestratorInput {
  return { actor, conversation: { kind: "dm", threadRef, audience: [actor] }, origin: { kind: "direct" }, text: "hi" };
}

before(async () => {
  if (skip) return;
  const url = testDatabaseUrl();
  runtime = createPostgresRunStore(url);
  deliveries = createPostgresDeliveryStore(url);
  maps = createPostgresMapFactory(url);
  await runtime.runs.list({ limit: 1 });
  await deliveries.pending("slack");
  owner = new pg.Pool({ connectionString: ownerUrl(url).toString() });
  await owner.query(`INSERT INTO tenants(id, settings) VALUES ($1, '{}'), ($2, '{"serving": false}')`, [
    serving,
    parked,
  ]);
});

after(async () => {
  await runtime?.close();
  await maps?.pool.close();
  await owner?.end();
});

test("background claims skip work owned by a tenant that is not serving", { skip }, async () => {
  const probes = maps.map<{ n: number }>("serving_probe");
  for (const tenant of [serving, parked])
    await withTenant(tenant, async () => {
      await runtime.runs.enqueue({ sessionId: `thread:${tenant}`, request: turn(`thread:${tenant}`) });
      await deliveries.enqueue({ destination: { type: "slack", target: tenant }, text: "hi", idempotencyKey: tenant });
      await probes.put(tenant, { n: 1 });
    });

  const claimed = await runtime.runs.claim("worker", 60_000, 10);
  assert.deepEqual(
    claimed.map((run) => run.sessionId),
    [`thread:${serving}`],
  );

  const tenantsWithDeliveries = (await deliveries.undeliveredTenants("slack")).map((row) => row.tenantId);
  assert.ok(tenantsWithDeliveries.includes(serving));
  assert.ok(!tenantsWithDeliveries.includes(parked));
  const due = await deliveries.claimDue("slack", 60_000);
  assert.deepEqual(
    due.map((delivery) => delivery.tenantId),
    [serving],
  );

  const mapTenants = (await probes.claimTenants()).map((row) => row.tenantId);
  assert.ok(mapTenants.includes(serving));
  assert.ok(!mapTenants.includes(parked));
});

test("the reaper leaves an expired lease of a tenant that is not serving alone", { skip }, async () => {
  await owner.query(`UPDATE runs SET status = 'running', lease_token = 'stale', lease_expires_at = 1`);
  const reaped: string[] = [];
  await runtime.runs.reapExpired({ onReap: (event) => void reaped.push(event.sessionId) });
  assert.ok(reaped.includes(`thread:${serving}`));
  assert.ok(!reaped.includes(`thread:${parked}`));
});
