import { test } from "node:test";
import assert from "node:assert/strict";
import { durableTaskStore } from "../src/wiring.ts";
import { createPostgresTaskStore } from "../src/tasks/postgres-task-store.ts";
import { registeredPgMigrations } from "../src/persistence/pg-pool.ts";

test("the task store's schema references sessions, so it is durable only with the durable session store", () => {
  const url = "postgres://qm@localhost:1/task_deps";
  createPostgresTaskStore(url);
  const tasks = registeredPgMigrations(url).find((migration) => migration.id === "tasks/store/0001");
  assert.ok(tasks?.statements.some((statement) => /REFERENCES\s+sessions\s*\(/i.test(statement)));

  assert.equal(durableTaskStore({ databaseUrl: url, sessionStore: "memory" }), false);
  assert.equal(durableTaskStore({ databaseUrl: url, sessionStore: "postgres" }), true);
  assert.equal(durableTaskStore({ databaseUrl: undefined, sessionStore: "postgres" }), false);
});
