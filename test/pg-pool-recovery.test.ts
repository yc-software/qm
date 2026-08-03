import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mock, test } from "node:test";

class FakeClient {
  queryErrors = new Map<string, Error>();

  async query(text: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const error = this.queryErrors.get(text);
    if (error) {
      this.queryErrors.delete(text);
      throw error;
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

class FakePool extends EventEmitter {
  static instances: FakePool[] = [];

  config: Record<string, unknown>;
  ended = false;
  endCalls = 0;
  waitingCount = 0;
  nextQueryError: Error | null = null;
  client = new FakeClient();

  constructor(config: Record<string, unknown>) {
    super();
    this.config = config;
    FakePool.instances.push(this);
  }

  async connect(): Promise<FakeClient> {
    return this.client;
  }

  async query(): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (this.nextQueryError) {
      const error = this.nextQueryError;
      this.nextQueryError = null;
      throw error;
    }
    return { rows: [{ one: 1 }], rowCount: 1 };
  }

  async end(): Promise<void> {
    this.endCalls++;
    this.ended = true;
  }
}

mock.module("pg", { defaultExport: { Pool: FakePool } });

const { createPgPool } = await import("../src/persistence/pg-pool.ts");

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("an idle-client error retires the pool before the next checkout", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  const first = (await db.pool()) as unknown as FakePool;

  first.emit("error", new Error("Connection terminated unexpectedly"));
  await settle();

  const second = (await db.pool()) as unknown as FakePool;
  assert.notEqual(second, first);
  assert.equal(first.ended, true);
  assert.deepEqual((await db.query("SELECT 1 AS one")).rows, [{ one: 1 }]);
  await db.close();
});

test("normal pool checkouts do not inherit the health-check timeout", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  const pool = (await db.pool()) as unknown as FakePool;

  assert.equal(pool.config.connectionTimeoutMillis, undefined);
  await db.close();
});

test("a connection-level query failure retires the pool for the next request", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  const first = (await db.pool()) as unknown as FakePool;
  first.nextQueryError = Object.assign(new Error("server closed the connection unexpectedly"), { code: "57P01" });

  await assert.rejects(() => db.query("SELECT 1"), /closed the connection/);
  await settle();

  const second = (await db.pool()) as unknown as FakePool;
  assert.notEqual(second, first);
  assert.equal(first.ended, true);
  await db.close();
});

test("a retired pool drains queued checkouts before closing", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  const first = (await db.pool()) as unknown as FakePool;
  first.waitingCount = 1;

  first.emit("error", new Error("Connection terminated unexpectedly"));
  await settle();

  assert.notEqual((await db.pool()) as unknown as FakePool, first);
  assert.equal(first.ended, false);
  first.waitingCount = 0;
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(first.ended, true);
  await db.close();
});

test("shutdown and deferred retirement close a pool only once", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  const first = (await db.pool()) as unknown as FakePool;
  first.waitingCount = 1;

  first.emit("error", new Error("Connection terminated unexpectedly"));
  await settle();
  await db.close();
  first.waitingCount = 0;
  await new Promise((resolve) => setTimeout(resolve, 75));

  assert.equal(first.endCalls, 1);
});

test("a transaction failure retires the pool and preserves an ambiguous commit error", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  const first = (await db.pool()) as unknown as FakePool;
  first.client.queryErrors.set("COMMIT", Object.assign(new Error("commit outcome unknown"), { code: "08006" }));
  first.client.queryErrors.set("ROLLBACK", new Error("rollback also failed"));

  await assert.rejects(() => db.transaction(async () => "written"), /commit outcome unknown/);
  await settle();

  assert.notEqual((await db.pool()) as unknown as FakePool, first);
  await db.close();
});

test("close is terminal and cannot reopen the pool", async () => {
  const db = createPgPool("postgres://example/qm", ["SELECT 1"]);
  await db.pool();
  await db.close();

  await assert.rejects(() => db.pool(), /closed/);
  await assert.rejects(() => db.query("SELECT 1"), /closed/);
});
