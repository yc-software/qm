import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createBackgroundOwnershipRows,
  createBackgroundOwnershipStore,
  type BackgroundOwnership,
} from "../src/runs/background-ownership.ts";
import { seedKeyValueTable, withTypedTableDb } from "./support/typed-table.ts";

const databaseUrl = process.env.DATABASE_URL;
test(
  "Postgres serializes concurrent owner changes and backfills a member-protocol record",
  { skip: !databaseUrl },
  async () => {
    const rows = (url: string) => {
      const pair = [createBackgroundOwnershipRows(url), createBackgroundOwnershipRows(url)];
      return { stores: pair.map(createBackgroundOwnershipStore), close: async () => undefined };
    };
    await withTypedTableDb(
      rows,
      async ({ store: { stores } }) => {
        assert.deepEqual(await stores[0]!.get(), { ownerDeploymentId: "core:blue", setAt: null, setBy: null });
        const claims = await Promise.allSettled(
          stores.map((store, i) =>
            store.set({ ownerDeploymentId: `d${i}`, expectedOwnerDeploymentId: "core:blue", setBy: `d${i}` }),
          ),
        );
        assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
        const state = await stores[0]!.get();
        assert.ok(["d0", "d1"].includes(state.ownerDeploymentId!));
        assert.deepEqual(await stores[1]!.get(), state);
      },
      (admin) =>
        seedKeyValueTable(admin, "background_ownership", {
          ownership: {
            enabled: true,
            generation: 3,
            desiredDeploymentId: "core:blue",
            lastRequestId: null,
            lastRequest: null,
            members: [{ instanceId: "old", deploymentId: "core:blue", state: "admitted" }],
          },
        }),
    );
  },
);

test(
  "Postgres queue resumes polling without terminating a prior generation callback",
  { skip: !databaseUrl, timeout: 20_000 },
  async () => {
    const { createPgBossCronQueue } = await import("../src/cron/job-queue.ts");
    const schema = `handover_${randomUUID().replaceAll("-", "")}`;
    const queue = createPgBossCronQueue(databaseUrl!, schema);
    const oldEntered = Promise.withResolvers<void>();
    const oldFinish = Promise.withResolvers<void>();
    const newEntered = Promise.withResolvers<void>();
    let oldFinished = false;
    try {
      await queue.start({
        onFire: async () => {
          oldEntered.resolve();
          await oldFinish.promise;
          oldFinished = true;
        },
      });
      await queue.enqueueFire({ cronId: "old", scheduledAt: Date.now() });
      await oldEntered.promise;
      await queue.stopClaims!();
      assert.equal(oldFinished, false);
      await queue.start({
        onFire: async () => {
          newEntered.resolve();
        },
      });
      await queue.enqueueFire({ cronId: "new", scheduledAt: Date.now() });
      await newEntered.promise;
      assert.equal(oldFinished, false);
      oldFinish.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(oldFinished, true);
    } finally {
      oldFinish.resolve();
      await queue.stop();
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: databaseUrl! });
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);

test(
  "a delayed owner change committed after the client gave up is confirmed by the readback",
  { skip: !databaseUrl, timeout: 20_000 },
  async () => {
    const { setBackgroundOwner } = await import("../cli/src/background-work.ts");
    const rows = (url: string) => ({
      store: createBackgroundOwnershipStore(createBackgroundOwnershipRows(url)),
      close: async () => undefined,
    });
    await withTypedTableDb(rows, async ({ store: { store }, admin }) => {
      const blocker = await admin.connect();
      let first: Promise<BackgroundOwnership> | undefined;
      const status = (state: BackgroundOwnership) =>
        JSON.stringify({ ...state, protocol: 2, deploymentId: "b", instanceId: "b-1", active: false });
      try {
        await store.set({ ownerDeploymentId: "a", setBy: "a" });
        await blocker.query("BEGIN");
        await blocker.query("SELECT * FROM background_ownership FOR UPDATE");
        const change = { ownerDeploymentId: "b", expectedOwnerDeploymentId: "a" };
        let posts = 0;
        let reads = 0;
        const result = await setBackgroundOwner(
          async (method, body) => {
            if (method === "POST") {
              posts++;
              assert.equal(body, JSON.stringify(change));
              if (posts === 1) {
                first = store.set({ ...change, setBy: "b" });
                throw new Error("client timeout while server transaction is pending");
              }
              await blocker.query("COMMIT");
              await first;
              return { status: 200, body: status(await store.set({ ...change, setBy: "b" })) };
            }
            reads++;
            const current = await store.get();
            if (reads === 1) assert.equal(current.ownerDeploymentId, "a");
            return { status: 200, body: status(current) };
          },
          "b",
          change,
        );
        assert.equal(result.ownerDeploymentId, "b");
        assert.equal(posts, 2);
        assert.equal(reads, 1);
        assert.equal((await store.get()).ownerDeploymentId, "b");
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        await first?.catch(() => {});
      }
    });
  },
);
