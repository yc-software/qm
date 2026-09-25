import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-mirror-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    workspace: built.workspace,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await fetch(base + path, { headers })).json();

async function seed(built: ReturnType<typeof start>["built"]) {
  await built.app.ingestSurfaceEvents([
    {
      container: "C1",
      ts: "100.000100",
      authorId: "U1",
      authorName: "Carol",
      text: "kickoff message",
      members: ["U1", "U2"],
      containerName: "eng",
      createdAt: 1000,
    },
    {
      container: "C1",
      ts: "101.000100",
      authorId: "UBOT",
      authorName: "qm",
      text: "on it — here is the plan",
      self: true,
      createdAt: 2000,
    },
    {
      container: "C1",
      ts: "102.000100",
      sub: "100.000100",
      authorId: "U2",
      authorName: "Alice",
      text: "thread reply about deploys",
      createdAt: 3000,
    },
    {
      container: "C1",
      ts: "103.000100",
      authorId: "U2",
      authorName: "Alice",
      text: "message later deleted",
      deleted: true,
      createdAt: 4000,
    },
    {
      container: "C2",
      ts: "200.000100",
      authorId: "U3",
      authorName: "Ada",
      text: "different channel entirely",
      containerName: "ops",
      createdAt: 5000,
    },
  ]);
}

test("the mirror index lists containers with name, members, watermark, and message count", async () => {
  const s = start();
  try {
    await seed(s.built);
    const d = await getJson(s.base, "/v1/admin/slack-mirror");
    assert.equal(d.containers.length, 2);
    const c1 = d.containers.find((c: any) => c.container === "C1");
    assert.equal(c1.name, "eng");
    assert.deepEqual(c1.members, ["U1", "U2"]);
    assert.equal(c1.lastTs, "103.000100");
    assert.equal(c1.oldestTs, "100.000100");
    assert.equal(c1.messageCount, 3, "deleted tombstones don't count as mirrored");
    assert.equal(d.hasMore, false);
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "slack_mirror.read"),
      "read is audited",
    );
  } finally {
    await s.close();
  }
});

test("the timeline pages a container's messages oldest→newest and keeps deleted tombstones", async () => {
  const s = start();
  try {
    await seed(s.built);
    const d = await getJson(s.base, "/v1/admin/slack-mirror/messages?container=C1");
    assert.equal(d.mode, "timeline");
    assert.deepEqual(
      d.messages.map((m: any) => m.ts),
      ["100.000100", "101.000100", "102.000100", "103.000100"],
    );
    assert.equal(d.hasMore, false);
    const own = d.messages.find((m: any) => m.ts === "101.000100");
    assert.equal(own.self, true);
    const reply = d.messages.find((m: any) => m.ts === "102.000100");
    assert.equal(reply.sub, "100.000100");
    const gone = d.messages.find((m: any) => m.ts === "103.000100");
    assert.equal(gone.deleted, true);
    assert.ok(!d.messages.some((m: any) => m.container === "C2"), "scoped to the requested container");

    const page = await getJson(s.base, "/v1/admin/slack-mirror/messages?container=C1&limit=2");
    assert.deepEqual(
      page.messages.map((m: any) => m.ts),
      ["102.000100", "103.000100"],
    );
    assert.equal(page.hasMore, true);
    const older = await getJson(s.base, "/v1/admin/slack-mirror/messages?container=C1&limit=2&before=102.000100");
    assert.deepEqual(
      older.messages.map((m: any) => m.ts),
      ["100.000100", "101.000100"],
    );
    assert.equal(older.hasMore, false);

    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "slack_mirror.messages.read" && e.resource === "C1"),
      "message read is audited per container",
    );
  } finally {
    await s.close();
  }
});

test("q= searches mirrored bodies, org-wide or narrowed to a container", async () => {
  const s = start();
  try {
    await seed(s.built);
    const all = await getJson(s.base, "/v1/admin/slack-mirror/messages?q=" + encodeURIComponent("channel"));
    assert.equal(all.mode, "search");
    assert.ok(all.messages.some((m: any) => m.container === "C2"));
    const narrowed = await getJson(s.base, "/v1/admin/slack-mirror/messages?q=deploys&container=C1");
    assert.deepEqual(
      narrowed.messages.map((m: any) => m.ts),
      ["102.000100"],
    );
    assert.equal(narrowed.hasMore, false);
  } finally {
    await s.close();
  }
});

test("search reports hasMore and the applied limit when matches exceed the page", async () => {
  const s = start();
  try {
    await s.built.app.ingestSurfaceEvents(
      [1, 2, 3].map((n) => ({
        container: "C1",
        ts: `10${n}.000100`,
        authorId: "U1",
        text: `needle number ${n}`,
        createdAt: n * 1000,
      })),
    );
    const capped = await getJson(s.base, "/v1/admin/slack-mirror/messages?q=needle&limit=2");
    assert.equal(capped.mode, "search");
    assert.deepEqual(
      capped.messages.map((m: any) => m.ts),
      ["103.000100", "102.000100"],
      "the slice keeps the best-ranked front of the result, not the tail",
    );
    assert.equal(capped.hasMore, true);
    assert.equal(capped.limit, 2);
    const exact = await getJson(s.base, "/v1/admin/slack-mirror/messages?q=needle&limit=3");
    assert.equal(exact.messages.length, 3);
    assert.equal(exact.hasMore, false);
    assert.equal(exact.limit, 3);
  } finally {
    await s.close();
  }
});

test("search hasMore survives the store's read clamp at the route's maximum page size", async () => {
  const s = start();
  try {
    await s.built.app.ingestSurfaceEvents(
      Array.from({ length: 401 }, (_, i) => ({
        container: "C1",
        ts: `${1000 + i}.000100`,
        authorId: "U1",
        text: `needle number ${i}`,
        createdAt: 1000 + i,
      })),
    );
    const d = await getJson(s.base, "/v1/admin/slack-mirror/messages?q=needle&limit=400");
    assert.equal(d.messages.length, 400);
    assert.equal(d.hasMore, true);
    assert.equal(d.limit, 400);
  } finally {
    await s.close();
  }
});

const seedContainers = (built: ReturnType<typeof start>["built"], count: number) =>
  built.app.ingestSurfaceEvents(
    Array.from({ length: count }, (_, i) => ({
      container: `CT${i}`,
      ts: "100.000100",
      authorId: "U1",
      text: "hello",
      createdAt: 1000 + i,
    })),
  );

test("the mirror index reports hasMore when more containers exist than the page cap", async () => {
  const s = start();
  try {
    await seedContainers(s.built, 401);
    await new Promise((r) => setTimeout(r, 5));
    await s.built.app.ingestSurfaceEvents([
      { container: "FRESH", ts: "999.000100", authorId: "U1", text: "hello", createdAt: 9000 },
    ]);
    const d = await getJson(s.base, "/v1/admin/slack-mirror");
    assert.equal(d.containers.length, 400);
    assert.equal(d.hasMore, true);
    assert.equal(d.limit, 400);
    assert.equal(d.containers[0].container, "FRESH", "the page keeps the most recently active containers");
  } finally {
    await s.close();
  }
});

test("the mirror index reports hasMore false at exactly the page cap", async () => {
  const s = start();
  try {
    await seedContainers(s.built, 400);
    const d = await getJson(s.base, "/v1/admin/slack-mirror");
    assert.equal(d.containers.length, 400);
    assert.equal(d.hasMore, false);
  } finally {
    await s.close();
  }
});

test("ambient rows with no stored name resolve U…/C… ids from the directory at read time", async () => {
  const s = start();
  try {
    await s.built.app.ingestSurfaceEvents([
      {
        container: "C9",
        ts: "900.000100",
        authorId: "U9",
        text: "overheard <@U8> and <@U9|already> and <@UX>",
        createdAt: 9000,
      },
    ]);
    await s.built.directory.replace([
      { principalId: "U9", displayName: "Taylor", type: "internal", slackId: "U9" },
      { principalId: "U8", displayName: "Ada", type: "internal", slackId: "U8" },
    ]);
    await s.built.directory.replaceChannels([{ channelId: "C9", name: "watercooler" }]);

    const idx = await getJson(s.base, "/v1/admin/slack-mirror");
    const c9 = idx.containers.find((c: any) => c.container === "C9");
    assert.equal(c9.name, "watercooler", "channel id resolved to its directory name");

    const msgs = await getJson(s.base, "/v1/admin/slack-mirror/messages?container=C9");
    assert.equal(msgs.messages[0].authorName, "Taylor", "author id resolved to a display name");
    assert.equal(msgs.messages[0].mentions.U8, "Ada", "body mention id resolved from the directory");
    assert.equal(msgs.messages[0].mentions.UX, undefined, "unknown mention id left unresolved");
  } finally {
    await s.close();
  }
});

test("the mirror is org-admin only and requires a container or query", async () => {
  const s = start();
  try {
    await seed(s.built);
    for (const path of ["/v1/admin/slack-mirror", "/v1/admin/slack-mirror/messages?container=C1"]) {
      const r = await fetch(s.base + path, { headers: { "x-admin-actor": "stranger@default-org" } });
      assert.equal(r.status, 403, path);
    }
    const bad = await fetch(s.base + "/v1/admin/slack-mirror/messages", { headers: ALICE });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});
