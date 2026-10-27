import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import type { TurnRequest } from "../src/types.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

async function withDefaultComputer(built: ReturnType<typeof buildApp>) {
  const computer = await built.sandboxResources.create("U1", "personal:U1", "sprites", "default");
  await built.sandboxResources.setDefault("U1", "personal:U1", computer.id);
  return built;
}

function freshApp() {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-skill-")),
  });
  return buildApp(config);
}

const actor = { externalId: "U1" };

async function publishPersonalSkill(skills: ReturnType<typeof buildApp>["skills"]) {
  const sk = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: {
      name: "make-digest",
      description: "assemble a morning digest",
      requiredCapabilities: [],
      body: "# make-digest\nStep 1: gather. Step 2: summarize.",
    },
    createdBy: "U1",
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
  return sk;
}

test("a published personal skill is advertised and loads in the owner's DM", async () => {
  const { app, skills } = freshApp();
  await publishPersonalSkill(skills);

  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(sys.reply ?? "", /## Skills/);
  assert.match(sys.reply ?? "", /make-digest/);

  const read = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:t2" },
    text: "!skill make-digest",
  } as TurnRequest);
  assert.match(read.reply ?? "", /Step 1: gather/);
});

test("a channel session does NOT see a personal skill (scope boundary)", async () => {
  const { app, skills } = freshApp();
  await publishPersonalSkill(skills);
  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [actor] },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(sys.reply ?? "", /make-digest/);
});

test("ordinary sandbox work never touches the skills tree", async () => {
  const { app, skills, sandbox } = await withDefaultComputer(freshApp());
  await publishPersonalSkill(skills);
  const touched: string[] = [];
  const read = sandbox.readFile.bind(sandbox);
  sandbox.readFile = async (handle, path) => {
    if (path.startsWith("skills/")) touched.push(path);
    return read(handle, path);
  };
  const write = sandbox.writeFile.bind(sandbox);
  sandbox.writeFile = async (handle, path, content) => {
    if (path.startsWith("skills/")) touched.push(path);
    return write(handle, path, content);
  };
  const remove = sandbox.removeDir.bind(sandbox);
  sandbox.removeDir = async (handle, path) => {
    if (path.startsWith("skills/")) touched.push(path);
    return remove(handle, path);
  };
  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:no-sync" },
    text: "!read missing.txt",
  } as TurnRequest);
  assert.deepEqual(touched, []);
});

async function publishFileSkill(skills: ReturnType<typeof buildApp>["skills"], name: string) {
  const sk = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: {
      name,
      description: `${name} ships a script`,
      requiredCapabilities: [],
      body: "run the script",
      files: [{ path: "scripts/run.sh", content: `printf ${name}` }],
    },
    createdBy: "U1",
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
  return sk;
}

test("skill files stay on the computer across turns", async () => {
  const { app, skills } = await withDefaultComputer(freshApp());
  const first = await publishFileSkill(skills, "helper");
  const request = {
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:archive" },
  };
  const ran = await app.turn({ ...request, text: "!skill-run helper cat {dir}/scripts/run.sh" } as TurnRequest);
  assert.equal(ran.reply, "printf helper");
  const next = await app.turn({ ...request, text: "!run find . -name run.sh | wc -l | tr -d ' '" } as TurnRequest);
  assert.equal(next.reply, "1");
  await skills.archive(first.id);
  assert.match((await app.turn({ ...request, text: "!skill helper" } as TurnRequest)).reply ?? "", /no skill file/);
});

test("skills index order ignores skill use, so the system prompt stays byte-stable", async () => {
  const built = freshApp();
  for (let i = 0; i < 20; i++) {
    const skill = await built.skills.create({
      scopeId: "personal:U1",
      createdBy: "U1",
      manifest: {
        name: `helper-${String(i).padStart(2, "0")}`,
        description: "General task",
        body: "Instructions",
        requiredCapabilities: [],
      },
    });
    await built.skills.review(skill.id, "reviewer", []);
    await built.skills.publish(skill.id);
  }
  const request = {
    surface: "test" as const,
    actor,
    conversation: { kind: "dm" as const, threadRef: "shortlist-history" },
    text: "!sysprompt",
  };
  const first = await built.app.turn(request);
  assert.ok((first.reply ?? "").indexOf("- helper-00 — ") < (first.reply ?? "").indexOf("- helper-19 — "));
  const sessionId = first.sessionId!;
  const { lease } = await built.sessions.acquireLease(sessionId, "turn");
  assert.ok(lease);
  await built.sessions.append(lease, {
    type: "tool_call",
    payload: { tool: "skills", callId: "skills-1", action: "read", name: "helper-19" },
    scopeLabel: "personal:U1",
  });
  await built.sessions.releaseLease(lease);
  await built.app.turn(request);
  const recorded = (await built.sessions.listLlmRequests(sessionId)).filter((r) => r.model === "mock");
  const systems = recorded.map((r) => (r.promptEnvelope as { system: string }).system);
  assert.equal(systems.length, 2);
  assert.equal(systems[0], systems[1]);
});

test("Open sharing keeps private skill metadata out of the persisted channel shortlist", async () => {
  const built = buildApp(testConfig({ securityScreen: "off" }));
  await built.config.setSharingPosture("org:default-org", "open");
  await publishPersonalSkill(built.skills);
  const result = await built.app.turn({
    surface: "test",
    origin: { kind: "human" },
    actor,
    conversation: {
      kind: "channel",
      channelRef: "C1",
      threadRef: "shortlist-open",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!sysprompt",
  });
  assert.equal(result.status, "ok");
  assert.doesNotMatch(result.reply ?? "", /assemble a morning digest|\*\*make-digest\*\*/);
  const read = await built.app.turn({
    surface: "test",
    origin: { kind: "human" },
    actor,
    conversation: {
      kind: "channel",
      channelRef: "C1",
      threadRef: "shortlist-open",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!skill make-digest",
  });
  assert.match(read.reply ?? "", /Step 1: gather/);
  const entries = await built.sessions.getEntries(result.sessionId!);
  assert.doesNotMatch(JSON.stringify(entries.filter((e) => e.type === "user")), /assemble a morning digest/);
});
