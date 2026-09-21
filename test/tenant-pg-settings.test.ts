import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { PoolConfig } from "pg";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";
import { configurePgCaTrust, configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";

class FakePool extends EventEmitter {
  options: PoolConfig;
  ended = false;
  constructor(options: PoolConfig) {
    super();
    this.options = options;
  }
  async end() {
    this.ended = true;
  }
}

mock.module("pg", { defaultExport: { Pool: FakePool } });

test("lazy Postgres pools capture each tenant's routing, trust and capacity before another tenant configures them", async () => {
  const records = ["a", "b"].map((id, index) => {
    const context = createTenantContext({ id, env: {}, pooled: true });
    const direct = `postgres://user:password@direct.example.com/${id}`;
    const pooled = `postgres://user:password@pooled.example.com/${id}?sslmode=require`;
    return runWithTenant(context, () => {
      configurePgPooling({
        databaseUrl: direct,
        poolUrl: pooled,
        caCert: `pool-${id}`,
        queryMax: index + 2,
        sessionMax: index + 4,
      });
      configurePgCaTrust({ cert: `direct-${id}` });
      const store = createPgPool(direct);
      const sibling = createPgPool(direct);
      configurePgCaTrust({ cert: "changed-after-construction" });
      configurePgPooling({ queryMax: 99 });
      return { id, index, direct, store, sibling };
    });
  });
  const pools = await Promise.all(
    records.map(async ({ id, index, direct, store, sibling }) => {
      const query = await store.pool();
      assert.equal(await sibling.pool(), query);
      assert.equal(query.options.connectionString, `postgres://user:password@pooled.example.com/${id}`);
      assert.equal(query.options.max, index + 2);
      assert.deepEqual(query.options.ssl, { ca: `pool-${id}` });
      const session = await store.sessionPool();
      assert.equal(session.options.connectionString, direct);
      assert.equal(session.options.max, index + 4);
      assert.deepEqual(session.options.ssl, { ca: `direct-${id}` });
      await store.close();
      assert.equal((query as unknown as FakePool).ended, false);
      await sibling.close();
      assert.equal((query as unknown as FakePool).ended, true);
      return query;
    }),
  );
  assert.notEqual(pools[0], pools[1]);
});
