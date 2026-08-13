import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

test("checkout discards a stale client that emitted no idle error before application SQL", async () => {
  const ddl = new FakeClient();
  const stale = new FakeClient(true);
  const healthy = new FakeClient();
  const clients = [ddl, stale, healthy];
  class FakePool extends EventEmitter {
    async connect(): Promise<FakeClient> {
      const client = clients.shift();
      if (!client) throw new Error("no fake client available");
      return client;
    }
    async end(): Promise<void> {}
  }
  mock.module("pg", { defaultExport: { Pool: FakePool } });
  const { createPgPool } = await import("../src/persistence/pg-pool.ts");
  const pg = createPgPool("postgres://fake/test", []);
  try {
    assert.deepEqual(await pg.q("SELECT 42 AS answer"), [{ answer: 42 }]);
    assert.deepEqual(stale.queries, ["SELECT 1"]);
    assert.deepEqual(stale.releases, [true]);
    assert.deepEqual(healthy.queries, ["SELECT 1", "SELECT 42 AS answer"]);
  } finally {
    await pg.close();
  }
});

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly releases: Array<boolean | Error | undefined> = [];
  private readonly stale: boolean;

  constructor(stale = false) {
    super();
    this.stale = stale;
  }

  async query(text: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    this.queries.push(text);
    if (this.stale && text === "SELECT 1") throw new Error("silently stale connection");
    return {
      rows: text === "SELECT 42 AS answer" ? [{ answer: 42 }] : [],
      rowCount: text === "SELECT 42 AS answer" ? 1 : 0,
    };
  }

  release(error?: boolean | Error): void {
    this.releases.push(error);
  }
}
