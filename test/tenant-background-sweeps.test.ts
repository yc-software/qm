import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPostgresProcessRegistry } from "../src/processes/process-registry.ts";
import { createProcessReaper } from "../src/processes/process-reaper.ts";
import { createJobComputerSweep } from "../src/processes/job-computers.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createMemoryVectorIndexer } from "../src/memory/vector-indexer.ts";
import { createPostgresFileUploadStore } from "../src/files/file-upload-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPostgresMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { scopeId } from "../src/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { singleProcessDeps } from "./support/single-process.ts";
import { boundTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import type { ProcessSandbox } from "../src/sandbox/sandbox.ts";
import {
  TENANT_A as A,
  TENANT_B as B,
  twoTenantDatabase,
  twoTenantTestSkip,
  type TwoTenantDatabase,
} from "./support/two-tenants.ts";

let db: TwoTenantDatabase | undefined;
const skip = twoTenantTestSkip();

before(async () => {
  if (skip) return;
  db = await twoTenantDatabase((url) => {
    createPostgresProcessRegistry(url);
    createPostgresSessionStore(url);
    createPostgresVectorStore(url);
    createPostgresFileUploadStore(url);
    createPostgresDeliveryStore(url);
  });
});

after(() => db?.close());

async function grantTables(): Promise<void> {
  const role = new URL(db!.appUrl).username;
  await db!.owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await db!.owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await db!.owner.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
}

const processSandbox: ProcessSandbox = {
  provision: async () => assert.fail("no provisioning expected"),
  teardown: async () => {},
  signalProcess: async () => {},
} as unknown as ProcessSandbox;

test(
  "under the restricted login, the process reaper reaps each tenant's expired process under that tenant",
  { skip },
  async () => {
    const owner = createPostgresProcessRegistry(db!.ownerUrl);
    const register = (tenant: string, processId: string) =>
      withTenant(tenant, () =>
        owner.register({
          processId,
          scopeId: "personal:U1",
          sandboxId: "",
          kind: "background",
          command: "x",
          ttlMs: -1,
        }),
      );
    await register(A, "p-a");
    await register(B, "p-b");
    await grantTables();
    const app = createPostgresProcessRegistry(db!.appUrl);
    const killed: Array<[string, string | undefined]> = [];
    const reaper = createProcessReaper(app, {
      intervalMs: 60_000,
      leaderLease: createNoopLeaderLease(),
      kill: async (rec) => {
        killed.push([rec.processId, boundTenant()]);
      },
    });
    try {
      await assert.rejects(
        withTenant(A, () => reaper.sweep()),
        /cannot run while a tenant is bound/,
      );
      assert.deepEqual(await withoutTenant(() => reaper.sweep()), { reaped: 2 });
      assert.deepEqual(killed.sort(), [
        ["p-a", A],
        ["p-b", B],
      ]);
      assert.deepEqual(
        (await db!.owner.query("SELECT process_id, tenant_id, status FROM process_sessions ORDER BY process_id")).rows,
        [
          { process_id: "p-a", tenant_id: A, status: "reaped" },
          { process_id: "p-b", tenant_id: B, status: "reaped" },
        ],
      );
    } finally {
      app.close?.();
      owner.close?.();
    }
  },
);

test("job computers are swept each under the tenant that owns the computer record", { skip }, async () => {
  const pool = createPgPool(db!.ownerUrl);
  const records = createPostgresMap<SandboxResource>(pool, `t_jobs_${randomBytes(4).toString("hex")}`);
  const computer = (id: string): SandboxResource => ({
    id,
    backend: "local",
    ownerScopeId: "personal:U1",
    backingScopeId: `sandbox-${id}`,
    name: "background job",
    createdBy: "U1",
    createdAt: new Date(0).toISOString(),
    legacy: false,
    state: "retired",
    jobOnly: true,
  });
  await withTenant(A, () => records.put("c-a", computer("c-a")));
  await withTenant(B, () => records.put("c-b", computer("c-b")));
  const retired: Array<[string, string | undefined]> = [];
  const sweep = createJobComputerSweep({
    resources: {
      jobComputers: async () => (await records.acrossTenants()).map(({ tenantId, value }) => ({ ...value, tenantId })),
      retireJobComputer: async (id) => {
        retired.push([id, boundTenant()]);
        await records.delete(id);
      },
    },
    sandbox: processSandbox,
    processes: createPostgresProcessRegistry(db!.ownerUrl),
    finish: async () => {},
    onError: (error) => assert.fail(String(error)),
  });
  try {
    await withoutTenant(sweep);
    assert.deepEqual(retired.sort(), [
      ["c-a", A],
      ["c-b", B],
    ]);
    assert.deepEqual(await records.acrossTenants(), []);
  } finally {
    await pool.close();
  }
});

test(
  "under the restricted login, spend refresh rolls up each tenant's days under that tenant and retention purges across tenants in one pass",
  { skip },
  async () => {
    const owner = createPostgresSessionStore(db!.ownerUrl);
    await withTenant(A, () => owner.listParticipants());
    await db!.owner.query("INSERT INTO session_spend_dirty(tenant_id, day) VALUES ($1, 100), ($2, 100), ($2, 101)", [
      A,
      B,
    ]);
    await db!.owner.query(
      "INSERT INTO llm_prompt_envelopes(tenant_id, hash, body, created_at) VALUES ($1, 'old-a', '', 1), ($2, 'old-b', '', 1), ($2, 'new-b', '', 5000)",
      [A, B],
    );
    await grantTables();
    const app = createPostgresSessionStore(db!.appUrl);
    await assert.rejects(
      withTenant(A, () => app.refreshSpendRollup!()),
      /cannot run while a tenant is bound/,
    );
    await withoutTenant(() => app.refreshSpendRollup!());
    assert.deepEqual(
      (await db!.owner.query("SELECT tenant_id, day FROM session_spend_days ORDER BY tenant_id, day")).rows.map(
        (row) => [row.tenant_id, Number(row.day)],
      ),
      [
        [A, 100],
        [B, 100],
        [B, 101],
      ],
    );
    assert.equal((await db!.owner.query("SELECT count(*)::int AS n FROM session_spend_dirty")).rows[0].n, 0);
    assert.equal(await withoutTenant(() => app.purgeLlmCaptures!(1000)), 2);
    assert.deepEqual((await db!.owner.query("SELECT tenant_id, hash FROM llm_prompt_envelopes")).rows, [
      { tenant_id: B, hash: "new-b" },
    ]);
  },
);

test(
  "under the restricted login, the memory indexer embeds each tenant's facts and writes their vectors under that tenant",
  { skip },
  async () => {
    const owner = createPostgresVectorStore(db!.ownerUrl);
    await withoutTenant(() => owner.prune("m", 1));
    await db!.owner.query(
      `INSERT INTO memory_facts(tenant_id, scope_id, text, sensitivity, source_unknown, created_at, updated_at)
     VALUES ($1, 'personal:U1', 'fact a', 'normal', false, 1, 1), ($2, 'personal:U1', 'fact b', 'normal', false, 1, 1)`,
      [A, B],
    );
    await grantTables();
    const store = createPostgresVectorStore(db!.appUrl);
    const putUnder: Array<string | undefined> = [];
    const indexer = createMemoryVectorIndexer({
      resolve: async () => ({
        embedder: { id: "m", embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) },
        store: {
          missing: store.missing,
          prune: store.prune,
          put: (rows, signal) => {
            putUnder.push(boundTenant());
            return store.put(rows, signal);
          },
        },
      }),
      leaderLease: createNoopLeaderLease(),
      onError: (error) => assert.fail(String(error)),
    });
    try {
      await withTenant(A, () => indexer.tick());
      assert.deepEqual(putUnder.sort(), [A, B]);
      assert.deepEqual(
        (
          await db!.owner.query(
            "SELECT v.tenant_id, f.text FROM memory_fact_vectors v JOIN memory_facts f ON f.tenant_id = v.tenant_id AND f.id = v.fact_id ORDER BY f.text",
          )
        ).rows,
        [
          { tenant_id: A, text: "fact a" },
          { tenant_id: B, text: "fact b" },
        ],
      );
    } finally {
      await store.close();
      await owner.close();
    }
  },
);

test(
  "under the restricted login, expired uploads are claimed across tenants and each is finished under its own tenant",
  { skip },
  async () => {
    const owner = createPostgresFileUploadStore(db!.ownerUrl);
    const upload = (id: string) => ({
      id,
      actorId: "U1",
      scopeId: "personal:U1",
      name: "f",
      mimetype: "text/plain",
      sizeBytes: 1,
      partSize: 1,
      checksums: [],
      uploadId: `u-${id}`,
      state: "pending" as const,
      expiresAt: 1,
      createdAt: 1,
      lastActivityAt: 1,
    });
    await withTenant(A, () => owner.insert(upload("a".repeat(32))));
    await withTenant(B, () => owner.insert(upload("b".repeat(32))));
    await grantTables();
    const app = createPostgresFileUploadStore(db!.appUrl);
    const expired = await withoutTenant(() => app.expired(10));
    assert.deepEqual(expired.map((row) => [row.id[0], row.tenantId]).sort(), [
      ["a", A],
      ["b", B],
    ]);
    for (const row of expired)
      await withTenant(row.tenantId!, async () => {
        assert.equal(await app.transition(row.id, ["pending"], "aborted"), true);
        assert.equal((await app.get(row.id))?.state, "aborted");
      });
    await withTenant(A, async () => assert.equal(await app.get("b".repeat(32)), null));
  },
);

test(
  "deployment keep-warm and idle reaping read every tenant's apps and act on each under its tenant",
  { skip },
  async () => {
    const maps = createPostgresMapFactory(db!.ownerUrl);
    const deployStore = createDeployStore({ deployments: maps.map<Deployment>("deployments"), pg: maps.pool });
    await withTenant(A, () => deployStore.getByName("none"));
    const destroyed: Array<string | undefined> = [];
    const provider: DeployProvider = {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      destroy: async () => {
        destroyed.push(boundTenant());
      },
    };
    const deploy = createDeployService({
      ...singleProcessDeps(),
      deployStore,
      provider,
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
      acl: createAclStore(createPostgresGrantStore(db!.ownerUrl)),
      deployDir: mkdtempSync(join(tmpdir(), "tenant-reap-")),
    });
    const publish = (tenant: string) =>
      withTenant(tenant, () =>
        deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] }),
      );
    const a = await publish(A);
    const b = await publish(B);
    assert.deepEqual(
      (await withoutTenant(() => deployStore.acrossTenants())).map((d) => [d.id, d.tenantId]).sort(),
      [
        [a.id, A],
        [b.id, B],
      ].sort(),
    );
    await assert.rejects(
      withTenant(A, () => deploy.reapIdleDeployments(60_000, Date.now() + 1_000_000)),
      /cannot run while a tenant is bound/,
    );
    assert.equal(await withoutTenant(() => deploy.maintainDeployments()), 0);
    assert.equal(await withoutTenant(() => deploy.reapIdleDeployments(60_000, Date.now() + 1_000_000)), 2);
    assert.deepEqual(destroyed.sort(), [A, B]);
    assert.equal((await withTenant(A, () => deployStore.get(a.id)))?.status, "stopped");
    assert.equal((await withTenant(B, () => deployStore.get(b.id)))?.status, "stopped");
  },
);

test(
  "under the restricted login, pending web deliveries are read across tenants and each is acked under its own tenant",
  { skip },
  async () => {
    await grantTables();
    const app = createPostgresDeliveryStore(db!.appUrl);
    const enqueue = (tenant: string, key: string) =>
      withTenant(tenant, () =>
        app.enqueue({ destination: { type: "web", target: `web:${key}` }, text: key, idempotencyKey: key }),
      );
    const a = await enqueue(A, "web-a");
    const b = await enqueue(B, "web-b");
    await assert.rejects(
      withTenant(A, () => app.pendingAcrossTenants("web")),
      /cannot run while a tenant is bound/,
    );
    const pending = await withoutTenant(() => app.pendingAcrossTenants("web"));
    assert.deepEqual(
      pending.map((d) => [d.id, d.tenantId]).sort(),
      [
        [a.id, A],
        [b.id, B],
      ].sort(),
    );
    assert.deepEqual(
      (await withTenant(A, () => app.pending("web"))).map((d) => d.id),
      [a.id],
    );
    for (const d of pending) await withTenant(d.tenantId!, () => app.ack(d.id, Date.now()));
    assert.deepEqual(await withoutTenant(() => app.pendingAcrossTenants("web")), []);
  },
);
