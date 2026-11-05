import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createPostgresProcessRegistry } from "../src/processes/process-registry.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { ProcessSandbox } from "../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createApprovalStore } from "../src/slack/approval-store.ts";
import { createSkillPackStore, type SkillPack } from "../src/skills/skill-pack-store.ts";
import { createSkillSyncEngine } from "../src/skills/skill-sync-engine.ts";
import { createSwarmStore, type SwarmStorage } from "../src/swarms/swarm-store.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { currentTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type PendingApprovalRecord, type TurnResult } from "../src/types.ts";
import type { Monitor } from "../src/triggers/types.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

describe("monitor, approval, skill and swarm sweeps bind each row's tenant", () => {
  let db: TwoTenants;
  let maps: ReturnType<typeof createPostgresMapFactory>;

  before(async () => {
    db = await twoTenants();
    maps = createPostgresMapFactory(db.appDatabaseUrl);
  });

  after(async () => {
    await maps?.pool.close();
    await db?.close();
  });

  const pairs = (): Array<[string, string]> => [
    [db.tenants[0], "a"],
    [db.tenants[1], "b"],
  ];

  it("lists enabled monitors and deletes defunct ones across tenants", async () => {
    const backing = maps.map<Monitor>("monitors", ["ownerScopeId"]);
    const monitor = (id: string, enabled: boolean): Monitor => ({
      id,
      ownerScopeId: scopeId("personal", "U1"),
      owner: "U1",
      createdBy: "U1",
      enabled,
      createdAt: enabled ? Date.now() : 1,
      processId: `p-${id}`,
      command: "tail",
      threadRef: `t-${id}`,
      cursor: 0,
      expiresAt: enabled ? Date.now() + 60_000 : 1,
    });
    for (const [tenant, suffix] of pairs())
      await withTenant(tenant, async () => {
        await backing.put(`live-${suffix}`, monitor(`live-${suffix}`, true));
        await backing.put(`dead-${suffix}`, monitor(`dead-${suffix}`, false));
      });
    const monitors = createMonitorStore(backing);
    const [a, b] = db.tenants;
    assert.deepEqual((await monitors.claimEnabled()).map((m) => [m.id, m.tenantId]).sort(), [
      ["live-a", a],
      ["live-b", b],
    ]);
    assert.equal(await monitors.deleteDefunct(Date.now()), 2);
    const rows = await db.owner.q("SELECT id, tenant_id::text AS tenant_id FROM monitors ORDER BY id");
    assert.deepEqual(
      rows.map((row) => [row.id, row.tenant_id]),
      [
        ["live-a", a],
        ["live-b", b],
      ],
    );
  });

  it("polls each tenant's monitors and tears down each sandbox handle under that tenant", async () => {
    const backing = maps.map<Monitor>("monitors", ["ownerScopeId"]);
    await db.owner.q("DELETE FROM monitors");
    const processes = createPostgresProcessRegistry(db.appDatabaseUrl);
    const ops: Array<[string, string]> = [];
    const sandbox = {
      profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
      async provision() {
        ops.push(["provision", currentTenant()]);
        return { id: `vm-${currentTenant()}`, rootDir: "/workspace", homeDir: "/root" };
      },
      async readProcess() {
        ops.push(["read", currentTenant()]);
        return { chunks: "built\n", cursor: 6, status: { state: "running" } };
      },
      async startProcess() {
        return { processId: "p-1" };
      },
      async writeStdin() {},
      async signalProcess() {},
      async listProcesses() {
        return [];
      },
      async teardown(handle: { id: string }) {
        ops.push(["teardown", currentTenant()]);
        assert.equal(handle.id, `vm-${currentTenant()}`);
      },
    } as unknown as ProcessSandbox;
    const monitors = createMonitorStore(backing);
    const turns: string[] = [];
    const poller = createMonitorPoller({
      ...singleProcessDeps(),
      monitors,
      processes,
      sandbox,
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(maps.map("idempotency")),
      identity: createIdentityService(maps.map("deactivated_principals"), {
        externalMembers: maps.map("external_members"),
      }),
      run: async (): Promise<TurnResult> => {
        turns.push(currentTenant());
        return { status: "ok", reply: "seen" };
      },
    });
    for (const [tenant] of pairs())
      await withTenant(tenant, async () => {
        await processes.register({
          processId: "p-1",
          scopeId: "personal:U1",
          sandboxId: "sandbox-1",
          kind: "background",
          command: "bg: npm run build",
          ttlMs: 600_000,
        });
        await monitors.create({
          owner: "U1",
          createdBy: "U1",
          ownerScopeId: scopeId("personal", "U1"),
          processId: "p-1",
          command: "bg: npm run build",
          destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
          threadRef: "thread-1",
          expiresAt: Date.now() + 600_000,
        });
      });
    await poller.tick();
    const tenants = [...db.tenants].sort();
    assert.deepEqual(turns.sort(), tenants);
    for (const op of ["provision", "read", "teardown"])
      assert.deepEqual(
        ops
          .filter(([name]) => name === op)
          .map(([, tenant]) => tenant)
          .sort(),
        tenants,
      );
    await processes.close?.();
  });

  it("redelivers each tenant's pending approval under that tenant", async () => {
    const backing = maps.map<PendingApprovalRecord>("approvals", ["sessionId"]);
    for (const [tenant, suffix] of pairs())
      await withTenant(tenant, () =>
        backing.put(`ap-${suffix}`, {
          sessionId: `dm:${suffix}`,
          command: "publish",
          createdAt: 1,
          request: {
            surface: "slack",
            actor: { externalId: "U1" },
            conversation: { kind: "dm", threadRef: `dm:${suffix}` },
            text: "publish report",
          },
          kind: "input",
          grantModes: { session: false, always: false },
        } as PendingApprovalRecord),
      );
    const enqueued: Array<[string | undefined, string]> = [];
    const approvals = createApprovalStore(backing, {
      enqueue: async (delivery) => {
        enqueued.push([delivery.destination.commandApprovalId, currentTenant()]);
        return { id: "d1" } as never;
      },
    });
    await approvals.deliverPending();
    const [a, b] = db.tenants;
    assert.deepEqual(enqueued.sort(), [
      ["ap-a", a],
      ["ap-b", b],
    ]);
  });

  it("syncs each tenant's skill packs under that tenant", async () => {
    const packs = createSkillPackStore({ backing: maps.map<SkillPack>("skill_packs") });
    const ids: Record<string, string> = {};
    for (const [tenant] of pairs())
      await withTenant(tenant, async () => {
        const pack = await packs.create({
          kind: "git",
          url: "https://example.com/skills.git",
          ref: "main",
          syncMode: "tracked",
          trustTier: "trusted",
          targetScopeId: scopeId("personal", "U1"),
          subset: "all",
          createdBy: "U1",
        } as never);
        ids[pack.id] = tenant;
      });
    const reconciled: Array<[string, string]> = [];
    const engine = createSkillSyncEngine({
      packs,
      fetcher: { resolveRef: async () => "c1" } as never,
      reconcile: async (packId) => {
        reconciled.push([packId, currentTenant()]);
      },
      leaderLease: createNoopLeaderLease(),
    });
    await engine.tick();
    assert.deepEqual(reconciled.sort(), Object.entries(ids).sort());
  });

  it("selects each tenant's pending swarms with their tenant", async () => {
    const backing = maps.map<SwarmStorage>("swarms", ["pending"]);
    const swarm = (id: string, pending: boolean) =>
      ({
        id,
        scopeId: "personal:U1",
        ownerId: "U1",
        participants: [],
        createdAt: 1,
        members: [],
        messages: [],
        pending,
      }) as unknown as SwarmStorage;
    for (const [tenant, suffix] of pairs())
      await withTenant(tenant, async () => {
        await backing.put(`sw-${suffix}`, swarm(`sw-${suffix}`, true));
        await backing.put(`idle-${suffix}`, swarm(`idle-${suffix}`, false));
      });
    const store = createSwarmStore(backing);
    const [a, b] = db.tenants;
    assert.deepEqual(
      (await store.pending()).map((s) => [s.id, s.tenantId]),
      [
        ["sw-a", a],
        ["sw-b", b],
      ],
    );
    assert.deepEqual(
      (await store.pending("sw-a")).map((s) => s.id),
      ["sw-b"],
    );
  });
});
