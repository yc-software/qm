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

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-shared-")) }));
built.runtime.start();
const core = createServer(built.app, { signingSecret: SECRET });
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
  await built.runtime.stop();
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

interface SessionRow {
  id: string;
  threadRef: string;
  scopeId: string;
}

async function sessionsOf(user: string): Promise<SessionRow[]> {
  const r = await fetch(`${webBase}/api/sessions`, asUser(user));
  assert.equal(r.status, 200);
  return ((await r.json()) as { sessions: SessionRow[] }).sessions;
}

async function waitForSession(user: string, threadRef: string): Promise<SessionRow> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const match = (await sessionsOf(user)).find((s) => s.threadRef === threadRef);
    if (match) return match;
    assert.ok(Date.now() < deadline, `timed out waiting for ${user} to see session ${threadRef}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("/me carries the Slack workspace URL once the directory has one", async () => {
  await built.app.setDirectoryWorkspaceUrl("https://acme.slack.com");
  const me = (await (await fetch(`${webBase}/me`, asUser("alice"))).json()) as {
    user: string;
    slackWorkspaceUrl?: string | null;
  };
  assert.equal(me.user, "alice");
  assert.equal(me.slackWorkspaceUrl, "https://acme.slack.com");
});

test("a channel member can continue a teammate's shared web thread; outsiders and personal claims can't", async () => {
  await built.app.upsertChannels(
    [{ channelId: "C2", name: "sekrit", isPrivate: true }],
    [
      { channelId: "C2", principalId: "alice" },
      { channelId: "C2", principalId: "bob" },
    ],
  );

  const aliceTurn = await fetch(
    `${webBase}/api/turn`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({
        text: "kick off",
        threadRef: "web:alice:s1",
        scopeId: "channel:C2",
        channelName: "sekrit",
      }),
    }),
  );
  assert.ok(aliceTurn.status < 300, `alice's turn should be accepted (got ${aliceTurn.status})`);
  const session = await waitForSession("alice", "web:alice:s1");
  assert.equal(session.scopeId, "channel:C2");

  const bobTurn = await fetch(
    `${webBase}/api/turn`,
    asUser("bob", {
      method: "POST",
      body: JSON.stringify({ text: "me too", threadRef: "web:alice:s1", scopeId: "channel:C2" }),
    }),
  );
  assert.ok(bobTurn.status < 300, `bob's continuation should be accepted (got ${bobTurn.status})`);
  await waitForSession("bob", "web:alice:s1");

  assert.equal(
    (await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent("web:alice:s1")}`, asUser("bob"))).status,
    200,
  );
  assert.equal(
    (await fetch(`${webBase}/api/runs/active?threadRef=${encodeURIComponent("dm:D1")}`, asUser("bob"))).status,
    404,
  );

  const personalClaim = await fetch(
    `${webBase}/api/turn`,
    asUser("bob", { method: "POST", body: JSON.stringify({ text: "sneak", threadRef: "web:alice:s1" }) }),
  );
  assert.equal(personalClaim.status, 403);
  assert.equal(((await personalClaim.json()) as { error: string }).error, "forbidden_thread");

  const outsider = await fetch(
    `${webBase}/api/turn`,
    asUser("mallory", {
      method: "POST",
      body: JSON.stringify({ text: "sneak", threadRef: "web:alice:s1", scopeId: "channel:C2" }),
    }),
  );
  assert.equal(outsider.status, 403);
});
