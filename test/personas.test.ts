import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { credentialHandle } from "../src/credentials/keychain.ts";
import type { PersonaResult } from "../src/personas/persona-service.ts";
import { orgId } from "../src/config.ts";
import { createPostgresPersonaStore } from "../src/personas/persona-store.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";

const ALICE = "U_ALICE";
const BOB = "U_BOB";
const CAROL = "U_CAROL";

function setup() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personas-")) }));
  const personas = built.app.personas!;
  const enable = (who: string) => built.featureFlags.setEnabled("personas", scopeId("personal", who), true, "admin");
  const sysprompt = async (who: string, conversation: TurnRequest["conversation"]) => {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: who },
      conversation,
      text: "!sysprompt",
    });
    assert.equal(result.status, "ok");
    return { reply: result.reply ?? "", sessionId: result.sessionId! };
  };
  return { built, personas, enable, sysprompt };
}

function ok<T>(result: PersonaResult<T>): T {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { value: T }).value;
}

test("personas are invisible until the flag is on, then the creator owns what they make", async () => {
  const { personas, enable } = setup();
  assert.deepEqual(await personas.list(ALICE), { status: "disabled" });
  await enable(ALICE);
  const ada = ok(await personas.create(ALICE, { name: "Ada", instructions: "Answer in haiku." }));
  assert.equal(ada.role, "owner");
  assert.deepEqual(
    ok(await personas.list(ALICE)).map((p) => [p.name, p.role]),
    [["Ada", "owner"]],
  );
  await enable(BOB);
  assert.deepEqual(ok(await personas.list(BOB)), []);
  assert.equal((await personas.detail(BOB, ada.id)).status, "not_found");
});

test("readers chat, writers edit, only owners share, and the last owner cannot be removed", async () => {
  const { built, personas, enable } = setup();
  for (const who of [ALICE, BOB, CAROL]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "write" },
      { scopeId: scopeId("org", orgId()), role: "read" },
    ]),
  );
  assert.deepEqual(
    ok(await personas.list(CAROL)).map((p) => [p.name, p.role]),
    [["Ada", "read"]],
  );
  assert.equal((await personas.update(CAROL, ada.id, { description: "a reader edit" })).status, "forbidden");

  assert.equal(
    ok(await personas.update(BOB, ada.id, { description: "edited by a writer" })).description,
    "edited by a writer",
  );
  assert.equal((await personas.setAccess(BOB, ada.id, [])).status, "forbidden");
  assert.equal((await personas.remove(BOB, ada.id)).status, "forbidden");

  const lastOwner = await personas.setAccess(ALICE, ada.id, [{ scopeId: scopeId("personal", BOB), role: "write" }]);
  assert.equal(lastOwner.status, "invalid");
  assert.equal(ok(await personas.detail(ALICE, ada.id)).access.filter((a) => a.role === "owner").length, 1);

  assert.equal(await built.app.managesScope(BOB, scopeId("persona", ada.id)), true);
  assert.equal(await built.app.managesScope(CAROL, scopeId("persona", ada.id)), false);
  ok(await personas.remove(ALICE, ada.id));
  assert.deepEqual(ok(await personas.list(ALICE)), []);
});

test("a conversation's persona shapes the turn only for people who hold a role on it", async () => {
  const { built, personas, enable, sysprompt } = setup();
  for (const who of [ALICE, BOB, CAROL]) await enable(who);
  const marker = "PERSONA-INSTRUCTIONS-7f3a";
  const ada = ok(await personas.create(ALICE, { name: "Ada", instructions: marker }));

  const dm = { kind: "dm" as const, threadRef: "dm:U_ALICE:personas" };
  const first = await sysprompt(ALICE, dm);
  assert.ok(!first.reply.includes(marker));
  const session = (await built.sessions.get(first.sessionId))!;
  ok(await personas.assign(ALICE, session, ada.id));
  assert.equal((await built.sessions.get(first.sessionId))?.personaId, ada.id);
  assert.ok((await sysprompt(ALICE, dm)).reply.includes(marker));

  const channel = { kind: "channel" as const, channelRef: "C_PERSONA", threadRef: "channel:C_PERSONA:t1" };
  const opened = await sysprompt(ALICE, channel);
  ok(await personas.assign(ALICE, (await built.sessions.get(opened.sessionId))!, ada.id));
  assert.ok(!(await sysprompt(BOB, channel)).reply.includes(marker));

  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("channel", "C_PERSONA"), role: "read" },
    ]),
  );
  assert.ok((await sysprompt(BOB, channel)).reply.includes(marker));
  assert.deepEqual(ok(await personas.list(BOB)), []);
  const bobDm = await sysprompt(BOB, { kind: "dm", threadRef: "dm:U_BOB:personas" });
  assert.equal((await personas.assign(BOB, (await built.sessions.get(bobDm.sessionId))!, ada.id)).status, "not_found");
});

test("a persona conversation stays private to the people in it, even from the persona's other owners", async () => {
  const { built, personas, enable, sysprompt } = setup();
  for (const who of [ALICE, BOB]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "owner" },
    ]),
  );
  const bobChat = await sysprompt(BOB, { kind: "dm", threadRef: "dm:U_BOB:with-ada" });
  ok(await personas.assign(BOB, (await built.sessions.get(bobChat.sessionId))!, ada.id));
  assert.equal(await built.app.getSessionForViewer(bobChat.sessionId, ALICE), null);
  const aliceList = await built.app.listSessionPage(ALICE, { limit: 50, status: "active" });
  assert.ok(!aliceList.sessions.some((session) => session.id === bobChat.sessionId));
  const bobList = await built.app.listSessionPage(BOB, { limit: 50, status: "active" });
  assert.equal(bobList.sessions.find((session) => session.id === bobChat.sessionId)?.personaId, ada.id);
});

test("skills written into a persona show for everyone with a role on it, and nobody else", async () => {
  const { built, personas, enable } = setup();
  for (const who of [ALICE, BOB, CAROL]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "read" },
    ]),
  );
  const skill = await built.app.createOwnedSkill({
    principalId: ALICE,
    homeScope: scopeId("persona", ada.id),
    name: "review-checklist",
    description: "Use when reviewing a change.",
    body: "Check tests first.",
  });
  assert.equal(skill?.scopeId, scopeId("persona", ada.id));
  const sees = async (who: string) =>
    (await built.app.listVisibleSkills(who)).some((row) => row.skill?.id === skill!.id);
  assert.equal(await sees(ALICE), true);
  assert.equal(await sees(BOB), true);
  assert.equal(await sees(CAROL), false);
});

test("a persona's page lists crons from conversations with it, only to people who can see them", async () => {
  const { built, personas, enable, sysprompt } = setup();
  for (const who of [ALICE, BOB]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "read" },
    ]),
  );
  const withAda = await sysprompt(ALICE, { kind: "dm", threadRef: "dm:U_ALICE:with-ada" });
  ok(await personas.assign(ALICE, (await built.sessions.get(withAda.sessionId))!, ada.id));
  const plain = await sysprompt(ALICE, { kind: "dm", threadRef: "dm:U_ALICE:plain" });
  const cron = (title: string, sessionId: string) =>
    built.sessions.get(sessionId).then((session) =>
      built.app.createCron({
        ownerScopeId: scopeId("personal", ALICE),
        owner: ALICE,
        createdBy: ALICE,
        title,
        schedule: { everyMs: 3_600_000 },
        action: "summarize",
        sessionRef: session!.threadRef,
      }),
    );
  await cron("Ada digest", withAda.sessionId);
  await cron("Unrelated", plain.sessionId);
  const server = createInsecureTestServer(built.app, { sessions: built.sessions });
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const cronsFor = async (who: string) => {
      const r = await fetch(`${base}/v1/personas/${ada.id}?principalId=${who}`);
      const body = (await r.json()) as { persona: { crons: Array<{ title: string; enabled: boolean }> } };
      return body.persona.crons.map((c) => [c.title, c.enabled]);
    };
    assert.deepEqual(await cronsFor(ALICE), [["Ada digest", true]]);
    assert.deepEqual(await cronsFor(BOB), []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("credentials attached by an owner reach every turn that uses the persona, and leave with it", async () => {
  const { built, personas, enable, sysprompt } = setup();
  const keychain = built.keychain;
  assert.ok(keychain, "keychain is configured in tests");
  for (const who of [ALICE, BOB]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "read" },
    ]),
  );
  const credential = await keychain.save({ ownerId: ALICE, service: "acme", secret: "s3cret", envKey: "ACME_TOKEN" });
  const bobOwn = await keychain.save({ ownerId: BOB, service: "bobsvc", secret: "b0b", envKey: "BOB_TOKEN" });
  assert.equal((await personas.attachCredential(BOB, ada.id, bobOwn.id)).status, "forbidden");
  ok(await personas.attachCredential(ALICE, ada.id, credential.id));
  assert.deepEqual(
    ok(await personas.detail(BOB, ada.id)).credentials.map((c) => c.service),
    ["acme"],
  );

  const dm = { kind: "dm" as const, threadRef: "dm:U_BOB:creds" };
  const opened = await sysprompt(BOB, dm);
  const handle = credentialHandle(credential);
  assert.ok(!opened.reply.includes(handle));
  ok(await personas.assign(BOB, (await built.sessions.get(opened.sessionId))!, ada.id));
  assert.ok((await sysprompt(BOB, dm)).reply.includes(handle));

  ok(await personas.remove(ALICE, ada.id));
  assert.ok(!(await sysprompt(BOB, dm)).reply.includes(handle));
});

test("linking a sign-in keeps persona authorship and grants with the person", async () => {
  const url = testMigratedDatabaseUrl();
  const users = createPostgresUserStore(url);
  const store = createPostgresPersonaStore(url);
  const persona = await store.create({ name: "Ada" }, scopeId("personal", "alias@example.com"), "alias@example.com");
  assert.equal(persona.createdBy, "alias@example.com");
  await users.link({
    principalId: "alias@example.com",
    canonicalId: "canon@example.com",
    evidence: "test",
    linkedBy: "admin",
    createdAt: Date.now(),
  });
  assert.equal((await store.get(persona.id))?.createdBy, "canon@example.com");
  assert.equal((await store.access(persona.id))[0]?.grantedBy, "canon@example.com");
});
