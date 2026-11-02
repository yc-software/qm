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
    for (const table of ["channel_messages", "channel_state", "channel_files"]) {
      await pool.query(`ALTER TABLE ${table} DROP COLUMN surface, DROP COLUMN account`);
    }
    await pool.query("ALTER TABLE channel_messages ADD PRIMARY KEY (org_id, container, ts)");
    await pool.query("ALTER TABLE channel_state ADD PRIMARY KEY (org_id, container)");
    await pool.query("ALTER TABLE channel_files ADD PRIMARY KEY (org_id, container, ts, file_id)");
    await pool.query("DELETE FROM qm_schema_migrations WHERE id IN ($1, $2, $3)", [
      "surface-cache/store/0007",
      "surface-cache/store/0008",
      "surface-cache/store/0009",
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
        ["channel_messages", "org_id, surface, account, container, ts"],
        ["channel_state", "org_id, surface, account, container"],
        ["channel_files", "org_id, surface, account, container, ts, file_id"],
      ] as const) {
        const pk = await pool.query(
          "SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indisprimary AND indrelid = $1::regclass",
          [table],
        );
        assert.ok(pk.rows[0].def.endsWith(`(${columns})`), `${table} is keyed by surface and account`);
      }
    } finally {
      await pool.end();
    }
  } finally {
    await cache.close();
  }
});

test("two surfaces with the same container id do not collide", async () => {
  const url = testDatabaseUrl();
  const cache = createPostgresSurfaceCache(url);
  const other = { surface: "bookface", account: "acct" };
  try {
    await cache.ingest([
      { container: "C1", ts: "1.0", sub: null, authorId: "U1", text: "slack launch", members: ["U1"], createdAt: 1 },
      { container: "C1", ts: "2.0", sub: "1.0", authorId: "U1", text: "slack reply", createdAt: 2 },
      {
        ...other,
        container: "C1",
        ts: "1.0",
        sub: null,
        authorId: "P1",
        self: true,
        text: "bookface launch",
        members: ["P1"],
        files: [{ fileId: "F9", name: "deck.pdf" }],
        createdAt: 1,
      },
      { ...other, container: "C1", ts: "3.0", sub: "1.0", bot: true, text: "bookface reply", createdAt: 3 },
    ]);
    await cache.markHandled("C1", "1.0", other);

    const slack = await cache.readMessages("C1", { noFallback: true, channelHistory: true });
    assert.deepEqual(
      slack.map((m) => [m.surface, m.ts, m.text, m.replyCount, m.handled, m.files]),
      [[undefined, "1.0", "slack launch", 1, undefined, undefined]],
    );
    const bookface = await cache.readMessages("C1", { ...other, noFallback: true, channelHistory: true });
    assert.deepEqual(
      bookface.map((m) => [m.surface, m.account, m.ts, m.text, m.replyCount, m.handled, m.files?.map((f) => f.fileId)]),
      [["bookface", "acct", "1.0", "bookface launch", 1, true, ["F9"]]],
    );
    assert.deepEqual(
      (await cache.search("launch")).map((m) => m.text),
      ["slack launch"],
    );
    assert.deepEqual(
      (await cache.search("launch", other)).map((m) => m.text),
      ["bookface launch"],
    );
    assert.deepEqual(
      (await cache.activeThreads(other)).map((t) => [t.container, t.sub, t.lastTs]),
      [["C1", "1.0", "3.0"]],
    );
    assert.deepEqual(await cache.members("C1"), ["U1"]);
    assert.deepEqual(await cache.members("C1", other), ["P1"]);
    assert.equal(await cache.isMember("C1", "P1"), false);
    assert.deepEqual(
      (await cache.listContainers(other)).map((c) => [c.container, c.messageCount]),
      [["C1", 2]],
    );
    assert.deepEqual(
      (await cache.listContainers()).map((c) => [c.container, c.messageCount]),
      [["C1", 2]],
    );
  } finally {
    await cache.close();
  }
});
