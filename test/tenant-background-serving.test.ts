import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { createPostgresRunStore, type PostgresRuntime } from "../src/runs/postgres-run-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPostgresMapFactory, type PostgresArtifactMaps } from "../src/persistence/durable-map.ts";
import { createPostgresProcessRegistry } from "../src/processes/process-registry.ts";
import { createPostgresFileUploadStore } from "../src/files/file-upload-store.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createTenantSlackRuntimes } from "../src/surfaces/slack-tenants.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the serving claim tests";
const actor: Principal = { id: "internal:U1", type: "internal" };
const serving = randomUUID();
const parked = randomUUID();
let url: string;
let owner: pg.Pool;
let runtime: PostgresRuntime;
let deliveries: DeliveryStore;
let maps: PostgresArtifactMaps;

function turn(threadRef: string): OrchestratorInput {
  return { actor, conversation: { kind: "dm", threadRef, audience: [actor] }, origin: { kind: "direct" }, text: "hi" };
}

before(async () => {
  if (skip) return;
  url = testDatabaseUrl();
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
  const processes = createPostgresProcessRegistry(url);
  const job = { scopeId: "s", sandboxId: "box", kind: "background", command: "c", ttlMs: 1e9 } as const;
  for (const tenant of [serving, parked])
    await withTenant(tenant, async () => {
      await processes.register({ ...job, processId: tenant });
      await runtime.runs.enqueue({ sessionId: `thread:${tenant}`, request: turn(`thread:${tenant}`) });
      await deliveries.enqueue({ destination: { type: "slack", target: tenant }, text: "hi", idempotencyKey: tenant });
      await probes.put(tenant, { n: 1 });
      await maps.map("slack_installation").put(tenant, { teamId: tenant });
    });

  const claimed = (await runtime.runs.claim("worker", 60_000, 10)).map((run) => run.sessionId);
  assert.deepEqual(claimed, [`thread:${serving}`]);

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
  await owner.query("UPDATE process_sessions SET bot_actor = 'bot'");
  const botJobTenants = (await processes.claimLiveBotJobs()).map((row) => row.tenantId);
  assert.deepEqual(botJobTenants, [serving]);
  const tenantsOf = (rows: { tenantId: string }[]) => rows.map((row) => row.tenantId);
  assert.deepEqual(tenantsOf(await processes.claimExpired(Date.now() + 2e9)), [serving]);

  const uploads = createPostgresFileUploadStore(url);
  const vectors = createPostgresVectorStore(url);
  const signals = createPostgresRunSignalStore(url);
  await Promise.all([uploads.claimExpired(0), vectors.claimTenants(), signals.pendingRuns()]);
  const both = "FROM tenants WHERE id IN ($1, $2)";
  await owner.query(
    `INSERT INTO file_uploads(tenant_id, id, actor_id, state, size_bytes, expires_at, data) SELECT id, id, 'a', 'pending', 1, 0, '{}' ${both}`,
    [serving, parked],
  );
  await owner.query(
    `INSERT INTO memory_facts(tenant_id, scope_id, text, sensitivity, source_unknown, created_at, updated_at) SELECT id, 's', 'f', 'internal', false, 0, 0 ${both}`,
    [serving, parked],
  );
  await owner.query(`INSERT INTO run_signals(tenant_id, run_id, kind, created_at) SELECT id, id, 'steer', 0 ${both}`, [
    serving,
    parked,
  ]);
  assert.deepEqual(tenantsOf(await uploads.claimExpired(Date.now())), [serving]);
  assert.deepEqual(tenantsOf(await vectors.claimTenants()), [serving]);
  assert.deepEqual(tenantsOf(await signals.pendingRuns()), [serving]);

  const discovered: string[] = [];
  const sessions = createPostgresSessionStore(url);
  const discovery = createTenantSlackRuntimes({
    runtimeFor: (tenant) => {
      discovered.push(tenant);
      return { start: () => undefined, reconcile: async () => undefined, stop: async () => undefined };
    },
    tenants: () => sessions.tenantLookup.slackTenants(),
    onError: (error) => assert.ifError(error),
  });
  discovery.start();
  await discovery.stop();
  assert.deepEqual(discovered, [serving]);
});

test("the reaper leaves an expired lease of a tenant that is not serving alone", { skip }, async () => {
  await owner.query(`UPDATE runs SET status = 'running', lease_token = 'stale', lease_expires_at = 1`);
  const reaped: string[] = [];
  await runtime.runs.reapExpired({ onReap: (event) => void reaped.push(event.sessionId) });
  assert.ok(reaped.includes(`thread:${serving}`));
  assert.ok(!reaped.includes(`thread:${parked}`));
});
