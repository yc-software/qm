import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { MARK_SWARM_FORUMS_PERSON_USED_MIGRATION, STAMP_SWARM_COMPUTERS_MIGRATION } from "../src/swarms/swarm-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("the swarm computer migration marks each swarm's board and worker computers and nothing else", async () => {
  const url = testDatabaseUrl();
  const maps = createPostgresMapFactory(url);
  const swarms = maps.map<Record<string, unknown>>("swarms");
  const records = maps.map<{ id: string; swarmId?: string; personUsed?: true }>("sandbox_resources");
  await swarms.put("S1", {
    id: "S1",
    board: { sandboxId: "board-1" },
    members: [{ id: "S1" }, { id: "worker-1", sandboxId: "worker-1", forumSandboxId: "shared-1" }],
  });
  await swarms.put("S2", { id: "S2", members: [{ id: "S2" }, { id: "worker-2", sandboxId: "worker-2" }] });
  await swarms.put("S4", {
    id: "S4",
    template: { botActor: true },
    members: [{ id: "S4" }, { id: "worker-4", forumSandboxId: "bot-forum" }],
  });
  await swarms.put("S5", { id: "S5", template: { botActor: true }, members: [{ id: "S5" }] });
  await swarms.put("S6", { id: "S6", members: [{ id: "S6" }, { id: "worker-6", forumSandboxId: "worker-5" }] });
  for (const id of ["board-1", "worker-1", "worker-2", "shared-1", "other-1", "bot-forum"])
    await records.put(id, { id });
  await records.put("worker-3", { id: "worker-3", swarmId: "S3" });
  await records.put("worker-5", { id: "worker-5", swarmId: "S5" });
  const pg = createPgPool(url);
  try {
    await pg.migrate(STAMP_SWARM_COMPUTERS_MIGRATION);
    assert.deepEqual(Object.fromEntries((await records.all()).map((record) => [record.id, record.swarmId ?? null])), {
      "board-1": "S1",
      "bot-forum": null,
      "other-1": null,
      "shared-1": null,
      "worker-1": "S1",
      "worker-2": "S2",
      "worker-3": "S3",
      "worker-5": "S5",
    });
    await pg.migrate(MARK_SWARM_FORUMS_PERSON_USED_MIGRATION);
    const used = (await records.all()).flatMap((record) => (record.personUsed ? [record.id] : []));
    assert.deepEqual(used.sort(), ["shared-1", "worker-5"]);
    const cut = (await swarms.all()).flatMap((swarm) => (swarm.personUsedComputers ? [swarm.id] : []));
    assert.deepEqual(cut, ["S5"]);
  } finally {
    await pg.close();
  }
});
