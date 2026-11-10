import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, it } from "node:test";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createDeliveryRelay } from "../src/delivery/relay.ts";
import { wireRunResultDeliveries } from "../src/delivery/run-result-delivery.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresProcessRegistry } from "../src/processes/process-registry.ts";
import { createProcessReaper } from "../src/processes/process-reaper.ts";
import { createJobComputerSweep } from "../src/processes/job-computers.ts";
import { createSandboxResources, type SandboxResource, type SandboxDefault } from "../src/sandbox/sandbox-resources.ts";
import type { ProcessSandbox, Sandbox } from "../src/sandbox/sandbox.ts";
import { createPostgresFileUploadStore, type FileUpload } from "../src/files/file-upload-store.ts";
import { createDirectFileUploads } from "../src/files/direct-file-upload.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createPostgresMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createDeployStore, type Deployment, type DeploymentDraft } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { DEPLOYMENT_TABLES } from "../src/deploy/page-views.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { scopeId } from "../src/types.ts";
import { boundTenant, currentTenant, withTenant } from "../src/tenants/context.ts";
import { onTenantLoad } from "../src/tenants/cache.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
import { createModalSandbox, type StoredModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import { createMemorySnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { installFakeModal } from "./support/fake-modal.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { assertRowsByTenant, describeTwoTenants } from "./support/two-tenants.ts";

type Pair = [string, string];
const sorted = (rows: Pair[]): Pair[] => [...rows].sort(([l], [r]) => l.localeCompare(r));

describeTwoTenants("background sweeps claim across tenants and work each row under its own tenant", (db) => {
  let a: string;
  let b: string;

  before(async () => {
    [a, b] = db.tenants;
  });

  it("the webhook relay claims each tenant's conversation head and sends and acks it under that tenant", async () => {
    const deliveries = createPostgresDeliveryStore(db.appDatabaseUrl);
    const enqueue = (tenant: string) =>
      withTenant(tenant, () =>
        deliveries.enqueue({
          destination: { type: "webhook", target: "shared-conversation" },
          text: tenant,
          idempotencyKey: `hook-${tenant}`,
        }),
      );
    const sentA = await enqueue(a);
    const sentB = await enqueue(b);
    const sent: Pair[] = [];
    let settle!: () => void;
    const bothSent = new Promise<void>((resolve) => (settle = resolve));
    const relay = createDeliveryRelay(deliveries, {
      type: "webhook",
      claimMs: 60_000,
      send: async (d) => {
        sent.push([d.id, currentTenant()]);
        if (sent.length === 2) settle();
      },
    });
    assert.equal(boundTenant(), undefined);
    relay.start();
    await bothSent;
    await relay.stop();
    assert.deepEqual(
      sorted(sent),
      sorted([
        [sentA.id, a],
        [sentB.id, b],
      ]),
    );
    await assertRowsByTenant(
      db.owner,
      "SELECT id::text, tenant_id::text, delivered_at IS NOT NULL FROM deliveries WHERE id = ANY($1)",
      [
        [sentA.id, a, true],
        [sentB.id, b, true],
      ],
      [[sentA.id, sentB.id]],
    );
  });

  it("overaged deliveries are expired across tenants and never handed out", async () => {
    const deliveries = createPostgresDeliveryStore(db.appDatabaseUrl, { maxAgeMs: 1 });
    const stale = [];
    for (const tenant of [a, b])
      stale.push(
        await withTenant(tenant, () =>
          deliveries.enqueue({
            destination: { type: "group", target: "stale" },
            text: "late",
            idempotencyKey: `stale-${tenant}`,
          }),
        ),
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await deliveries.claimDue("group", 60_000), []);
    await assertRowsByTenant(
      db.owner,
      "SELECT tenant_id::text FROM deliveries WHERE id = ANY($1) AND expired_at IS NOT NULL",
      [[a], [b]],
      [stale.map((d) => d.id)],
    );
  });

  it("the run-result sweep recovers each tenant's terminal run under that tenant", async () => {
    const { runs, close } = createPostgresRunStore(db.appDatabaseUrl);
    const deliveries = createPostgresDeliveryStore(db.appDatabaseUrl);
    const actor = { id: "internal:U1", type: "internal" as const };
    const request: OrchestratorInput = {
      surface: "slack",
      deliveryTarget: "C9:171.001",
      actor,
      conversation: { kind: "dm", threadRef: "t", audience: [actor] },
      origin: { kind: "direct" },
      text: "hi",
    };
    try {
      const finished: Pair[] = [];
      for (const tenant of [a, b])
        await withTenant(tenant, async () => {
          const run = (await runs.enqueue({ sessionId: `s-${tenant}`, request })).run;
          const claimed = await runs.claimById(run.id, "w", 5_000);
          await runs.complete(run.id, claimed?.leaseToken ?? "", { status: "ok", reply: `reply ${tenant}` });
          finished.push([run.id, tenant]);
        });
      const recovery = wireRunResultDeliveries(runs, deliveries);
      assert.equal(await recovery.sweep(Date.now() + 120_000), 2);
      for (const [runId, tenant] of finished)
        await withTenant(tenant, async () =>
          assert.deepEqual(
            (await deliveries.pending("slack")).map((d) => [d.idempotencyKey, d.text]),
            [[`run:${runId}`, `reply ${tenant}`]],
          ),
        );
      assert.equal(await recovery.sweep(Date.now() + 120_000), 0);
    } finally {
      await close();
    }
  });

  it("the process reaper reaps each tenant's expired process under that tenant", async () => {
    const registry = createPostgresProcessRegistry(db.appDatabaseUrl);
    for (const tenant of [a, b])
      await withTenant(tenant, () =>
        registry.register({
          processId: `p-${tenant}`,
          scopeId: "personal:U1",
          sandboxId: "",
          kind: "background",
          command: "x",
          ttlMs: -1,
        }),
      );
    const killed: Pair[] = [];
    const reaper = createProcessReaper(registry, {
      intervalMs: 60_000,
      leaderLease: createNoopLeaderLease(),
      kill: async (rec) => void killed.push([rec.processId, currentTenant()]),
    });
    assert.deepEqual(await reaper.sweep(), { reaped: 2 });
    assert.deepEqual(
      sorted(killed),
      sorted([
        [`p-${a}`, a],
        [`p-${b}`, b],
      ]),
    );
    await assertRowsByTenant(
      db.owner,
      "SELECT process_id::text, tenant_id::text, status FROM process_sessions WHERE process_id = ANY($1)",
      [
        [`p-${a}`, a, "reaped"],
        [`p-${b}`, b, "reaped"],
      ],
      [[`p-${a}`, `p-${b}`]],
    );
  });

  it("job computers are swept each under the tenant that owns the computer record", async () => {
    for (const table of ["t_tenant_job_computers", "t_tenant_job_defaults"])
      await createPostgresMap(db.owner, table).claimIds();
    const records = createPostgresMap<SandboxResource>(db.app, "t_tenant_job_computers");
    const destroyed: Pair[] = [];
    const backend = {
      profile: { backend: "local", writablePersistence: "resident_disk", processSessions: false },
      async destroyScope(id: string) {
        destroyed.push([id, currentTenant()]);
      },
    } as unknown as Sandbox;
    const resources = createSandboxResources({
      records,
      loads: db.maps.map("sandbox_loads"),
      defaults: createPostgresMap<SandboxDefault>(db.app, "t_tenant_job_defaults"),
      backends: { local: backend },
      defaultBackend: "local",
      lock: createPostgresAdvisoryLock(db.app),
      canUseScope: async () => true,
    });
    for (const tenant of [a, b])
      await withTenant(tenant, () =>
        records.put(`c-${tenant}`, {
          id: `c-${tenant}`,
          backend: "local",
          ownerScopeId: scopeId("personal", "U1"),
          backingScopeId: `job-${tenant}`,
          name: "background job",
          createdBy: "U1",
          createdAt: new Date(0).toISOString(),
          legacy: false,
          state: "retired",
          jobOnly: true,
        }),
      );
    const sweep = createJobComputerSweep({
      resources,
      sandbox: {} as ProcessSandbox,
      processes: createPostgresProcessRegistry(db.appDatabaseUrl),
      finish: async () => {},
      onError: (error) => assert.fail(String(error)),
    });
    await sweep();
    assert.deepEqual(
      sorted(destroyed),
      sorted([
        [`job-${a}`, a],
        [`job-${b}`, b],
      ]),
    );
    assert.deepEqual(await records.claimIds(), []);
  });

  it("expired uploads are settled under their tenant and an orphaned S3 upload is checked against its owner", async () => {
    const store = createPostgresFileUploadStore(db.appDatabaseUrl);
    const upload = (id: string, state: FileUpload["state"], expiresAt: number): FileUpload => ({
      id,
      actorId: "U1",
      scopeId: scopeId("personal", "U1"),
      name: "f",
      mimetype: "text/plain",
      sizeBytes: 1,
      partSize: 1,
      checksums: [],
      uploadId: `u-${id}`,
      state,
      expiresAt,
      createdAt: 1,
      lastActivityAt: 1,
    });
    const expiredA = "a".repeat(32);
    const expiredB = "b".repeat(32);
    const heldB = "c".repeat(32);
    const orphan = "d".repeat(32);
    await withTenant(a, () => store.insert(upload(expiredA, "pending", 1)));
    await withTenant(b, () => store.insert(upload(expiredB, "pending", 1)));
    await withTenant(b, () => store.insert(upload(heldB, "completing", Date.now() + 3_600_000)));
    const aborted: Pair[] = [];
    const service = createDirectFileUploads({
      bucket: "bucket",
      store,
      files: createPostgresFileArtifactStore(db.appDatabaseUrl, createMemoryDurableByteStore()),
      client: {
        async send(command: { constructor: { name: string }; input: { Key?: string } }) {
          if (command.constructor.name === "ListMultipartUploadsCommand")
            return {
              Uploads: [heldB, orphan].map((id) => ({
                Key: `files/uploads/${id}`,
                UploadId: `u-${id}`,
                Initiated: new Date(0),
              })),
            };
          if (command.constructor.name === "AbortMultipartUploadCommand")
            aborted.push([command.input.Key!.slice("files/uploads/".length), boundTenant() ?? "unbound"]);
          return {};
        },
      } as never,
      presign: async () => "https://upload.test/",
    });
    await service.sweep();
    assert.deepEqual(
      sorted(aborted),
      sorted([
        [expiredA, a],
        [expiredB, b],
        [orphan, "unbound"],
      ]),
    );
    await assertRowsByTenant(
      db.owner,
      "SELECT id::text, tenant_id::text, state FROM file_uploads WHERE id = ANY($1)",
      [
        [expiredA, a, "aborted"],
        [expiredB, b, "aborted"],
        [heldB, b, "completing"],
      ],
      [[expiredA, expiredB, heldB]],
    );
  });

  it("deployment keep-warm and idle reaping act on each tenant's apps under that tenant", async () => {
    const maps = createPostgresMapFactory(db.appDatabaseUrl);
    const deployStore = createDeployStore({
      deployments: maps.map<Deployment>("deployments", undefined, DEPLOYMENT_TABLES),
      drafts: maps.map<DeploymentDraft>("deployment_drafts"),
      pg: maps.pool,
    });
    const destroyed: string[] = [];
    const provider: DeployProvider = {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      destroy: async () => void destroyed.push(currentTenant()),
    };
    const deploy = createDeployService({
      ...singleProcessDeps(),
      deployStore,
      provider,
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
      acl: createAclStore(createPostgresGrantStore(db.appDatabaseUrl)),
      deployDir: mkdtempSync(join(tmpdir(), "tenant-reap-")),
    });
    const publish = (tenant: string) =>
      withTenant(tenant, () =>
        deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] }),
      );
    const deployedA = await publish(a);
    const deployedB = await publish(b);
    assert.equal(await deploy.maintainDeployments(), 0);
    assert.equal(await deploy.reapIdleDeployments(60_000, Date.now() + 1_000_000), 2);
    assert.deepEqual(destroyed.sort(), [a, b].sort());
    assert.equal((await withTenant(a, () => deployStore.get(deployedA.id)))?.status, "stopped");
    assert.equal((await withTenant(b, () => deployStore.get(deployedB.id)))?.status, "stopped");
  });

  it("modal deep-idle reaping checkpoints each tenant's idle computer under that tenant", async () => {
    const fake = installFakeModal();
    const stopSettingsLoad = onTenantLoad(() => loadTenantSettings(db.app));
    try {
      await createPostgresMap(db.owner, "t_tenant_modal").claimIds();
      const store = createPostgresMap<StoredModalSandbox>(db.app, "t_tenant_modal");
      const modal = createModalSandbox({
        snapshots: createMemorySnapshotStore(),
        store,
        ...singleProcessDeps(),
        client: fake.client,
        namePrefix: "qmt",
      });
      const scopes: Pair[] = [
        [scopeId("personal", "alice"), a],
        [scopeId("personal", "bob"), b],
      ];
      for (const [scope, tenant] of scopes)
        await withTenant(tenant, async () => {
          const handle = await modal.provision(scope);
          await modal.writeFile(handle, "work.txt", tenant);
          await store.merge(scope, { lastActivityMs: 1 });
        });
      assert.equal((await modal.reapDeepIdle!(1)).reaped, 2);
      for (const [scope, tenant] of scopes)
        await withTenant(tenant, async () => {
          assert.ok((await store.get(scope))?.nativeSnapshotId);
          const restored = await modal.provision(scope);
          assert.equal(await modal.readFile(restored, "work.txt"), tenant);
        });
    } finally {
      stopSettingsLoad();
      fake.cleanup();
    }
  });
});
