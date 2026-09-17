import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

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

test("a published personal skill is advertised + materialized in the owner's DM", async () => {
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
    text: "!read skills/make-digest/SKILL.md",
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

test("ordinary sandbox work reconciles ownership without copying skill contents", async () => {
  const { app, skills, sandbox } = freshApp();
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
  assert.deepEqual(touched, ["skills/.index", "skills/.index"]);
});

test("ordinary sandbox reads remove archived skill files before access", async () => {
  const { app, skills } = freshApp();
  const skill = await publishPersonalSkill(skills);
  const request = {
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:archive" },
  };
  const before = await app.turn({ ...request, text: "!read skills/make-digest/SKILL.md" } as TurnRequest);
  assert.match(before.reply ?? "", /Step 1: gather/);
  await skills.archive(skill.id);
  const after = await app.turn({ ...request, text: "!read ././skills/make-digest/SKILL.md" } as TurnRequest);
  assert.doesNotMatch(after.reply ?? "", /Step 1: gather/);
});
