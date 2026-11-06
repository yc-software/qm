import assert from "node:assert/strict";
import { it } from "node:test";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createMemoryVectorIndexer } from "../src/memory/vector-indexer.ts";
import { createSandboxResources, type SandboxResource, type SandboxDefault } from "../src/sandbox/sandbox-resources.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { sweepUnreadMailWakes } from "../src/sessions/subagent-mail.ts";
import { currentTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { testAdvisoryLock } from "./support/test-database.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

describeTwoTenants("mail wakes, memory indexing and job computers bind each row's tenant", (db) => {
  it("wakes each tenant's parent for unread mail under that tenant", async () => {
    const mailbox = createSessionMailbox(db.maps.map<SessionMessage>("session_mailbox", ["recipientId", "wake"]));
    for (const tenant of db.tenants)
      await withTenant(tenant, async () => {
        for (const id of ["m1", "m2"])
          await mailbox.send({
            id,
            recipientId: "parent",
            senderId: "child",
            actor: { id: "internal:U1", type: "internal" },
            text: "hi",
            audience: [],
            createdAt: Date.now(),
            wake: true,
          });
      });
    const looked: string[] = [];
    await sweepUnreadMailWakes({
      mailbox,
      sessions: {
        get: async (id: string) => {
          looked.push(`${currentTenant()} ${id}`);
          return null;
        },
      },
    } as unknown as Parameters<typeof sweepUnreadMailWakes>[0]);
    assert.deepEqual(looked.sort(), db.tenants.map((tenant) => `${tenant} parent`).sort());
  });

  it("resolves each tenant's embedding model under that tenant", async () => {
    for (const tenant of db.tenants)
      await withTenant(tenant, () =>
        db.app.q(
          "INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at) VALUES ('personal:a', 'fact', 'normal', true, 1, 1)",
        ),
      );
    const vectors = createPostgresVectorStore(db.appDatabaseUrl);
    const resolved: string[] = [];
    const indexer = createMemoryVectorIndexer({
      claim: () => vectors.claimTenants(),
      resolve: async () => {
        resolved.push(currentTenant());
        return undefined;
      },
      leaderLease: createNoopLeaderLease(),
      onError: (error) => assert.fail(String(error)),
    });
    try {
      await indexer.tick();
    } finally {
      await vectors.close();
    }
    assert.deepEqual(resolved.sort(), [...db.tenants].sort());
  });

  it("sweeps each tenant's job computers after initializing that tenant", async () => {
    const records = db.maps.map<SandboxResource>("sandbox_resources");
    const upgraded: string[] = [];
    const resources = createSandboxResources({
      upgrade: async () => void upgraded.push(currentTenant()),
      records,
      defaults: db.maps.map<SandboxDefault>("sandbox_defaults"),
      backends: {},
      defaultBackend: "local",
      lock: testAdvisoryLock(),
      canUseScope: async () => true,
    });
    for (const tenant of db.tenants)
      await withTenant(tenant, () =>
        records.put("job", {
          id: "job",
          backend: "local",
          ownerScopeId: scopeId("personal", "U1"),
          backingScopeId: "job",
          name: "job",
          createdBy: "U1",
          createdAt: new Date().toISOString(),
          legacy: false,
          state: "ready",
          jobOnly: true,
        }),
      );
    const swept: string[] = [];
    await resources.eachJobComputer(async (computer) => void swept.push(`${currentTenant()} ${computer.id}`));
    assert.deepEqual(swept.sort(), db.tenants.map((tenant) => `${tenant} job`).sort());
    assert.deepEqual(upgraded.sort(), [...db.tenants].sort());
  });
});
