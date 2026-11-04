import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createMemorySnapshotStore, createS3SnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { localContainerName, localVolumeName } from "../src/sandbox/local-sandbox.ts";
import { porterSlug } from "../src/sandbox/porter-client.ts";
import { createModalSandbox, type StoredModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import { boundTenant, registerTenants, withTenant } from "../src/tenants/context.ts";
import { installFakeModal } from "./support/fake-modal.ts";

const install = randomUUID();
const other = randomUUID();
const third = randomUUID();
const scope = "personal:alice@corp.com";
registerTenants(install, undefined);

function tenantPartitionedMap<T>(): DurableMap<T> {
  const rows = new Map<string, Map<string, T>>();
  const own = (): Map<string, T> => {
    const key = boundTenant() ?? "";
    const existing = rows.get(key) ?? new Map<string, T>();
    rows.set(key, existing);
    return existing;
  };
  const store: Partial<DurableMap<T>> = {
    async get(id) {
      return own().get(id) ?? null;
    },
    async put(id, value) {
      own().set(id, value);
    },
    async merge(id, patch) {
      const existing = own().get(id);
      if (existing === undefined) return null;
      const next = { ...existing, ...patch };
      own().set(id, next);
      return next;
    },
    async delete(id) {
      own().delete(id);
    },
    async acrossTenants() {
      return [...rows].flatMap(([tenantId, values]) => [...values].map(([id, value]) => ({ tenantId, id, value })));
    },
  };
  return store as DurableMap<T>;
}

const fake = installFakeModal();
after(() => fake.cleanup());

test("tenants sharing the deployment's Modal backend get separate computers for the same scope", async () => {
  const sandbox = createModalSandbox({
    client: fake.client,
    namePrefix: "qm",
    store: tenantPartitionedMap<StoredModalSandbox>(),
    snapshots: createMemorySnapshotStore(),
    advisoryLock: createNoopAdvisoryLock(),
    blobTransfer: createMemoryBlobTransferStore(),
  });
  const mine = await withTenant(install, async () => {
    const handle = await sandbox.provision(scope);
    await sandbox.writeFile(handle, "secret.txt", "install-only");
    return handle;
  });
  const theirs = await withTenant(other, async () => {
    const handle = await sandbox.provision(scope);
    return { handle, secret: await sandbox.readFile(handle, "secret.txt") };
  });
  assert.equal(mine.id, "qm-personal-alice-corp-com-3d9100");
  assert.notEqual(theirs.handle.id, mine.id);
  assert.equal(theirs.handle.coldStart, true);
  assert.equal(theirs.secret, null);
  assert.notEqual(fake.current(theirs.handle.id)?.sandboxId, fake.current(mine.id)?.sandboxId);
});

test("non-install tenants get distinct names within every backend's length limit, and the install keeps its names", () => {
  const long = `channel:${"x".repeat(80)}`;
  const names = [install, other, third].map((tenant) => withTenant(tenant, () => sandboxScopeName("qm-scratch", long)));
  assert.equal(new Set(names).size, 3);
  assert.equal(
    withTenant(install, () => sandboxScopeName("qm", scope)),
    "qm-personal-alice-corp-com-3d9100",
  );
  assert.equal(sandboxScopeName("qm", scope), "qm-personal-alice-corp-com-3d9100");
  for (const name of names) assert.ok(name.length <= 63, name);
});

test("container, volume, Porter and home-snapshot keys are tenant-qualified for non-install tenants only", async () => {
  const keys: string[] = [];
  const snapshots = createS3SnapshotStore({
    bucket: "shared",
    prefix: "modal-home",
    s3: {
      async send(command) {
        keys.push((command as { input: { Key: string } }).input.Key);
        return {};
      },
    },
  });
  const derive = async (tenant: string) =>
    withTenant(tenant, async () => {
      await snapshots.put(scope, Buffer.from("home"));
      return [localContainerName(scope), localVolumeName(scope), porterSlug("qm", scope), keys.at(-1)];
    });
  const mine = await derive(install);
  const theirs = await derive(other);
  assert.deepEqual(mine, [
    "qm-sbx-personal-alice-corp-com-3d9100",
    "qm-home-personal-alice-corp-com-3d9100",
    "qm-personal-alice-corp-com-3d9100",
    "modal-home/personal%3Aalice%40corp.com.tar",
  ]);
  theirs.forEach((name, i) => assert.notEqual(name, mine[i]));
});
