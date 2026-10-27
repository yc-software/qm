import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../support/build-app.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";
import { testConfigStore, testDatabaseUrl } from "../support/test-database.ts";

const org = scopeId("org", "default-org");
const internalActor = { externalId: "U1" };
const guest = { externalId: "G9", isExternalGuest: true };

function externalChannelTurn(surface: string): TurnRequest {
  return {
    origin: { kind: "direct" },
    surface,
    actor: internalActor,
    conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [internalActor, guest] },
    text: "hello channel",
  };
}

function freshApp() {
  return buildApp(testConfig());
}

test("external-slack-participants: default off; the org flip is what turns it on", async () => {
  const c = testConfigStore();
  assert.equal(c.setting("externalSlackParticipants", org), false);
  await c.setSetting("externalSlackParticipants", true, org);
  assert.equal(c.setting("externalSlackParticipants", org), true);
  await c.setSetting("externalSlackParticipants", false, org);
  assert.equal(c.setting("externalSlackParticipants", org), false);
});

test("external-slack-participants: the durable read sees a flip from another instance without a restart", async () => {
  const databaseUrl = testDatabaseUrl();
  const a = testConfigStore({ databaseUrl });
  const b = testConfigStore({ databaseUrl });

  await a.setSetting("externalSlackParticipants", true, org);
  await Promise.resolve();

  assert.equal(
    b.setting("externalSlackParticipants", org),
    false,
    "the sibling's stale read-cache hasn't seen the flip",
  );
  assert.equal(
    await b.settingDurable("externalSlackParticipants", org),
    true,
    "but the durable read picks it up at once",
  );
});

test("a Slack channel turn with an external in the audience is refused while the toggle is off", async () => {
  const { app } = freshApp();
  const res = await app.turn(externalChannelTurn("slack"));
  assert.equal(res.status, "refused");
  assert.match(res.reason ?? "", /internal-only/);
});

test("with the toggle on, an internal actor may drive a Slack turn in a room with an external", async () => {
  const built = freshApp();
  await built.config.setSetting("externalSlackParticipants", true, org);
  await Promise.resolve();
  const res = await built.app.turn(externalChannelTurn("slack"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: hello channel/);
});

test("the toggle relaxes only Slack: a non-Slack surface with an external audience stays refused", async () => {
  const built = freshApp();
  await built.config.setSetting("externalSlackParticipants", true, org);
  await Promise.resolve();
  const res = await built.app.turn(externalChannelTurn("test"));
  assert.equal(res.status, "refused");
  assert.match(res.reason ?? "", /internal-only/);
});

test("the toggle never lets an external actor interact", async () => {
  const built = freshApp();
  await built.config.setSetting("externalSlackParticipants", true, org);
  await Promise.resolve();
  const res = await built.app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: guest,
    conversation: { kind: "channel", threadRef: "ch:C1:t2", channelRef: "C1", audience: [internalActor, guest] },
    text: "hi",
  });
  assert.equal(res.status, "refused");
  assert.match(res.reason ?? "", /internal-only/);
});

test("a bot assertion can enter the turn pipeline", async () => {
  const built = freshApp();
  const res = await built.app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: { externalId: "B1", isBot: true },
    conversation: { kind: "dm", threadRef: "dm:B1:t1" },
    text: "hello",
  });
  assert.equal(res.status, "ok");
  assert.equal((await built.runs.list()).length, 1);
});

test("admin resource: org-only PUT, read-back, and the surface-config echo", async () => {
  const built = freshApp();
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    acl: built.acl,
    serviceCreds: built.serviceCreds,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
  try {
    const notOrg = await fetch(`${base}/v1/admin/scopes/personal:u1/external-slack-participants`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ on: true }),
    });
    assert.equal(notOrg.status, 400);

    const put = await fetch(`${base}/v1/admin/scopes/org:default-org/external-slack-participants`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ on: true }),
    });
    assert.equal(put.status, 200);

    const read = await fetch(`${base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(((await read.json()) as { externalSlackParticipants?: boolean }).externalSlackParticipants, true);

    const surf = await fetch(`${base}/v1/surface-config`);
    assert.equal(((await surf.json()) as { externalSlackParticipants?: boolean }).externalSlackParticipants, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
