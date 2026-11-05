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
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-mem-")) }));
const core = createServer(built.app, {
  replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
  signingSecret: SECRET,
  memory: built.memory,
});
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

type Facts = { facts: Array<{ id: string; text: string }> };

test("a signed-in user lists, edits and forgets their own facts; identity is the cookie", async () => {
  const empty = await fetch(`${webBase}/api/memory`, asUser("alice"));
  assert.equal(empty.status, 200);
  assert.deepEqual(((await empty.json()) as Facts).facts, []);

  await built.memory.capture("personal:alice", ["Calls me Al", "Lives in Oakland"], Date.UTC(2026, 0, 2));
  const [al, oakland] = ((await (await fetch(`${webBase}/api/memory`, asUser("alice"))).json()) as Facts).facts;

  const edit = await fetch(
    `${webBase}/api/memory`,
    asUser("alice", { method: "PATCH", body: JSON.stringify({ facts: [{ id: al!.id, text: "Calls me Ally" }] }) }),
  );
  assert.equal(edit.status, 200);
  const forget = await fetch(
    `${webBase}/api/memory`,
    asUser("alice", { method: "DELETE", body: JSON.stringify({ ids: [oakland!.id] }) }),
  );
  assert.deepEqual(
    ((await forget.json()) as Facts).facts.map((fact) => fact.text),
    ["Calls me Ally"],
  );

  const spoofed = await fetch(
    `${webBase}/api/memory`,
    asUser("bob", {
      method: "PATCH",
      body: JSON.stringify({ principalId: "alice", facts: [{ id: al!.id, text: "bob was here" }] }),
    }),
  );
  assert.equal(spoofed.status, 404, "bob's notebook has no such fact; a spoofed principalId is ignored");
  assert.equal(await built.memory.read("personal:alice"), "- (2026-01-02) Calls me Ally");
});

test("memory routes require a signed-in principal", async () => {
  assert.equal((await fetch(`${webBase}/api/memory`)).status, 401);
  assert.equal(
    (
      await fetch(`${webBase}/api/memory`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["1"] }),
      })
    ).status,
    401,
  );
});
