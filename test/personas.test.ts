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
import { createPostgresPersonaStore, type PersonaVersion } from "../src/personas/persona-store.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { runNowSettled } from "./support/settle.ts";
import { resolveCapabilityDestination } from "../src/api/capability-destination.ts";

const ALICE = "U_ALICE";
const BOB = "U_BOB";
const CAROL = "U_CAROL";

function setup() {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "personas-")),
      signingSecret: "test-secret",
      apiBaseUrl: "https://core.example.com",
    }),
  );
  const personas = built.app.personas!;
  const enable = (who: string) => built.featureFlags.setEnabled("personas", scopeId("personal", who), true, "admin");
  const sysprompt = async (who: string, conversation: TurnRequest["conversation"], botActor?: true) => {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: who },
      conversation,
      text: "!sysprompt",
      ...(botActor ? { botActor } : {}),
    });
    assert.equal(result.status, "ok");
    const session = await built.sessions.get(result.sessionId!);
    return { reply: result.reply ?? "", sessionId: result.sessionId!, scopeId: session!.scopeId };
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

test("the access list says which grantees the personas flag reaches", async () => {
  const { built, personas, enable } = setup();
  await enable(ALICE);
  await built.featureFlags.setEnabled("personas", scopeId("team", "T_DESIGN"), true, "admin");
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "read" },
      { scopeId: scopeId("team", "T_DESIGN"), role: "read" },
      { scopeId: scopeId("org", orgId()), role: "read" },
    ]),
  );
  const reach = async () =>
    ok(await personas.detail(ALICE, ada.id)).access.map((grant) => [grant.scopeId, grant.personasEnabled]);
  assert.deepEqual(await reach(), [
    [scopeId("personal", ALICE), true],
    [scopeId("org", orgId()), false],
    [scopeId("personal", BOB), false],
    [scopeId("team", "T_DESIGN"), false],
  ]);
  await built.featureFlags.setEnabled("personas", scopeId("org", orgId()), true, "admin");
  assert.ok((await reach()).every(([, enabled]) => enabled === true));
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
  assert.equal(await built.app.getSessionForViewer(bobChat.sessionId, { actorId: ALICE }), null);
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

test("credentials attached to a persona reach a Slack bot's turns that use it", async () => {
  const { built, personas, enable, sysprompt } = setup();
  const BOT = "U_RELEASEBOT";
  for (const who of [ALICE, BOT]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOT), role: "read" },
    ]),
  );
  const credential = await built.keychain!.save({
    ownerId: ALICE,
    service: "acme",
    secret: "s3cret",
    envKey: "ACME_TOKEN",
  });
  ok(await personas.attachCredential(ALICE, ada.id, credential.id));
  const dm = { kind: "dm" as const, threadRef: "dm:U_RELEASEBOT:creds" };
  const opened = await sysprompt(BOT, dm, true);
  ok(await personas.assign(BOT, (await built.sessions.get(opened.sessionId))!, ada.id));
  assert.ok((await sysprompt(BOT, dm, true)).reply.includes(credentialHandle(credential)));
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
  assert.equal((await store.versions(persona.id, { limit: 1 })).versions[0]?.editedBy, "canon@example.com");
});

test("every edit that changes a persona is a version anyone with a role can read, and writers can roll back", async () => {
  const { personas, enable } = setup();
  for (const who of [ALICE, BOB, CAROL]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada", instructions: "Answer in haiku." }));
  ok(
    await personas.setAccess(ALICE, ada.id, [
      { scopeId: scopeId("personal", ALICE), role: "owner" },
      { scopeId: scopeId("personal", BOB), role: "write" },
      { scopeId: scopeId("personal", CAROL), role: "read" },
    ]),
  );
  assert.equal(ada.version, 1);
  assert.equal(ok(await personas.update(BOB, ada.id, { instructions: "Answer in limericks." })).version, 2);
  assert.equal(ok(await personas.update(BOB, ada.id, { instructions: "Answer in limericks." })).version, 2);
  assert.equal(ok(await personas.update(ALICE, ada.id, { icon: { kind: "emoji", value: "🎨" } })).version, 3);

  const newest = ok(await personas.versions(CAROL, ada.id, { limit: 2, full: true }));
  assert.deepEqual(
    [
      newest.more,
      (newest.versions as PersonaVersion[]).map((v) => [v.version, v.editedBy, v.instructions, v.icon?.kind ?? null]),
    ],
    [
      true,
      [
        [3, ALICE, "Answer in limericks.", "emoji"],
        [2, BOB, "Answer in limericks.", null],
      ],
    ],
  );
  const older = ok(await personas.versions(CAROL, ada.id, { before: 2, limit: 2, full: true }));
  assert.deepEqual(
    [older.more, (older.versions as PersonaVersion[]).map((v) => [v.version, v.instructions])],
    [false, [[1, "Answer in haiku."]]],
  );
  assert.equal((await personas.restore(CAROL, ada.id, 1)).status, "forbidden");
  assert.equal((await personas.restore(BOB, ada.id, 9)).status, "not_found");

  const restored = ok(await personas.restore(BOB, ada.id, 1));
  assert.deepEqual([restored.version, restored.instructions, restored.icon], [4, "Answer in haiku.", undefined]);
  const latest = ok(await personas.versions(ALICE, ada.id, { limit: 1, full: true })).versions[0] as PersonaVersion;
  assert.deepEqual(
    [latest.version, latest.restoredFrom, latest.editedBy, latest.instructions],
    [4, 1, BOB, "Answer in haiku."],
  );
  assert.equal(ok(await personas.detail(CAROL, ada.id)).instructions, "Answer in haiku.");
});

test("the versions API pages who and when, with content on request", async () => {
  const { built, personas, enable } = setup();
  await enable(ALICE);
  const ada = ok(await personas.create(ALICE, { name: "Ada", instructions: "one" }));
  for (const text of ["two", "three"]) ok(await personas.update(ALICE, ada.id, { instructions: text }));
  const server = createInsecureTestServer(built.app, { sessions: built.sessions });
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}/v1/personas/${ada.id}/versions`;
    const get = async (path: string) => {
      const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}principalId=${ALICE}`);
      return [r.status, (await r.json()) as any] as const;
    };
    const [, first] = await get("");
    assert.deepEqual(
      [first.more, first.versions.map((v: { version: number }) => v.version), "instructions" in first.versions[0]],
      [false, [3, 2, 1], false],
    );
    const [, rest] = await get("?before=3&limit=1&full=1");
    assert.deepEqual(
      [rest.more, rest.versions.map((v: { version: number; instructions: string }) => [v.version, v.instructions])],
      [true, [[2, "two"]]],
    );
    assert.equal((await get("?limit=0"))[0], 400);
    assert.equal((await get("?limit=1e30"))[0], 400);
    assert.equal((await get("?limit=1000"))[1].versions.length, 3);
    assert.equal((await get("?before=zero"))[0], 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a destination stored from a persona turn (a cron, watch or loop) does not freeze the persona", () => {
  const destination = { type: "slack", target: "C_ADA:t1", persona: { id: "p-ada", name: "Ada" } } as const;
  const resolved = resolveCapabilityDestination(
    { actorId: ALICE, scopeId: scopeId("channel", "C_ADA"), destination, exp: Date.now() + 60_000 },
    undefined,
  );
  assert.deepEqual(resolved, { ok: true, destination: { type: "slack", target: "C_ADA:t1" } });
});

test("a Slack channel can only be given read access to a persona", async () => {
  const { personas, enable } = setup();
  await enable(ALICE);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  const owner = { scopeId: scopeId("personal", ALICE), role: "owner" as const };
  for (const role of ["write", "owner"] as const)
    assert.equal((await personas.setAccess(ALICE, ada.id, [owner, { scopeId: "channel:C1", role }])).status, "invalid");
  ok(await personas.setAccess(ALICE, ada.id, [owner, { scopeId: "channel:C1", role: "read" }]));
  assert.deepEqual(
    ok(await personas.detail(ALICE, ada.id)).access.map((a) => [a.scopeId, a.role]),
    [
      [scopeId("personal", ALICE), "owner"],
      ["channel:C1", "read"],
    ],
  );
});

test("what a persona conversation posts carries the persona, so Slack can name it", async () => {
  const { built, personas, enable, sysprompt } = setup();
  for (const who of [ALICE, BOB]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada" }));
  let captured: ProvisionOptions | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (owner, opts) => {
    captured = opts;
    return provision(owner, opts);
  };
  const channel = { kind: "channel" as const, channelRef: "C_ADA", threadRef: "channel:C_ADA:t1" };
  const opened = await sysprompt(ALICE, channel);
  const computers = built.sandboxResources.forTurn({
    actorId: ALICE,
    scopeId: opened.scopeId,
    isCurrent: async () => true,
  });
  const computer = await computers.create(ALICE, opened.scopeId, await built.sandboxResources.defaultBackend());
  await computers.setDefault(ALICE, opened.scopeId, computer.id);
  const run = async () => {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: ALICE },
      conversation: channel,
      deliveryTarget: "C_ADA:t1",
      text: "!run true",
    });
    assert.equal(result.status, "ok");
    return (await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET))!;
  };
  assert.equal((await run()).destination?.persona, undefined);

  ok(await personas.assign(ALICE, (await built.sessions.get(opened.sessionId))!, ada.id));
  const claims = await run();
  assert.deepEqual(claims.destination?.persona, { id: ada.id, name: "Ada" });
  await built.app.upsertDirectory([{ principalId: BOB, displayName: "Bob", type: "internal" }]);
  const reached = await built.app.reachNow({
    senderId: ALICE,
    senderScope: claims.scopeId,
    recipient: "Bob",
    text: "Hello from Ada",
    currentDestination: claims.destination!,
  });
  assert.ok(reached.ok, JSON.stringify(reached));
  assert.deepEqual(reached.delivery.destination.persona, { id: ada.id, name: "Ada" });

  captured = undefined;
  const cron = await built.app.createCron({
    ownerScopeId: opened.scopeId,
    owner: ALICE,
    createdBy: ALICE,
    title: "Ada check-in",
    schedule: { everyMs: 3_600_000 },
    action: "!run true",
    sessionRef: channel.threadRef,
    destination: { type: "slack", target: "C_ADA:t1", audienceScopeId: scopeId("channel", "C_ADA") },
  });
  await runNowSettled(built.scheduler, cron.id);
  const firedWith = captured as ProvisionOptions | undefined;
  assert.ok(firedWith, "the cron's turn ran");
  const fired = (await verifyCapabilityToken(firedWith.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET))!;
  assert.ok(fired.memory?.read.includes(scopeId("persona", ada.id)), "the cron's turn wears the persona");
  assert.deepEqual(
    (await built.deliveries.pending("slack"))
      .filter((d) => d.provenance?.trigger === "cron")
      .map((d) => d.destination.persona),
    [{ id: ada.id, name: "Ada" }],
  );
});

test("a persona pinned in a channel is worn by every conversation there until it's unpinned", async () => {
  const { personas, enable, sysprompt } = setup();
  for (const who of [ALICE, CAROL]) await enable(who);
  const ada = ok(await personas.create(ALICE, { name: "Ada", icon: { kind: "emoji", value: "🎨" } }));
  const bea = ok(await personas.create(ALICE, { name: "Bea" }));
  const owner = { scopeId: scopeId("personal", ALICE), role: "owner" as const };
  const channel = { scopeId: "channel:C_PIN", role: "read" as const };
  const thread = (n: number) => ({ kind: "channel" as const, channelRef: "C_PIN", threadRef: `channel:C_PIN:t${n}` });

  assert.equal((await sysprompt(CAROL, thread(1))).reply.includes("## Persona"), false);
  assert.equal(
    (await personas.setAccess(ALICE, ada.id, [{ ...owner, pinned: true }])).status,
    "invalid",
    "only a channel can be pinned",
  );
  ok(await personas.setAccess(ALICE, ada.id, [owner, { ...channel, pinned: true }]));
  assert.equal(
    ok(await personas.detail(ALICE, ada.id)).access.find((a) => a.scopeId === "channel:C_PIN")?.pinned,
    true,
  );

  assert.match((await sysprompt(CAROL, thread(2))).reply, /## Persona: Ada/);

  const second = await personas.setAccess(ALICE, bea.id, [owner, { ...channel, pinned: true }]);
  assert.equal(second.status, "invalid");
  assert.match((second as { message: string }).message, /already has another persona pinned/);
  ok(await personas.setAccess(ALICE, bea.id, [owner, channel]));

  ok(await personas.setAccess(ALICE, ada.id, [owner, channel]));
  assert.equal((await sysprompt(CAROL, thread(3))).reply.includes("## Persona"), false, "unpinned");
  ok(await personas.setAccess(ALICE, bea.id, [owner, { ...channel, pinned: true }]));
  assert.match((await sysprompt(CAROL, thread(4))).reply, /## Persona: Bea/);

  ok(await personas.setAccess(ALICE, ada.id, [owner, { scopeId: "group:G_PIN", role: "read", pinned: true }]));
  const group = { kind: "group" as const, channelRef: "G_PIN", threadRef: "grp:G_PIN:t1" };
  assert.match((await sysprompt(CAROL, group)).reply, /## Persona: Ada/);
});
