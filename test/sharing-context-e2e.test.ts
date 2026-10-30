import { randomUUID } from "node:crypto";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import type { Config } from "../src/config.ts";
import type { TurnRequest } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";

// Full application/tool/materializer path, with deterministic model commands and
// the repo's host-backed Sprites transport. This does not test VM isolation.
async function fixture(t: TestContext, config: Partial<Config> = {}) {
  const built = buildApp(testConfig({ memoryCapture: "off", ...config }));
  await built.config.hydrate?.();
  await built.identity.hydrate();
  await built.deploymentLayerReady;
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  let members = ["U1", "U2", "U3"];
  const roster = async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C1", name: "engineering", isPrivate: true }],
      members.map((principalId) => ({ channelId: "C1", principalId })),
    );
  };
  await roster();
  for (const [actor, scope] of [
    ["U1", "personal:U1"],
    ["U2", "personal:U2"],
    ["U3", "personal:U3"],
    ["U1", "channel:C1"],
  ] as const) {
    const computer = await built.sandboxResources.create(actor, scope, "sprites", "default");
    await built.sandboxResources.setDefault(actor, scope, computer.id);
  }
  await built.config.setSharingPosture("org:default-org", "open");
  const turn = async (text: string, room = false, actor = "U1", extra: Partial<TurnRequest> = {}) => {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: actor },
      origin: { kind: "human" },
      conversation: room
        ? {
            kind: "channel",
            channelRef: "C1",
            threadRef: "C1:shared-test",
            audience: members.map((externalId) => ({ externalId })),
            publishMembers: members.map((externalId) => ({ externalId })),
          }
        : { kind: "dm", threadRef: `dm:${actor}:shared-test` },
      text,
      ...extra,
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.reply ?? "";
  };
  const skill = async (scopeId: string, name: string, value: string) => {
    const s = await built.skills.create({
      scopeId,
      createdBy: "U1",
      manifest: {
        name,
        description: `${name} arithmetic helper`,
        body: `Read scripts/value.py and run python3 skills/${name}/scripts/value.py.`,
        requiredCapabilities: [],
        files: [{ path: "scripts/value.py", content: `print(${JSON.stringify(value)})\n` }],
      },
    });
    await built.skills.review(s.id, "U1", []);
    return built.skills.publish(s.id);
  };
  const remove = async (id: string) => {
    members = members.filter((m) => m !== id);
    await roster();
  };
  const fileIds = new Map<string, string>();
  const file = async (ownerScopeId: string, name: string, data: string | Buffer) => {
    for (const existing of (await built.files.listOwnedByScopes([ownerScopeId])).files) {
      if (existing.name === name) await built.files.setEnabled(existing.id, false);
    }
    const id = randomUUID();
    fileIds.set(`${ownerScopeId}/${name}`, id);
    await built.files.put({
      id,
      ownerScopeId,
      createdBy: ownerScopeId === "channel:C1" ? "U1" : ownerScopeId.slice("personal:".length),
      name,
      path: name,
      mimetype: "application/octet-stream",
      data: Buffer.from(data),
      direction: "out",
    });
  };
  const filePath = (ownerScopeId: string, name: string) =>
    `shared/open-${ownerScopeId.replace(":", "-")}/${fileIds.get(`${ownerScopeId}/${name}`)}/${name}`;
  return { ...built, turn, skill, remove, file, filePath };
}

test("sharing e2e: personal files and memories follow the speaker, opt-out, and automation boundaries", async (t) => {
  const b = await fixture(t);
  for (const [id, marker] of [
    ["U1", "ALICE_PAYLOAD"],
    ["U2", "BOB_PAYLOAD"],
  ]) {
    await b.file(`personal:${id}`, "notes.txt", marker!);
    await b.memory.capture(`personal:${id}`, [`OWN_MEMORY_${id}`], Date.now(), id!);
  }
  assert.equal(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true), "ALICE_PAYLOAD");
  assert.doesNotMatch(await b.turn("!memorysearch OWN_MEMORY", true), /OWN_MEMORY_U1/);
  assert.doesNotMatch(await b.turn("!sysprompt", true), /OWN_MEMORY_U2|open-personal-U2/);
  assert.match(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true, "U2"), /no file/);
  assert.equal(await b.turn(`!read ${b.filePath("personal:U2", "notes.txt")}`, true, "U2"), "BOB_PAYLOAD");
  assert.equal(
    await b.turn(`!read ${b.filePath("personal:U2", "notes.txt")}`, true, "U2", {
      origin: { kind: "ambient", live: true },
    }),
    "BOB_PAYLOAD",
  );
  await b.config.setSharingPosture("personal:U1", "isolated");
  await b.file("personal:U1", "notes.txt", "NEW_PRIVATE_PAYLOAD");
  assert.match(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true), /no file/);
  assert.doesNotMatch(await b.turn("!memorysearch OWN_MEMORY", true), /OWN_MEMORY_U1/);
  await b.config.clearSharingPosture("personal:U1");
  assert.equal(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true), "NEW_PRIVATE_PAYLOAD");
  assert.match(
    await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true, "U1", { origin: { kind: "automation" } }),
    /no file/,
  );
});

test("sharing e2e: a delegated turn shares its live parent's access under current sharing permission", async (t) => {
  const b = await fixture(t, { apiBaseUrl: "https://core.example.com", signingSecret: "test-ingress-secret" });
  await b.file("personal:U1", "notes.txt", "DELEGATED_PERSONAL_FILE");
  await b.turn("inspect my personal notes", true);
  const parent = await b.runs.latestForThread("C1:shared-test");
  assert.ok(parent);
  const parentSession = await b.sessions.getByThread(parent.sessionId);
  assert.ok(parentSession);
  const child = await b.sessions.getOrCreateByThread(
    "agent:main:subagent:sharing-gate",
    "channel",
    parentSession.scopeId,
  );
  await b.sessions.setParentSession(child.id, parentSession.id);
  await b.sessions.setSpawnMeta(child.id, {
    actor: parent.request.actor,
    conversation: parent.request.conversation,
    surface: parent.request.surface ?? "test",
  });
  for (const person of parent.request.conversation.audience) await b.sessions.addParticipant(child.id, person.id);
  let token: string | undefined;
  const provision = b.sandbox.provision.bind(b.sandbox);
  b.sandbox.provision = async (layers, opts) => {
    token = opts?.env?.AGENT_API_TOKEN;
    return provision(layers, opts);
  };
  b.runtime.startBackground();
  const childTurn = async (text: string, expectedStatus: "ok" | "refused" = "ok") => {
    const { run } = await b.runs.enqueue({
      sessionId: child.threadRef,
      request: {
        ...parent.request,
        conversation: { ...parent.request.conversation, threadRef: child.threadRef },
        origin: parent.request.origin,
        delegatingRunId: parent.id,
        sessionSenderId: parentSession.id,
        text,
      },
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const current = await b.runs.get(run.id);
      assert.ok(current);
      if (current.status === "done" || current.status === "failed") {
        assert.equal(current.result?.status, expectedStatus, JSON.stringify(current));
        return current.result.reply ?? current.result.reason ?? "";
      }
      assert.ok(Date.now() < deadline, "delegated turn did not finish");
      await sleep(25);
    }
  };
  const read = `!read ${b.filePath("personal:U1", "notes.txt")}`;
  assert.equal(await childTurn(read), "DELEGATED_PERSONAL_FILE");
  assert.equal(await childTurn("!run echo delegated"), "delegated");
  assert.ok(token);
  const delegatedClaims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.equal(delegatedClaims?.liveAuthor, true);
  assert.equal(delegatedClaims?.liveActor, true);
  assert.equal(delegatedClaims?.triggered, undefined);
  const credential = await b.keychain!.save({
    ownerId: "U1",
    service: "delegated-test",
    secret: "fixture-secret",
    envKey: "DELEGATED_TEST_TOKEN",
  });
  assert.equal(
    await childTurn(
      `!execute ${JSON.stringify({
        command: 'test -n "$DELEGATED_TEST_TOKEN" && printf available',
        credentials: [credentialHandle(credential)],
      })}`,
    ),
    "available",
  );
  assert.deepEqual(await b.keychain!.grantsForScope("channel:C1"), []);
  await b.config.setSharingPosture("personal:U1", "isolated");
  assert.match(await childTurn(read), /no file/);
  await b.config.clearSharingPosture("personal:U1");
  await b.remove("U1");
  assert.match(await childTurn(read, "refused"), /access is no longer current/);
});

test("sharing e2e: room file and memory access is revoked on the next DM turn", async (t) => {
  const b = await fixture(t);
  await b.file("channel:C1", "plan.txt", "ROOM_FILE");
  await b.memory.capture("channel:C1", ["ROOM_MEMORY"], Date.now(), "U1");
  await b.turn("hello", true);
  assert.equal(await b.turn(`!read ${b.filePath("channel:C1", "plan.txt")}`), "ROOM_FILE");
  assert.match(await b.turn("!memorysearch ROOM_MEMORY"), /ROOM_MEMORY/);
  await b.config.setSharingPosture("channel:C1", "isolated");
  assert.match(await b.turn(`!read ${b.filePath("channel:C1", "plan.txt")}`), /no file/);
  assert.doesNotMatch(await b.turn("!memorysearch ROOM_MEMORY"), /ROOM_MEMORY/);
  await b.config.clearSharingPosture("channel:C1");
  assert.equal(await b.turn(`!read ${b.filePath("channel:C1", "plan.txt")}`), "ROOM_FILE");
  await b.remove("U1");
  assert.match(await b.turn(`!read ${b.filePath("channel:C1", "plan.txt")}`), /no file/);
  assert.doesNotMatch(await b.turn("!memorysearch ROOM_MEMORY"), /ROOM_MEMORY/);
  assert.doesNotMatch(await b.turn("!sysprompt"), /ROOM_MEMORY|open-channel-C1/);
});

test("sharing e2e: skill lazy assets execute, update, and disappear from the same computer after opt-out", async (t) => {
  const b = await fixture(t);
  const s = await b.skill("personal:U1", "carried-helper", "VERSION_ONE");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /carried-helper/);
  assert.equal(await b.turn("!skill-run carried-helper python3 {dir}/scripts/value.py", true), "VERSION_ONE");
  await b.skills.update(s.id, {
    ...s.manifest,
    files: [{ path: "scripts/value.py", content: "print('VERSION_TWO')\n" }],
  });
  await b.skills.review(s.id, "U1", []);
  await b.skills.publish(s.id);
  await assert.equal(await b.turn("!skill-run carried-helper python3 {dir}/scripts/value.py", true), "VERSION_TWO");
  await b.config.setSharingPosture("personal:U1", "isolated");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /carried-helper/);
  assert.match(await b.turn("!skill carried-helper", true), /no skill file/);
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\"", true), "0");
  await b.config.clearSharingPosture("personal:U1");
  await assert.equal(await b.turn("!skill-run carried-helper python3 {dir}/scripts/value.py", true), "VERSION_TWO");
  await b.skills.archive(s.id);
  assert.match(await b.turn("!skill carried-helper", true), /no skill file/);
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\"", true), "0");
});

test("sharing e2e: room skills are removed from an existing DM computer after membership revocation", async (t) => {
  const b = await fixture(t);
  await b.skill("channel:C1", "room-helper", "ROOM_HELPER");
  await b.turn("hello", true);
  await assert.equal(await b.turn("!skill-run room-helper python3 {dir}/scripts/value.py"), "ROOM_HELPER");
  assert.doesNotMatch(await b.turn("!sysprompt", false, "U4"), /room-helper/);
  await b.remove("U1");
  assert.match(await b.turn("!skill room-helper"), /no skill file/);
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\""), "0");
});

test("sharing e2e: Isolated preserves local skills and explicit grants without implicit carry", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "personal-helper", "PERSONAL");
  const s = await b.skill("personal:U2", "explicit-helper", "EXPLICIT");
  await b.config.setSharingPosture("org:default-org", "isolated");
  await b.acl.grant(
    {
      ownerScopeId: "personal:U2",
      ref: `skill:${s.id}`,
      granteeScopeId: "personal:U1",
      permission: "read",
      grantedBy: "U2",
    },
    "U2",
  );
  assert.match(await b.turn("!sysprompt"), /personal-helper/);
  await assert.equal(await b.turn("!skill-run explicit-helper python3 {dir}/scripts/value.py"), "EXPLICIT");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /personal-helper|explicit-helper/);
  await b.acl.revoke("personal:U2", `skill:${s.id}`, "personal:U1", "U2", "U2");
  assert.match(await b.turn("!skill explicit-helper"), /no skill file/);
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\""), "0");
});

test("sharing e2e: local skill name wins, then exposes the carried fallback when archived", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "duplicate-helper", "CARRIED");
  const local = await b.skill("channel:C1", "duplicate-helper", "LOCAL");
  await assert.equal(await b.turn("!skill-run duplicate-helper python3 {dir}/scripts/value.py", true), "LOCAL");
  await b.skills.archive(local.id);
  await assert.equal(await b.turn("!skill-run duplicate-helper python3 {dir}/scripts/value.py", true), "CARRIED");
});

test("sharing e2e: writes and memory capture remain local while reading carried context", async (t) => {
  const b = await fixture(t, { memoryCapture: "writable" });
  await b.file("personal:U1", "notes.txt", "SOURCE_UNCHANGED");
  await b.memory.capture("personal:U1", ["PERSONAL_SOURCE_MEMORY"], Date.now(), "U1");
  assert.equal(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true), "SOURCE_UNCHANGED");
  assert.match(await b.turn("!write notes.txt ROOM_WRITE", true), /wrote/);
  assert.match(await b.turn("!memoryremember ROOM_CAPTURE_ONLY", true), /remembered 1/);
  assert.equal(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true), "SOURCE_UNCHANGED");
  assert.equal(await b.workspace.read("channel:C1", "notes.txt"), "ROOM_WRITE");
  assert.match(await b.memory.read("channel:C1"), /ROOM_CAPTURE_ONLY/);
  assert.doesNotMatch(await b.memory.read("personal:U1"), /ROOM_CAPTURE_ONLY/);
  assert.match(await b.turn("!memoryremember PERSONAL_CAPTURE_ONLY"), /remembered 1/);
  assert.match(await b.memory.read("personal:U1"), /PERSONAL_CAPTURE_ONLY/);
  assert.doesNotMatch(await b.memory.read("channel:C1"), /PERSONAL_CAPTURE_ONLY/);
});

test("sharing e2e: binary carry never materializes bytes and text artifacts use the artifact store", async (t) => {
  const b = await fixture(t);
  const id = "a".repeat(32);
  const path = `artifacts/${id}/report.txt`;
  await b.files.put({
    id,
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    name: "report.txt",
    path,
    mimetype: "text/plain",
    data: Buffer.from("CURRENT_ARTIFACT"),
    direction: "out",
  });
  await b.workspace.write("personal:U1", path, "STALE_WORKSPACE_SNAPSHOT");
  assert.equal(await b.turn(`!read shared/open-personal-U1/${id}/report.txt`, true), "CURRENT_ARTIFACT");
  await b.file("personal:U1", "binary.dat", Buffer.from([0xff, 0xfe, 0, 1]));
  assert.match(
    await b.turn(`!read ${b.filePath("personal:U1", "binary.dat")}`, true),
    /binary file binary.dat, Files ID .+; send it by ID/,
  );
  assert.equal(
    await b.turn(
      `!run python3 -c "import os; print(os.path.exists('${b.filePath("personal:U1", "binary.dat")}'))"`,
      true,
    ),
    "False",
  );
  await b.config.setSharingPosture("personal:U1", "isolated");
  assert.match(await b.turn(`!read shared/open-personal-U1/${id}/report.txt`, true), /no file/);
});

test("sharing e2e: explicit text-file grants survive Isolated and revoke without stale reads", async (t) => {
  const b = await fixture(t);
  await b.files.put({
    id: "shared-note",
    ownerScopeId: "personal:U2",
    createdBy: "U2",
    name: "shared-note.txt",
    path: "shared-note.txt",
    mimetype: "text/plain",
    data: Buffer.from("EXPLICIT_TEXT"),
    direction: "out",
  });
  await b.acl.grant(
    {
      ownerScopeId: "personal:U2",
      ref: "shared-note",
      granteeScopeId: "personal:U1",
      permission: "read",
      grantedBy: "U2",
    },
    "U2",
  );
  await b.config.setSharingPosture("org:default-org", "isolated");
  assert.equal(await b.turn("!read shared/shared-note.txt"), "EXPLICIT_TEXT");
  assert.match(await b.turn("!read shared/shared-note.txt", true), /no file/);
  await b.acl.revoke("personal:U2", "shared-note", "personal:U1", "U2", "U2");
  assert.match(await b.turn("!read shared/shared-note.txt"), /no file/);
});

test("sharing e2e: unavailable connector skills cannot be read or executed", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "google-workspace", "UNCONFIGURED_CONNECTOR");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /^- google-workspace — /m);
  assert.match(await b.turn("!skill google-workspace", true), /no skill file/);
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\"", true), "0");
});

for (const memoryRecall of ["off", "writable"] as const) {
  test(`sharing e2e: memory ${memoryRecall} does not disable carried files or skills`, async (t) => {
    const b = await fixture(t, { memoryRecall });
    await b.file("personal:U1", "notes.txt", "FILE_WITH_MEMORY_RESTRICTED");
    await b.memory.capture("personal:U1", ["NO_CARRIED_MEMORY"], Date.now(), "U1");
    await b.skill("personal:U1", "independent-helper", "SKILL_WITH_MEMORY_RESTRICTED");
    assert.doesNotMatch(await b.turn("!sysprompt", true), /NO_CARRIED_MEMORY/);
    assert.doesNotMatch(await b.turn("!memorysearch NO_CARRIED_MEMORY", true), /NO_CARRIED_MEMORY/);
    assert.equal(await b.turn(`!read ${b.filePath("personal:U1", "notes.txt")}`, true), "FILE_WITH_MEMORY_RESTRICTED");
    assert.equal(
      await b.turn("!skill-run independent-helper python3 {dir}/scripts/value.py", true),
      "SKILL_WITH_MEMORY_RESTRICTED",
    );
  });
}

test("sharing e2e: switching the speaker removes the previous speaker's skill before execute", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "speaker-helper", "SPEAKER_ONE");
  await assert.equal(await b.turn("!skill-run speaker-helper python3 {dir}/scripts/value.py", true), "SPEAKER_ONE");
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\"", true, "U2"), "0");
  await assert.equal(await b.turn("!skill-run speaker-helper python3 {dir}/scripts/value.py", true), "SPEAKER_ONE");
});

test("sharing e2e: a newly blocked skill asset removes previously materialized content", async (t) => {
  const b = await fixture(t);
  const s = await b.skill("personal:U1", "screened-helper", "OLD_SAFE_ASSET");
  await assert.equal(await b.turn("!skill-run screened-helper python3 {dir}/scripts/value.py", true), "OLD_SAFE_ASSET");
  await b.skills.update(s.id, {
    ...s.manifest,
    files: [{ path: "scripts/value.py", content: "# !security-risk\nprint('UNSCREENED_NEW_ASSET')\n" }],
  });
  await b.skills.review(s.id, "U1", []);
  await b.skills.publish(s.id);
  assert.equal(await b.turn("!run sh -c \"find . -name value.py | wc -l | tr -d ' '\"", true), "0");
  assert.match(await b.turn("!skill screened-helper", true), /no skill file/);
  assert.ok((await b.auditLog.events()).some((e) => e.action === "sharing.skill_screen_blocked"));
});

test("sharing e2e: the execution capability excludes carried memories in both directions", async (t) => {
  const b = await fixture(t, { apiBaseUrl: "https://core.example.com", signingSecret: "test-ingress-secret" });
  let token: string | undefined;
  const provision = b.sandbox.provision.bind(b.sandbox);
  b.sandbox.provision = async (layers, opts) => {
    token = opts?.env?.AGENT_API_TOKEN;
    return provision(layers, opts);
  };
  assert.equal(await b.turn("!run echo ROOM", true), "ROOM");
  assert.ok(token);
  const roomClaims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.ok(roomClaims?.memory);
  assert.ok(roomClaims.memory.read.includes("channel:C1"));
  assert.equal(roomClaims.memory.read.includes("personal:U1"), false);
  assert.equal(await b.turn("!run echo DM"), "DM");
  assert.ok(token);
  const dmClaims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.ok(dmClaims?.memory);
  assert.ok(dmClaims.memory.read.includes("personal:U1"));
  assert.equal(dmClaims.memory.read.includes("channel:C1"), false);
});

test("sharing e2e: local notebooks retain late facts while unclassified carried memory stays private", async (t) => {
  const b = await fixture(t);
  await b.memory.capture(
    "personal:U1",
    Array.from({ length: 120 }, (_, i) => `PERSONAL_FACT_${i} ${"context ".repeat(12)}`),
    Date.now(),
    "U1",
  );
  await b.memory.capture("channel:C1", ["ROOM_FACT_END"], Date.now(), "U1");
  const p = await b.turn("!sysprompt", true);
  assert.doesNotMatch(p, /PERSONAL_FACT_119/);
  assert.match(p, /### #engineering[\s\S]*ROOM_FACT_END/);
  assert.match(await b.turn("!sysprompt"), /PERSONAL_FACT_119/);
  assert.doesNotMatch(await b.turn("!memorysearch PERSONAL_FACT_119", true), /PERSONAL_FACT_119/);
});

test("sharing e2e: screening off preserves carried skills without model calls", async (t) => {
  const b = await fixture(t, { securityScreen: "off" });
  await b.skill("personal:U1", "unscreened-helper", "SHARED_SKILL_OK");
  await assert.equal(
    await b.turn("!skill-run unscreened-helper python3 {dir}/scripts/value.py", true),
    "SHARED_SKILL_OK",
  );
  assert.equal(b.modelGateway.audit().filter((rec) => rec.model === "mock-security").length, 0);
});

test("Open speaker keychain uses a disposable computer, follows the speaker, and never grants the room", async (t) => {
  const b = await fixture(t, {
    signingSecret: "open-keychain-test-signing-key",
    apiBaseUrl: "http://core.test",
    maxAttempts: 1,
  });
  assert.ok(b.keychain);
  const handles = new Map<string, string[]>();
  for (const id of ["U1", "U2"]) {
    const credential = await b.keychain.save({ ownerId: id, service: "npm", secret: `npm_${id}`, envKey: "NPM_TOKEN" });
    const login = await b.keychain.save({
      ownerId: id,
      service: "custom-cli",
      files: [{ path: ".custom-cli/auth", contentBase64: Buffer.from(`file_${id}`).toString("base64") }],
    });
    handles.set(id, [credentialHandle(credential), credentialHandle(login)]);
    await b.keychain.setConnectorToken("gmail.googleapis.com", id, {
      accessToken: `gmail_${id}`,
      expiresAt: Date.now() + 3600000,
    });
  }
  const prompt = await b.turn("!sysprompt", true);
  assert.match(prompt, /### U1\n(?:(?!###)[\s\S])*`npm:/);
  assert.doesNotMatch(prompt, /### U2\n/);
  assert.ok(!prompt.includes("npm_U1"));
  await b.workspace.write("channel:C1", "room-only.txt", "room_data");
  const probe = `python3 -c 'import os,pathlib; p=pathlib.Path.home()/".custom-cli/auth"; print("|".join([os.getenv("NPM_TOKEN","unset"),os.getenv("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM","unset"),p.read_text() if p.exists() else "absent",str(bool(os.getenv("AGENT_API_TOKEN"))),"room" if pathlib.Path("room-only.txt").exists() else "isolated"]))'`;
  const selected = (id = "U1") =>
    `!execute ${JSON.stringify({ command: probe.replace('os.getenv("NPM_TOKEN","unset")', `str(os.getenv("NPM_TOKEN") == "npm_${id}")`).replace('os.getenv("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM","unset")', `str(os.getenv("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM") == "gmail_${id}")`), credentials: [...handles.get(id)!, "connector:gmail.googleapis.com:default"] })}`;
  assert.equal(await b.turn(selected(), true), "True|True|file_U1|True|isolated");
  assert.equal(await b.turn(selected("U2"), true, "U2"), "True|True|file_U2|True|isolated");
  for (const id of ["U1", "U2", "U1"]) {
    assert.equal(
      await b.turn(selected(id), true, id, { origin: { kind: "ambient", live: true } }),
      `True|True|file_${id}|True|isolated`,
    );
  }
  const ambientPrompt = await b.turn("!sysprompt", true, "U2", { origin: { kind: "ambient", live: true } });
  assert.match(ambientPrompt, /### U2\n(?:(?!###)[\s\S])*`npm:/);
  assert.doesNotMatch(ambientPrompt, /### U1\n/);
  assert.match(await b.turn(`!run ${probe}`, true, "U2"), /^unset\|unset\|absent\|/);
  await b.directory.replaceGroups([
    { groupId: "G1", principalId: "U1" },
    { groupId: "G1", principalId: "U2" },
  ]);
  for (const origin of [{ kind: "human" }, { kind: "ambient", live: true }] as const) {
    assert.equal(
      await b.turn(selected(), true, "U1", {
        origin,
        conversation: {
          kind: "group",
          channelRef: "G1",
          threadRef: "G1:open-keychain",
          audience: [{ externalId: "U1" }, { externalId: "U2" }],
          publishMembers: [{ externalId: "U1" }, { externalId: "U2" }],
        },
      }),
      "True|True|file_U1|True|isolated",
    );
  }
  assert.deepEqual(await b.keychain.grantsForScope("group:G1"), []);
  assert.deepEqual(await b.keychain.grantsForScope("channel:C1"), []);
  assert.ok((await b.auditLog.events()).some((event) => event.action === "keychain.open_speaker_use"));
  const onScratch = (command: string) =>
    `!execute ${JSON.stringify({ command, credentials: [handles.get("U1")![0]] })}`;
  assert.equal(await b.turn(onScratch(`python3 -c 'open("retained.txt","w").write("private")'`), true), "(exit 0)");
  assert.equal(
    await b.turn(
      onScratch(`python3 -c 'import os; print("leaked" if os.path.exists("retained.txt") else "clean")'`),
      true,
    ),
    "clean",
  );
  let deniedTurn = 0;
  const denied = (origin: TurnRequest["origin"] = { kind: "human" }) =>
    b.turn(onScratch("true"), true, "U1", {
      origin,
      conversation: {
        kind: "channel",
        channelRef: "C1",
        threadRef: `C1:keychain-denied-${++deniedTurn}`,
        audience: [{ externalId: "U1" }, { externalId: "U2" }],
        publishMembers: [{ externalId: "U1" }, { externalId: "U2" }],
      },
    });
  await b.config.setSharingPosture("personal:U1", "isolated");
  await assert.rejects(denied(), /credential handle is not available on this turn/);
  await assert.rejects(denied({ kind: "ambient", live: true }), /credential handle is not available on this turn/);
  await b.config.setSharingPosture("personal:U1", "open");
  await b.config.setSharingPosture("channel:C1", "isolated");
  await assert.rejects(denied(), /credential handle is not available on this turn/);
  await assert.rejects(denied({ kind: "ambient", live: true }), /credential handle is not available on this turn/);
  await b.config.setSharingPosture("channel:C1", "open");
  await b.config.setSharingPosture("org:default-org", "isolated");
  await assert.rejects(denied(), /credential handle is not available on this turn/);
  await assert.rejects(denied({ kind: "ambient", live: true }), /credential handle is not available on this turn/);
  await b.config.setSharingPosture("org:default-org", "open");
  await assert.rejects(denied({ kind: "automation" }), /credential handle is not available on this turn/);
  await assert.rejects(denied({ kind: "ambient" }), /credential handle is not available on this turn/);
  await assert.rejects(denied({ kind: "ambient", live: false }), /credential handle is not available on this turn/);
  const firstTurn = (channelRef: string, origin: TurnRequest["origin"] = { kind: "human" }) =>
    b.turn(selected(), true, "U1", {
      origin,
      conversation: {
        kind: "channel",
        channelRef,
        threadRef: `${channelRef}:first-turn-${++deniedTurn}`,
        audience: [{ externalId: "U1" }, { externalId: "U2" }],
        publishMembers: [{ externalId: "U1" }, { externalId: "U2" }],
      },
    });
  assert.equal(await firstTurn("C-unsynced"), "True|True|file_U1|True|isolated");
  assert.equal(await firstTurn("C-unsynced", { kind: "ambient", live: true }), "True|True|file_U1|True|isolated");
  await b.remove("U1");
  const removed = (origin: TurnRequest["origin"] = { kind: "human" }) =>
    b.turn(onScratch("true"), true, "U1", {
      origin,
      conversation: {
        kind: "channel",
        channelRef: "C1",
        threadRef: `C1:keychain-denied-${++deniedTurn}`,
        audience: [{ externalId: "U1" }, { externalId: "slack-external", isExternalGuest: true }],
      },
    });
  await assert.rejects(removed(), /non-internal participant/);
  await assert.rejects(removed({ kind: "ambient", live: true }), /non-internal participant/);
});

test("shared conversations run named credentials on the turn's scratch computer and never stage them on the room computer", async (t) => {
  const b = await fixture(t, {
    signingSecret: "scratch-routing-test-signing-key",
    apiBaseUrl: "http://core.test",
    maxAttempts: 1,
  });
  assert.ok(b.keychain);
  await b.config.setSharingPosture("org:default-org", "isolated");
  const granted = await b.keychain.save({
    ownerId: "U2",
    service: "npm",
    secret: "npm_granted_U2",
    envKey: "NPM_TOKEN",
  });
  const login = await b.keychain.save({
    ownerId: "U2",
    service: "custom-cli",
    files: [{ path: ".custom-cli/auth", contentBase64: Buffer.from("file_granted_U2").toString("base64") }],
  });
  for (const credential of [granted, login])
    await b.keychain.createGrant({
      credentialId: credential.id,
      ownerId: "U2",
      audienceScopeId: "channel:C1",
      mode: "standing",
      purpose: "room work",
    });
  for (const [slug, delivery] of [
    ["org-env", "env"],
    ["org-broker", "broker"],
  ] as const) {
    await b.serviceCreds.setServiceCredential("org:default-org", {
      slug,
      name: slug,
      delivery,
      ...(delivery === "env" ? { envKey: "ORG_ENV_TOKEN" } : {}),
      secret: `secret_${slug}`,
      host: delivery === "env" ? "" : "api.example.test",
    });
    await b.acl.grant({
      ownerScopeId: "org:default-org",
      ref: encodeRef(serviceCredRef(slug)),
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "U1",
    });
  }
  const scratchBoxes = new Set<string>();
  const provisions: string[] = [];
  const provision = b.sandbox.provision.bind(b.sandbox);
  b.sandbox.provision = async (layers, opts) => {
    const handle = await provision(layers, opts);
    provisions.push(opts?.scratch?.key ?? "scoped");
    if (opts?.scratch) scratchBoxes.add(handle.id);
    return handle;
  };
  const secrets = ["npm_granted_U2", "file_granted_U2", "secret_org-env"];
  const exposed: string[] = [];
  const carried: string[] = [];
  const run = b.sandbox.run.bind(b.sandbox);
  b.sandbox.run = async (handle, command, opts) => {
    const env = JSON.stringify(handle.env ?? {});
    if (secrets.some((secret) => env.includes(secret)))
      (scratchBoxes.has(handle.id) ? carried : exposed).push(handle.id);
    return run(handle, command, opts);
  };
  const writeFileBytes = b.sandbox.writeFileBytes.bind(b.sandbox);
  b.sandbox.writeFileBytes = async (handle, path, bytes) => {
    if (secrets.some((secret) => Buffer.from(bytes).toString().includes(secret)))
      (scratchBoxes.has(handle.id) ? carried : exposed).push(handle.id);
    return writeFileBytes(handle, path, bytes);
  };
  assert.equal(await b.turn(`!run python3 -c 'open("room-only.txt","w").write("room")'`, true), "(exit 0)");
  const probe = `python3 -c 'import os,pathlib; p=pathlib.Path.home()/".custom-cli/auth"; print("|".join([str(os.getenv("NPM_TOKEN") == "npm_granted_U2"), p.read_text() if p.exists() else "absent", str(os.getenv("ORG_ENV_TOKEN") == "secret_org-env"), str(bool(os.getenv("AGENT_API_TOKEN"))), "room" if pathlib.Path("room-only.txt").exists() else "isolated"]))'`;
  const handles = [credentialHandle(granted), credentialHandle(login), "org-env"];
  const execute = (params: Record<string, unknown>, room = true, actor = "U1") =>
    b.turn(`!execute ${JSON.stringify(params)}`, room, actor);
  assert.equal(await execute({ command: probe, credentials: handles }), "True|file_granted_U2|True|True|isolated");
  const roomComputer = await b.sandboxResources.resolve("channel:C1");
  assert.equal(
    await execute({ command: probe, credentials: handles, sandboxId: roomComputer!.id }),
    "True|file_granted_U2|True|True|isolated",
  );
  assert.equal(
    await execute({
      command: `python3 -c 'import os; print(os.getenv("NPM_TOKEN") == "npm_granted_U2", bool(os.getenv("AGENT_CREDENTIAL_TOKEN")), os.getenv("AGENT_API_URL"))'`,
      credentials: [credentialHandle(granted), "org-broker"],
    }),
    "True True http://core.test",
  );
  assert.equal(
    await execute({
      command: `python3 -c 'import os,pathlib; print(bool(os.getenv("AGENT_CREDENTIAL_TOKEN")), pathlib.Path("room-only.txt").exists())'`,
      credentials: ["org-broker"],
    }),
    "True True",
  );
  assert.deepEqual(exposed, []);
  assert.ok(carried.length > 0);
  const own = await b.keychain.save({ ownerId: "U1", service: "dm-cli", secret: "dm_own_U1", envKey: "DM_TOKEN" });
  assert.equal(await b.turn(`!run python3 -c 'open("dm-only.txt","w").write("dm")'`), "(exit 0)");
  const before = provisions.length;
  assert.equal(
    await execute(
      {
        command: `python3 -c 'import os,pathlib; print(os.getenv("DM_TOKEN") == "dm_own_U1", pathlib.Path("dm-only.txt").exists())'`,
        credentials: [credentialHandle(own)],
      },
      false,
    ),
    "True True",
  );
  assert.ok(provisions.slice(before).every((key) => !key.startsWith("turn:")));
  await b.environments.attach("channel:C1", "personal:U1", "U1");
  const attached = provisions.length;
  assert.equal(
    await execute(
      {
        command: `python3 -c 'import os,pathlib; print(os.getenv("DM_TOKEN") == "dm_own_U1", pathlib.Path("dm-only.txt").exists())'`,
        credentials: [credentialHandle(own)],
      },
      false,
    ),
    "True False",
  );
  assert.ok(provisions.slice(attached).some((key) => key.startsWith("turn:")));
});
