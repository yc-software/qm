import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { claimFlyPeer, type FlyPeerClaim } from "../src/deploy/fly-peer-claims.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMap, processLevelMap } from "../src/persistence/durable-map.ts";
import type { PgPool } from "../src/persistence/pg-pool.ts";
import { createConfigEpochResolver, type StoredConfigEpoch } from "../src/sandbox/superserve-sandbox.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const processStore = <T>(pg: PgPool, table: string) =>
  createPostgresMap<T>(pg, table, [], [], [processLevelMap(table)]);

withoutTenant(() =>
  describe("installation-wide stores are shared by every tenant", () => {
    let db: TwoTenants;

    before(async () => {
      db = await twoTenants();
      for (const table of ["superserve_config_epochs", "fly_peer_claims"])
        await withoutTenant(() => processStore(db.owner, table).entries());
    });

    after(() => db?.close());

    it("resolves the same sandbox configuration generation under every tenant", async () => {
      const [first, second] = db.tenants;
      const resolve = () =>
        createConfigEpochResolver(
          processStore<StoredConfigEpoch>(db.app, "superserve_config_epochs"),
          "release-1",
          createPostgresAdvisoryLock(db.app),
        )();
      const epoch = await withTenant(first, resolve);
      assert.equal(await withTenant(second, resolve), epoch);
      const next = await withTenant(second, () =>
        createConfigEpochResolver(
          processStore<StoredConfigEpoch>(db.app, "superserve_config_epochs"),
          "release-2",
          createPostgresAdvisoryLock(db.app),
        )(),
      );
      assert.equal(next, epoch + 1);
    });

    it("never hands one WireGuard peer to core processes running under different tenants", async () => {
      const [first, second] = db.tenants;
      const claim = (tenant: string, taskArn: string) =>
        withTenant(tenant, () =>
          claimFlyPeer({
            claims: processStore<FlyPeerClaim>(db.app, "fly_peer_claims"),
            peerIds: ["peer-a", "peer-b"],
            taskArn,
            taskStopped: async () => false,
          }),
        );
      const peers = [await claim(first, "task-1"), await claim(second, "task-2")];
      assert.notEqual(peers[0], peers[1]);
      await assert.rejects(claim(second, "task-3"), /confirmed stopped/);
    });
  }),
);
