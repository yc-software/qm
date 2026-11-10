import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { STAMP_SWARM_COMPUTERS_MIGRATION } from "../src/swarms/swarm-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("the swarm computer migration marks each swarm's board and worker computers and nothing else", async () => {
  const url = testDatabaseUrl();
  const maps = createPostgresMapFactory(url);
  const swarms = maps.map<Record<string, unknown>>("swarms");
  const records = maps.map<{ id: string; swarmId?: string }>("sandbox_resources");
  await swarms.put("S1", {
    id: "S1",
    board: { sandboxId: "board-1" },
    members: [{ id: "S1" }, { id: "worker-1", sandboxId: "worker-1", forumSandboxId: "shared-1" }],
  });
  await swarms.put("S2", { id: "S2", members: [{ id: "S2" }, { id: "worker-2", sandboxId: "worker-2" }] });
  for (const id of ["board-1", "worker-1", "worker-2", "shared-1", "other-1"]) await records.put(id, { id });
  await records.put("worker-3", { id: "worker-3", swarmId: "S3" });
  const pg = createPgPool(url);
  try {
    await pg.migrate(STAMP_SWARM_COMPUTERS_MIGRATION);
    assert.deepEqual(Object.fromEntries((await records.all()).map((record) => [record.id, record.swarmId ?? null])), {
      "board-1": "S1",
      "other-1": null,
      "shared-1": null,
      "worker-1": "S1",
      "worker-2": "S2",
      "worker-3": "S3",
    });
  } finally {
    await pg.close();
  }
});
