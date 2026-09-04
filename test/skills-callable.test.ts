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

test("the next provision reconciles the index after the last visible skill is archived", async () => {
  const { app, skills, sandbox } = freshApp();
  const skill = await publishPersonalSkill(skills);
  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:cleanup-1" },
    text: "!read skills/make-digest/SKILL.md",
  } as TurnRequest);

  const removed: string[] = [];
  const originalRemove = sandbox.removeDir.bind(sandbox);
  sandbox.removeDir = async (handle, path) => {
    removed.push(path);
    await originalRemove(handle, path);
  };
  await skills.archive(skill.id);
  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:cleanup-2" },
    text: "!read missing.txt",
  } as TurnRequest);

  assert.ok(removed.some((path) => path === "skills/make-digest" || path.startsWith("skills/make-digest/")));
});
