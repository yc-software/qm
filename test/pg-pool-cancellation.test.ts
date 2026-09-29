import assert from "node:assert/strict";
import { test } from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";

test("abort during connection checkout releases the client without starting a query", async (t) => {
  const controller = new AbortController();
  let queries = 0;
  const releases: Array<Error | undefined> = [];
  const client = {
    async query() {
      queries++;
      return { rows: [], rowCount: 0 };
    },
    release(error?: Error) {
      releases.push(error);
    },
  };
  class Pool {
    on() {
      return this;
    }
    async end() {}
    connect() {
      return new Promise((resolve) => {
        queueMicrotask(() => {
          resolve(client);
          controller.abort();
        });
      });
    }
  }
  t.mock.module("pg", { defaultExport: { Pool } });
  const store = createPgPool("postgres://offline.invalid/cancellation_test");
  try {
    await assert.rejects(store.query("SELECT 1", [], { signal: controller.signal }), /Postgres query cancelled/);
    assert.equal(queries, 0);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.message, "Postgres query cancelled");
  } finally {
    await store.close();
  }
});
