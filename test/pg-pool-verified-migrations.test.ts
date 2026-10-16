import assert from "node:assert/strict";
import { mock, test } from "node:test";

const connects: string[] = [];
const statements: string[] = [];
let failuresLeft = 0;
let bootGate: Promise<void> = Promise.resolve();

mock.module("pg", {
  defaultExport: {
    Pool: class {
      options: { connectionString: string };
      constructor(options: { connectionString: string }) {
        this.options = options;
      }
      on() {
        return this;
      }
      async connect() {
        connects.push(this.options.connectionString);
        return {
          async query(text: string) {
            statements.push(text);
            if (text === "SELECT 'gated'") await bootGate;
            if (text === "SELECT 'flaky'" && failuresLeft > 0) {
              failuresLeft--;
              throw new Error("transient migration failure");
            }
            return { rows: [] };
          },
          release() {},
        };
      }
      async end() {}
    },
  },
});
const { createPgPool, migrateRegisteredPgSchemas } = await import("../src/persistence/pg-pool.ts");

const first = { id: "verified/0001", statements: ["SELECT 1"] };

test("stores open at boot skip migrations the boot migrate verified", async () => {
  const url = "postgres://verified-boot/db";
  const store = createPgPool(url, [first]);
  const sibling = createPgPool(url);
  await migrateRegisteredPgSchemas(url);
  assert.deepEqual(connects.splice(0), [url]);

  await store.migrate(first);
  await sibling.migrate(first);
  assert.deepEqual(connects.splice(0), []);

  await store.migrate({ id: "verified/0002", statements: ["SELECT 2"] });
  assert.deepEqual(connects.splice(0), [url]);
  await store.migrate({ id: "verified/0002", statements: ["SELECT 2"] });
  assert.deepEqual(connects.splice(0), []);

  await createPgPool(url, [first]).migrate(first);
  assert.deepEqual(connects.splice(0), [url]);

  const other = "postgres://verified-boot/other";
  await createPgPool(other, [first]).migrate(first);
  assert.deepEqual(connects.splice(0), [other]);
});

test("a failed migration is not remembered as verified and is retried", async () => {
  const url = "postgres://verified-retry/db";
  const flaky = { id: "verified/flaky", statements: ["SELECT 'flaky'"] };
  const store = createPgPool(url, [flaky]);
  failuresLeft = 2;
  await assert.rejects(migrateRegisteredPgSchemas(url), /transient migration failure/);
  await assert.rejects(store.migrate(flaky), /transient migration failure/);
  assert.deepEqual(connects.splice(0), [url, url]);

  statements.length = 0;
  await store.migrate(flaky);
  assert.deepEqual(connects.splice(0), [url]);
  assert.ok(statements.includes("SELECT 'flaky'"));

  await store.migrate(flaky);
  assert.deepEqual(connects.splice(0), []);
});

function holdBoot(): () => void {
  let release = () => {};
  bootGate = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

test("store migrations queued behind an in-flight boot migrate skip once it succeeds", async () => {
  const url = "postgres://verified-queued/db";
  const gated = { id: "verified/gated", statements: ["SELECT 'gated'"] };
  const store = createPgPool(url, [gated]);
  const release = holdBoot();
  const boot = migrateRegisteredPgSchemas(url);
  const queued = store.migrate(gated);
  release();
  await Promise.all([boot, queued]);
  assert.deepEqual(connects.splice(0), [url]);
});

test("after-migration maintenance still runs when the boot migrate verified the migrations", async () => {
  const url = "postgres://verified-after/db";
  const store = createPgPool(url, [first], [{ id: "verified/after", statements: ["SELECT 'after'"] }]);
  await migrateRegisteredPgSchemas(url);
  assert.deepEqual(connects.splice(0), [url]);

  statements.length = 0;
  await store.migrate(first);
  assert.notDeepEqual(connects.splice(0), []);
  assert.ok(statements.includes("SELECT 'after'"));

  await store.migrate(first);
  assert.deepEqual(connects.splice(0), []);
});

test("a pool closed while the boot migrate runs stays closed and does not affect open pools", async () => {
  const url = "postgres://verified-closed/db";
  const gated = { id: "verified/gated", statements: ["SELECT 'gated'"] };
  const closing = createPgPool(url, [gated]);
  const open = createPgPool(url, [gated]);
  const release = holdBoot();
  const boot = migrateRegisteredPgSchemas(url);
  await closing.close();
  release();
  await boot;
  assert.deepEqual(connects.splice(0), [url]);

  await assert.rejects(closing.migrate(gated), /closed/);
  await open.migrate(gated);
  assert.deepEqual(connects.splice(0), []);

  await open.close();
  await createPgPool(url, [gated]).migrate(gated);
  assert.deepEqual(connects.splice(0), [url]);
});
