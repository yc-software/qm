import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { MARK_SWARM_FORUMS_PERSON_USED_MIGRATION, STAMP_SWARM_COMPUTERS_MIGRATION } from "../src/swarms/swarm-store.ts";
import { MARK_ADMIN_CREATED_COMPUTERS_MIGRATION } from "../src/sandbox/sandbox-resources.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant } from "./support/test-tenant.ts";

test("the swarm computer migration marks each swarm's board and worker computers and nothing else", async () => {
  const url = testDatabaseUrl();
  const maps = createPostgresMapFactory(url);
  const swarms = maps.map<Record<string, unknown>>("swarms");
  const records = maps.map<{ id: string; swarmId?: string; personUsed?: true }>("sandbox_resources");
  await swarms.put("S1", {
    id: "S1",
    board: { sandboxId: "board-1" },
    members: [
      { id: "S1" },
      { id: "worker-1", sandboxId: "worker-1", forumSandboxId: "shared-1", state: "ready" },
      { id: "worker-1c", forumSandboxId: "failed-forum", state: "failed" },
      { id: "worker-1b", forumSandboxId: "board-1" },
    ],
  });
  await swarms.put("S2", { id: "S2", members: [{ id: "S2" }, { id: "worker-2", sandboxId: "worker-2" }] });
  await swarms.put("S4", {
    id: "S4",
    template: { botActor: true, actor: { id: "release-bot" } },
    members: [{ id: "S4" }, { id: "worker-4", forumSandboxId: "bot-forum", state: "ready" }],
    messages: [
      { seq: 1, actorId: "release-bot", audience: ["worker-4"] },
      { seq: 2, actorId: "alice", audience: ["worker-4"] },
    ],
  });
  await swarms.put("S5", { id: "S5", template: { botActor: true }, members: [{ id: "S5" }] });
  await swarms.put("S6", {
    id: "S6",
    members: [{ id: "S6" }, { id: "worker-6", forumSandboxId: "worker-5", state: "ready" }],
  });
  await swarms.put("S7", {
    id: "S7",
    template: { actor: { id: "release-bot" } },
    members: [{ id: "S7" }, { id: "worker-7", forumSandboxId: "legacy-forum", state: "ready" }],
  });
  await swarms.put("S8", {
    id: "S8",
    template: { botActor: true, actor: { id: "release-bot" } },
    members: [{ id: "S8" }, { id: "worker-8", forumSandboxId: "taken-forum", state: "ready" }],
    messages: [{ seq: 1, actorId: "alice", audience: ["worker-8"] }],
  });
  const ids = "board-1 worker-1 worker-2 shared-1 other-1 bot-forum legacy-forum taken-forum failed-forum";
  for (const id of ids.split(" ")) await records.put(id, { id });
  await records.put("worker-3", { id: "worker-3", swarmId: "S3" });
  await records.put("worker-5", { id: "worker-5", swarmId: "S5" });
  const pg = createPgPool(url);
  try {
    await pg.migrate(STAMP_SWARM_COMPUTERS_MIGRATION);
    assert.deepEqual(Object.fromEntries((await records.all()).map((record) => [record.id, record.swarmId ?? null])), {
      "board-1": "S1",
      "failed-forum": null,
      "bot-forum": null,
      "legacy-forum": null,
      "other-1": null,
      "shared-1": null,
      "taken-forum": null,
      "worker-1": "S1",
      "worker-2": "S2",
      "worker-3": "S3",
      "worker-5": "S5",
    });
    await pg.migrate(MARK_SWARM_FORUMS_PERSON_USED_MIGRATION);
    const used = (await records.all()).flatMap((record) => (record.personUsed ? [record.id] : []));
    assert.deepEqual(used.sort(), ["legacy-forum", "shared-1", "taken-forum", "worker-5"]);
    const cut = (await swarms.all()).flatMap((swarm) => (swarm.personUsedComputers ? [swarm.id] : []));
    assert.deepEqual(cut, ["S5"]);
  } finally {
    await pg.close();
  }
});

test("the admin computer migration marks only computers the admin API recorded creating", async () => {
  const url = testDatabaseUrl();
  const records = createPostgresMapFactory(url).map<{ id: string; personUsed?: true }>("sandbox_resources");
  for (const id of ["admin-1", "tool-1"]) await records.put(id, { id });
  const event = {
    at: 1,
    principalId: "U1",
    action: "sandbox.create",
    resource: "admin-1",
    scopeLabel: "channel:C1" as const,
  };
  await createPostgresAuditLog(url).recordOnce!(testTenant, "admin-1", event);
  const pg = createPgPool(url);
  await pg.migrate(MARK_ADMIN_CREATED_COMPUTERS_MIGRATION).finally(() => pg.close());
  const marks = Object.fromEntries((await records.all()).map((record) => [record.id, record.personUsed ?? null]));
  assert.deepEqual(marks, { "admin-1": true, "tool-1": null });
});
