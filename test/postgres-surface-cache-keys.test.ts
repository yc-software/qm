import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresSurfaceCache, type SurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

async function snapshot(cache: SurfaceCache) {
  return {
    channel: await cache.readMessages("C1", { channelHistory: true, includeDeleted: true, noFallback: true }),
    thread: await cache.readMessages("C1", { sub: "10.0", oldestFirst: true, noFallback: true }),
    exact: await cache.readMessages("C1", { timestamps: ["10.0", "12.0"], noFallback: true }),
    other: await cache.readMessages("D1", { noFallback: true }),
    revised: await cache.revisedSince("C1", 1),
    search: await cache.search("launch"),
    scopedSearch: await cache.search("launch", { container: "C1" }),
    threads: await cache.activeThreads(),
    containers: await cache.listContainers(),
    members: await cache.members("C1"),
    isMember: await cache.isMember("C1", "U2"),
    state: await cache.containerState("C1"),
  };
}

async function downgradeToLegacySchema(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    for (const [table, key] of [
      ["channel_messages", "org_id, container, ts"],
      ["channel_state", "org_id, container"],
      ["channel_files", "org_id, container, ts, file_id"],
    ] as const) {
      await pool.query(`DROP POLICY tenant_isolation ON ${table}`);
      await pool.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      await pool.query(`ALTER TABLE ${table} DROP COLUMN tenant_id CASCADE, DROP COLUMN surface, DROP COLUMN account`);
      await pool.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${key})`);
    }
    await pool.query("DELETE FROM qm_schema_migrations WHERE id IN ($1, $2) OR id LIKE $3 OR id LIKE $4", [
      "surface-cache/store/0008",
      "surface-cache/store/0009",
      "surface-cache/store/0010-tenants/%",
      "surface-cache/store/%-primary-key",
    ]);
  } finally {
    await pool.end();
  }
}

test("legacy mirror rows read identically after the surface-key upgrade", async () => {
  const url = testDatabaseUrl();
  let cache = createPostgresSurfaceCache(url);
  await cache.ingest([
    {
      container: "C1",
      ts: "10.0",
      sub: null,
      authorId: "U1",
      text: "the launch plan <@U2>",
      mentions: { U2: "bea" },
      members: ["U1", "U2"],
      containerName: "general",
      kind: "channel",
      files: [{ fileId: "F1", name: "plan.pdf", mimetype: "application/pdf", size: 3 }],
      createdAt: 10_000,
    },
    { container: "C1", ts: "11.0", sub: "10.0", authorId: "U2", text: "launch on friday", createdAt: 11_000 },
    { container: "C1", ts: "12.0", sub: "10.0", authorId: "B1", bot: true, text: "launch reminder", createdAt: 12_000 },
    { container: "C1", ts: "13.0", sub: null, authorId: "U1", text: "gone", createdAt: 13_000 },
    { container: "D1", ts: "20.0", sub: null, authorId: "U3", text: "launch dm", kind: "dm", createdAt: 20_000 },
  ]);
  await cache.ingest([
    {
      container: "C1",
      ts: "11.0",
      sub: "10.0",
      authorId: "U2",
      text: "launch on monday",
      editedAt: 15,
      createdAt: 11_000,
    },
    { container: "C1", ts: "13.0", deleted: true, createdAt: 13_000 },
  ]);
  await cache.markHandled("C1", "12.0");
  const before = await snapshot(cache);
  await cache.close();

  await downgradeToLegacySchema(url);
  cache = createPostgresSurfaceCache(url);
  try {
    assert.deepEqual(await snapshot(cache), before, "every read returns the same data after the upgrade");
    await cache.ingest([
      {
        container: "C1",
        ts: "11.0",
        sub: "10.0",
        authorId: "U2",
        text: "launch on tuesday",
        editedAt: 16,
        createdAt: 11_000,
      },
    ]);
    const thread = await cache.readMessages("C1", { sub: "10.0", oldestFirst: true, noFallback: true });
    assert.deepEqual(
      thread.map((m) => [m.ts, m.text]),
      [
        ["11.0", "launch on tuesday"],
        ["12.0", "launch reminder"],
      ],
      "an edit after the upgrade updates the legacy row in place",
    );
    const pool = new pg.Pool({ connectionString: url });
    try {
      const keys = await pool.query(
        "SELECT surface, account FROM channel_messages UNION SELECT surface, account FROM channel_state UNION SELECT surface, account FROM channel_files",
      );
      assert.deepEqual(keys.rows, [{ surface: "slack", account: "" }], "legacy rows are backfilled to slack");
      for (const [table, columns] of [
        ["channel_messages", "tenant_id, org_id, surface, account, container, ts"],
        ["channel_state", "tenant_id, org_id, surface, account, container"],
        ["channel_files", "tenant_id, org_id, surface, account, container, ts, file_id"],
      ] as const) {
        const key = await pool.query("SELECT pg_get_indexdef($1::regclass) AS def", [`${table}_pkey`]);
        assert.ok(key.rows[0].def.endsWith(`(${columns})`), `${table}'s primary key is its surface and account key`);
      }
    } finally {
      await pool.end();
    }
  } finally {
    await cache.close();
  }
});

test("concurrent first messages in new channels store each message and each channel once", async (t) => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  t.after(() => cache.close());
  const channels = Array.from({ length: 40 }, (_, i) => `C${i}`);
  const ingest = (container: string, ts: string) =>
    cache.ingest([{ account: "race", container, ts, text: ts, createdAt: 1 }]);
  await Promise.all(channels.flatMap((c) => ["1", "2", "3", "4", "5", "6", "7", "7"].map((ts) => ingest(c, ts))));
  const stored = await cache.listContainers({ account: "race" });
  assert.deepEqual(stored.map((s) => [s.container, s.messageCount]).sort(), channels.map((c) => [c, 7]).sort());
});
