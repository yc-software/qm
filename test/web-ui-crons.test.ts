import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-cron-")) }));
const core = createServer(built.app, { signingSecret: SECRET, scheduler: built.scheduler });
core.listen(0);
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `webuiuser=${encodeURIComponent(user)}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
      ...init.headers,
    },
  };
}

interface CronBody {
  cron: { title?: string; enabled: boolean; archived?: boolean };
}

test("list, rename, archive, disable, enable, run, delete are owner-gated", async () => {
  const created = await built.app.createCron({
    title: "Inbox summary",
    action: "summarize my inbox",
    schedule: { everyMs: 3_600_000 },
    owner: "alice",
    createdBy: "alice",
    ownerScopeId: "personal:alice",
  });
  const id = created.id;

  const aliceList = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    crons: Array<{ id: string }>;
  };
  assert.equal(aliceList.crons.length, 1);
  assert.equal(aliceList.crons[0]?.id, id);

  const bobList = (await (await fetch(`${webBase}/api/crons`, asUser("bob"))).json()) as { crons: unknown[] };
  assert.equal(bobList.crons.length, 0);
  for (const attempt of [
    fetch(`${webBase}/api/crons/${id}/disable`, asUser("bob", { method: "POST" })),
    fetch(`${webBase}/api/crons/${id}/enable`, asUser("bob", { method: "POST" })),
    fetch(`${webBase}/api/crons/${id}/run`, asUser("bob", { method: "POST" })),
    fetch(
      `${webBase}/api/crons/${id}`,
      asUser("bob", { method: "PATCH", body: JSON.stringify({ title: "Bob edit" }) }),
    ),
    fetch(`${webBase}/api/crons/${id}`, asUser("bob", { method: "DELETE" })),
  ]) {
    assert.equal((await attempt).status, 404);
  }

  const aliceRename = await fetch(
    `${webBase}/api/crons/${id}`,
    asUser("alice", { method: "PATCH", body: JSON.stringify({ title: "Inbox digest" }) }),
  );
  assert.equal(aliceRename.status, 200);
  assert.equal(((await aliceRename.json()) as CronBody).cron.title, "Inbox digest");

  const aliceDisable = await fetch(`${webBase}/api/crons/${id}/disable`, asUser("alice", { method: "POST" }));
  assert.equal(aliceDisable.status, 200);
  let list = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    crons: Array<{ enabled: boolean; archived?: boolean; title?: string }>;
  };
  assert.equal(list.crons[0]?.enabled, false);
  assert.equal(list.crons[0]?.title, "Inbox digest");

  const aliceEnable = await fetch(`${webBase}/api/crons/${id}/enable`, asUser("alice", { method: "POST" }));
  assert.equal(aliceEnable.status, 200);
  list = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    crons: Array<{ enabled: boolean; archived?: boolean; title?: string }>;
  };
  assert.equal(list.crons[0]?.enabled, true);

  const aliceRun = await fetch(`${webBase}/api/crons/${id}/run`, asUser("alice", { method: "POST" }));
  assert.equal(aliceRun.status, 200);

  const aliceArchive = await fetch(
    `${webBase}/api/crons/${id}`,
    asUser("alice", { method: "PATCH", body: JSON.stringify({ archived: true }) }),
  );
  assert.equal(aliceArchive.status, 200);
  const archived = (await aliceArchive.json()) as CronBody;
  assert.equal(archived.cron.archived, true);
  assert.equal(archived.cron.enabled, false);
  list = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    crons: Array<{ enabled: boolean; archived?: boolean; title?: string }>;
  };
  assert.equal(list.crons[0]?.archived, true);
  assert.equal(list.crons[0]?.enabled, false);

  const aliceDelete = await fetch(`${webBase}/api/crons/${id}`, asUser("alice", { method: "DELETE" }));
  assert.equal(aliceDelete.status, 200);
  list = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    crons: Array<{ enabled: boolean; archived?: boolean; title?: string }>;
  };
  assert.equal(list.crons.length, 0);
});

test("cron routes require a signed-in principal (401 without a cookie)", async () => {
  assert.equal((await fetch(`${webBase}/api/crons`)).status, 401);
});

test("retained cron runs are private to people who can manage the cron", async () => {
  const cron = await built.app.createCron({
    title: "Private report",
    action: "compile a private report",
    schedule: { everyMs: 3_600_000 },
    owner: "run-owner",
    createdBy: "run-owner",
    ownerScopeId: "personal:run-owner",
  });
  await built.crons.recordFire(cron.id, {
    fireKey: "private-fire",
    threadRef: "cron:private-fire",
    firedAt: Date.now(),
    status: "ok",
    reply: "private result",
    sessionId: "private-session",
  });

  const owner = await fetch(`${webBase}/api/crons/${cron.id}/runs`, asUser("run-owner"));
  assert.equal(owner.status, 200);
  assert.equal(((await owner.json()) as { runs: Array<{ reply?: string }> }).runs[0]?.reply, "private result");
  assert.equal((await fetch(`${webBase}/api/crons/${cron.id}/runs`, asUser("other-user"))).status, 404);

  await built.app.deleteCron(cron.id);
});

test("list splits owned crons from ones visible through shared scopes, and visibility never grants administration", async () => {
  await built.app.upsertDirectory([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [
      { channelId: "C9", name: "general", isPrivate: false },
      { channelId: "P1", name: "secret", isPrivate: true },
    ],
    [{ channelId: "P1", principalId: "bob" }],
  );

  const mk = (extra: Record<string, unknown>) =>
    built.app.createCron({
      schedule: { everyMs: 3_600_000 },
      action: "tick",
      owner: "bob",
      createdBy: "bob",
      ownerScopeId: "personal:bob",
      ...extra,
    } as never);
  const publicCron = await mk({ ownerScopeId: "channel:C9" });
  const privateCron = await mk({ ownerScopeId: "channel:P1" });
  const dmCron = await mk({ destination: { type: "principal", target: "alice", audienceScopeId: "personal:alice" } });
  const personalCron = await mk({});

  const aliceList = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    crons: Array<{ id: string; permission?: string }>;
    visible: Array<{ id: string; owner: string; scopeName?: string; permission?: string }>;
  };
  assert.equal(aliceList.crons.length, 0);
  const visibleIds = aliceList.visible.map((c) => c.id);
  assert.ok(visibleIds.includes(publicCron.id));
  assert.ok(visibleIds.includes(dmCron.id));
  assert.ok(!visibleIds.includes(privateCron.id), "private channel crons stay hidden from non-members");
  assert.ok(!visibleIds.includes(personalCron.id), "someone else's personal cron stays hidden");
  assert.equal(aliceList.visible.find((c) => c.id === publicCron.id)?.scopeName, "general");
  assert.equal(aliceList.visible.find((c) => c.id === publicCron.id)?.permission, "read");

  const bobList = (await (await fetch(`${webBase}/api/crons`, asUser("bob"))).json()) as {
    crons: Array<{ id: string }>;
    visible: unknown[];
  };
  const bobOwned = bobList.crons.map((c) => c.id);
  for (const id of [publicCron.id, privateCron.id, dmCron.id, personalCron.id]) assert.ok(bobOwned.includes(id));
  assert.equal(bobList.visible.length, 0);

  for (const attempt of [
    fetch(`${webBase}/api/crons/${publicCron.id}/disable`, asUser("alice", { method: "POST" })),
    fetch(`${webBase}/api/crons/${publicCron.id}/run`, asUser("alice", { method: "POST" })),
    fetch(
      `${webBase}/api/crons/${publicCron.id}`,
      asUser("alice", { method: "PATCH", body: JSON.stringify({ archived: true }) }),
    ),
    fetch(`${webBase}/api/crons/${publicCron.id}`, asUser("alice", { method: "DELETE" })),
  ]) {
    assert.equal((await attempt).status, 404);
  }

  for (const id of [publicCron.id, privateCron.id, dmCron.id, personalCron.id]) await built.app.deleteCron(id);
});

test("a private-channel MEMBER may manage a shared cron via the web; a public-channel member and a non-member may not", async () => {
  await built.app.upsertDirectory([
    { principalId: "alice", displayName: "Alice", type: "internal" },
    { principalId: "bob", displayName: "Bob", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [
      { channelId: "PUB", name: "town-square", isPrivate: false },
      { channelId: "PRIV", name: "secret", isPrivate: true },
    ],
    [
      { channelId: "PRIV", principalId: "alice" },
      { channelId: "PRIV", principalId: "bob" },
    ],
  );
  const privCron = await built.app.createCron({
    schedule: { everyMs: 3_600_000 },
    action: "tick",
    owner: "bob",
    createdBy: "bob",
    ownerScopeId: "channel:PRIV",
  } as never);
  const pubCron = await built.app.createCron({
    schedule: { everyMs: 3_600_000 },
    action: "tick",
    owner: "bob",
    createdBy: "bob",
    ownerScopeId: "channel:PUB",
  } as never);

  const aliceDisable = await fetch(`${webBase}/api/crons/${privCron.id}/disable`, asUser("alice", { method: "POST" }));
  assert.equal(aliceDisable.status, 200, "a private-channel member manages the scope's cron");
  assert.equal((await built.app.getCron(privCron.id))!.enabled, false);
  assert.equal((await built.app.getCron(privCron.id))!.createdBy, "bob");
  const aliceList = (await (await fetch(`${webBase}/api/crons`, asUser("alice"))).json()) as {
    visible: Array<{ id: string; permission?: string }>;
  };
  assert.equal(aliceList.visible.find((candidate) => candidate.id === privCron.id)?.permission, "manage");

  const carolPub = await fetch(`${webBase}/api/crons/${pubCron.id}/disable`, asUser("carol", { method: "POST" }));
  assert.equal(carolPub.status, 404, "a public channel stays owner-only");
  const carolPriv = await fetch(`${webBase}/api/crons/${privCron.id}`, asUser("carol", { method: "DELETE" }));
  assert.equal(carolPriv.status, 404, "a non-member is denied");

  for (const id of [privCron.id, pubCron.id]) await built.app.deleteCron(id);
});
