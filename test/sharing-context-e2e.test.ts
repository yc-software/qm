import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import type { Config } from "../src/config.ts";
import type { TurnRequest } from "../src/types.ts";

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
  return { ...built, turn, skill, remove };
}

test("sharing e2e: personal files and memories follow the speaker, opt-out, and automation boundaries", async (t) => {
  const b = await fixture(t);
  for (const [id, marker] of [
    ["U1", "ALICE_PAYLOAD"],
    ["U2", "BOB_PAYLOAD"],
  ]) {
    await b.workspace.write(`personal:${id}`, "notes.txt", marker!);
    await b.memory.capture(`personal:${id}`, [`OWN_MEMORY_${id}`], Date.now(), id!);
  }
  assert.equal(await b.turn("!read shared/open-personal-U1/notes.txt", true), "ALICE_PAYLOAD");
  assert.match(await b.turn("!memorysearch OWN_MEMORY", true), /OWN_MEMORY_U1/);
  assert.doesNotMatch(await b.turn("!sysprompt", true), /OWN_MEMORY_U2|open-personal-U2/);
  assert.match(await b.turn("!read shared/open-personal-U1/notes.txt", true, "U2"), /no file/);
  assert.equal(await b.turn("!read shared/open-personal-U2/notes.txt", true, "U2"), "BOB_PAYLOAD");
  await b.config.setSharingPosture("personal:U1", "isolated");
  await b.workspace.write("personal:U1", "notes.txt", "NEW_PRIVATE_PAYLOAD");
  assert.match(await b.turn("!read shared/open-personal-U1/notes.txt", true), /no file/);
  assert.doesNotMatch(await b.turn("!memorysearch OWN_MEMORY", true), /OWN_MEMORY_U1/);
  await b.config.clearSharingPosture("personal:U1");
  assert.equal(await b.turn("!read shared/open-personal-U1/notes.txt", true), "NEW_PRIVATE_PAYLOAD");
  assert.match(
    await b.turn("!read shared/open-personal-U1/notes.txt", true, "U1", { origin: { kind: "automation" } }),
    /no file/,
  );
});

test("sharing e2e: room file and memory access is revoked on the next DM turn", async (t) => {
  const b = await fixture(t);
  await b.workspace.write("channel:C1", "plan.txt", "ROOM_FILE");
  await b.memory.capture("channel:C1", ["ROOM_MEMORY"], Date.now(), "U1");
  await b.turn("hello", true);
  assert.equal(await b.turn("!read shared/open-channel-C1/plan.txt"), "ROOM_FILE");
  assert.match(await b.turn("!memorysearch ROOM_MEMORY"), /ROOM_MEMORY/);
  await b.config.setSharingPosture("channel:C1", "isolated");
  assert.match(await b.turn("!read shared/open-channel-C1/plan.txt"), /no file/);
  assert.doesNotMatch(await b.turn("!memorysearch ROOM_MEMORY"), /ROOM_MEMORY/);
  await b.config.clearSharingPosture("channel:C1");
  assert.equal(await b.turn("!read shared/open-channel-C1/plan.txt"), "ROOM_FILE");
  await b.remove("U1");
  assert.match(await b.turn("!read shared/open-channel-C1/plan.txt"), /no file/);
  assert.doesNotMatch(await b.turn("!memorysearch ROOM_MEMORY"), /ROOM_MEMORY/);
  assert.doesNotMatch(await b.turn("!sysprompt"), /ROOM_MEMORY|open-channel-C1/);
});

test("sharing e2e: skill lazy assets execute, update, and disappear from the same computer after opt-out", async (t) => {
  const b = await fixture(t);
  const s = await b.skill("personal:U1", "carried-helper", "VERSION_ONE");
  assert.match(await b.turn("!sysprompt", true), /carried-helper/);
  assert.match(await b.turn("!read skills/carried-helper/SKILL.md", true), /scripts\/value.py/);
  assert.equal(await b.turn("!run python3 skills/carried-helper/scripts/value.py", true), "VERSION_ONE");
  await b.skills.update(s.id, {
    ...s.manifest,
    files: [{ path: "scripts/value.py", content: "print('VERSION_TWO')\n" }],
  });
  await b.skills.review(s.id, "U1", []);
  await b.skills.publish(s.id);
  await b.turn("!read skills/carried-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/carried-helper/scripts/value.py", true), "VERSION_TWO");
  await b.config.setSharingPosture("personal:U1", "isolated");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /carried-helper/);
  assert.match(await b.turn("!read skills/carried-helper/SKILL.md", true), /no file/);
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print('STALE' if os.path.exists('skills/carried-helper/scripts/value.py') else 'CLEAN')\"",
      true,
    ),
    "CLEAN",
  );
  await b.config.clearSharingPosture("personal:U1");
  await b.turn("!read skills/carried-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/carried-helper/scripts/value.py", true), "VERSION_TWO");
  await b.skills.archive(s.id);
  assert.match(await b.turn("!read skills/carried-helper/SKILL.md", true), /no file/);
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print('STALE' if os.path.exists('skills/carried-helper/scripts/value.py') else 'CLEAN')\"",
      true,
    ),
    "CLEAN",
  );
});

test("sharing e2e: room skills are removed from an existing DM computer after membership revocation", async (t) => {
  const b = await fixture(t);
  await b.skill("channel:C1", "room-helper", "ROOM_HELPER");
  await b.turn("hello", true);
  await b.turn("!read skills/room-helper/SKILL.md");
  assert.equal(await b.turn("!run python3 skills/room-helper/scripts/value.py"), "ROOM_HELPER");
  assert.doesNotMatch(await b.turn("!sysprompt", false, "U4"), /room-helper/);
  await b.remove("U1");
  assert.match(await b.turn("!read skills/room-helper/SKILL.md"), /no file/);
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print('STALE' if os.path.exists('skills/room-helper/scripts/value.py') else 'CLEAN')\"",
    ),
    "CLEAN",
  );
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
  await b.turn("!read skills/explicit-helper/SKILL.md");
  assert.equal(await b.turn("!run python3 skills/explicit-helper/scripts/value.py"), "EXPLICIT");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /personal-helper|explicit-helper/);
  await b.acl.revoke("personal:U2", `skill:${s.id}`, "personal:U1", "U2", "U2");
  assert.match(await b.turn("!read skills/explicit-helper/SKILL.md"), /no file/);
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print('STALE' if os.path.exists('skills/explicit-helper/scripts/value.py') else 'CLEAN')\"",
    ),
    "CLEAN",
  );
});

test("sharing e2e: local skill name wins, then exposes the carried fallback when archived", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "duplicate-helper", "CARRIED");
  const local = await b.skill("channel:C1", "duplicate-helper", "LOCAL");
  await b.turn("!read skills/duplicate-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/duplicate-helper/scripts/value.py", true), "LOCAL");
  await b.skills.archive(local.id);
  await b.turn("!read skills/duplicate-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/duplicate-helper/scripts/value.py", true), "CARRIED");
});

test("sharing e2e: writes and memory capture remain local while reading carried context", async (t) => {
  const b = await fixture(t, { memoryCapture: "writable" });
  await b.workspace.write("personal:U1", "notes.txt", "SOURCE_UNCHANGED");
  await b.memory.capture("personal:U1", ["PERSONAL_SOURCE_MEMORY"], Date.now(), "U1");
  assert.equal(await b.turn("!read shared/open-personal-U1/notes.txt", true), "SOURCE_UNCHANGED");
  assert.match(await b.turn("!write notes.txt ROOM_WRITE", true), /wrote/);
  assert.match(await b.turn("!memoryremember ROOM_CAPTURE_ONLY", true), /remembered 1/);
  assert.equal(await b.workspace.read("personal:U1", "notes.txt"), "SOURCE_UNCHANGED");
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
  assert.equal(await b.turn(`!read shared/open-personal-U1/${path}`, true), "CURRENT_ARTIFACT");
  await b.workspace.write("personal:U1", "binary.dat", Buffer.from([0xff, 0xfe, 0, 1]));
  assert.match(
    await b.turn("!read shared/open-personal-U1/binary.dat", true),
    /Binary files require an explicit share/,
  );
  assert.equal(
    await b.turn("!run python3 -c \"import os; print(os.path.exists('shared/open-personal-U1/binary.dat'))\"", true),
    "False",
  );
  await b.config.setSharingPosture("personal:U1", "isolated");
  assert.match(await b.turn(`!read shared/open-personal-U1/${path}`, true), /no file/);
});

test("sharing e2e: explicit text-file grants survive Isolated and revoke without stale reads", async (t) => {
  const b = await fixture(t);
  await b.workspace.write("personal:U2", "shared-note.txt", "EXPLICIT_TEXT");
  await b.acl.grant(
    {
      ownerScopeId: "personal:U2",
      ref: "shared-note.txt",
      granteeScopeId: "personal:U1",
      permission: "read",
      grantedBy: "U2",
    },
    "U2",
  );
  await b.config.setSharingPosture("org:default-org", "isolated");
  assert.equal(await b.turn("!read shared/shared-note.txt"), "EXPLICIT_TEXT");
  assert.match(await b.turn("!read shared/shared-note.txt", true), /no file/);
  await b.acl.revoke("personal:U2", "shared-note.txt", "personal:U1", "U2", "U2");
  assert.match(await b.turn("!read shared/shared-note.txt"), /no file/);
});

test("sharing e2e: unavailable connector skills cannot be read or executed", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "google-workspace", "UNCONFIGURED_CONNECTOR");
  assert.doesNotMatch(await b.turn("!sysprompt", true), /\*\*google-workspace\*\*/);
  assert.match(await b.turn("!read skills/google-workspace/SKILL.md", true), /no file/);
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print(os.path.exists('skills/google-workspace/scripts/value.py'))\"",
      true,
    ),
    "False",
  );
});

for (const memoryRecall of ["off", "writable"] as const) {
  test(`sharing e2e: memory ${memoryRecall} does not disable carried files or skills`, async (t) => {
    const b = await fixture(t, { memoryRecall });
    await b.workspace.write("personal:U1", "notes.txt", "FILE_WITH_MEMORY_RESTRICTED");
    await b.memory.capture("personal:U1", ["NO_CARRIED_MEMORY"], Date.now(), "U1");
    await b.skill("personal:U1", "independent-helper", "SKILL_WITH_MEMORY_RESTRICTED");
    assert.doesNotMatch(await b.turn("!sysprompt", true), /NO_CARRIED_MEMORY/);
    assert.doesNotMatch(await b.turn("!memorysearch NO_CARRIED_MEMORY", true), /NO_CARRIED_MEMORY/);
    assert.equal(await b.turn("!read shared/open-personal-U1/notes.txt", true), "FILE_WITH_MEMORY_RESTRICTED");
    await b.turn("!read skills/independent-helper/SKILL.md", true);
    assert.equal(
      await b.turn("!run python3 skills/independent-helper/scripts/value.py", true),
      "SKILL_WITH_MEMORY_RESTRICTED",
    );
  });
}

test("sharing e2e: switching the speaker removes the previous speaker's skill before execute", async (t) => {
  const b = await fixture(t);
  await b.skill("personal:U1", "speaker-helper", "SPEAKER_ONE");
  await b.turn("!read skills/speaker-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/speaker-helper/scripts/value.py", true), "SPEAKER_ONE");
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print(os.path.exists('skills/speaker-helper/scripts/value.py'))\"",
      true,
      "U2",
    ),
    "False",
  );
  await b.turn("!read skills/speaker-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/speaker-helper/scripts/value.py", true), "SPEAKER_ONE");
});

test("sharing e2e: a newly blocked skill asset removes previously materialized content", async (t) => {
  const b = await fixture(t);
  const s = await b.skill("personal:U1", "screened-helper", "OLD_SAFE_ASSET");
  await b.turn("!read skills/screened-helper/SKILL.md", true);
  assert.equal(await b.turn("!run python3 skills/screened-helper/scripts/value.py", true), "OLD_SAFE_ASSET");
  await b.skills.update(s.id, {
    ...s.manifest,
    files: [{ path: "scripts/value.py", content: "# !security-risk\nprint('UNSCREENED_NEW_ASSET')\n" }],
  });
  await b.skills.review(s.id, "U1", []);
  await b.skills.publish(s.id);
  assert.equal(
    await b.turn(
      "!run python3 -c \"import os; print(os.path.exists('skills/screened-helper/scripts/value.py'))\"",
      true,
    ),
    "False",
  );
  assert.match(await b.turn("!read skills/screened-helper/SKILL.md", true), /no file/);
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

test("sharing e2e: complete notebooks retain provenance without truncating late facts", async (t) => {
  const b = await fixture(t);
  await b.memory.capture(
    "personal:U1",
    Array.from({ length: 120 }, (_, i) => `PERSONAL_FACT_${i} ${"context ".repeat(12)}`),
    Date.now(),
    "U1",
  );
  await b.memory.capture("channel:C1", ["ROOM_FACT_END"], Date.now(), "U1");
  const p = await b.turn("!sysprompt", true);
  assert.match(p, /### personal:U1[\s\S]*PERSONAL_FACT_119/);
  assert.match(p, /### channel:C1[\s\S]*ROOM_FACT_END/);
  assert.match(await b.turn("!memorysearch PERSONAL_FACT_119", true), /\[personal:U1\].*PERSONAL_FACT_119/);
});
