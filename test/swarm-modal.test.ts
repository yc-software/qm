import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import type { ModalClient, ModalSession } from "../src/sandbox/modal-client.ts";
import { installFakeModal } from "./support/fake-modal.ts";
import { instrumentedSnapshotStore } from "./support/snapshot-stores.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("real Modal adapter creates blank worker computers without snapshot or restore calls", async () => {
  const fake = installFakeModal({ native: true });
  const snapshotStore = instrumentedSnapshotStore();
  let snapshotCalls = 0;
  let restoreCalls = 0;
  const guard = (session: ModalSession): ModalSession => ({
    ...session,
    async snapshotHome() {
      snapshotCalls++;
      throw new Error("must not snapshot for swarm creation");
    },
    async restoreHome() {
      restoreCalls++;
      throw new Error("must not restore for swarm creation");
    },
  });
  const client: ModalClient = {
    ...fake.client,
    create: async (options) => guard(await fake.client.create(options)),
    fromId: async (id) => guard(await fake.client.fromId(id)),
    fromName: async (name) => {
      const session = await fake.client.fromName(name);
      return session ? guard(session) : null;
    },
  };
  const backend = createModalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "swarm-modal-"))), {
    client,
    snapshots: snapshotStore.store,
    nativeSnapshotsEnabled: true,
    namePrefix: "swarm-test",
  });
  const fixture = await swarmFixture({ backend });
  try {
    const parent = await fixture.sandboxes.create("alice", fixture.root.scopeId, "modal", "Parent");
    await fixture.sandboxes.setDefault("alice", fixture.root.scopeId, parent.id);
    const layers = [{ scopeId: fixture.root.scopeId, mountPath: "/", mode: "rw" as const }];
    const parentHandle = await fixture.sandbox.provision(layers);
    await fixture.sandbox.writeFile(parentHandle, "private", "parent disk only");
    await fixture.service.spawn(fixture.caller, { requestId: "pool", count: 2, text: "Work" });
    await fixture.service.sweep();
    const peers = (await fixture.service.inspect(fixture.caller)).peers.slice(1);
    assert.ok(peers.every((peer) => peer.state === "ready"));
    const handles = await Promise.all(
      peers.map((peer) => fixture.sandbox.provision(layers, { sandboxId: peer.sandboxId })),
    );
    assert.equal(new Set(handles.map((handle) => handle.id)).size, 2);
    for (const handle of handles) {
      assert.equal(await fixture.sandbox.readFile(handle, "private"), null);
      assert.equal(handle.scopeId, fixture.root.scopeId);
      assert.equal(handle.backend, "modal");
    }
    await fixture.sandbox.writeFile(handles[0]!, "result", "first worker only");
    assert.equal(await fixture.sandbox.readFile(handles[1]!, "result"), null);
    assert.equal(snapshotCalls, 0);
    assert.equal(restoreCalls, 0);
    assert.equal(snapshotStore.puts(), 0);
    assert.equal(fake.totalCreated(), 3);
  } finally {
    fake.cleanup();
  }
});
