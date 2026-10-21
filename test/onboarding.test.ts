import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import type { Config } from "../src/config.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { detectOnboardingStatus, setOnboardingStatus, PROACTIVE_OPENER_PROMPT } from "../src/onboarding/onboarding.ts";
import { testConfig } from "./support/test-config.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";

const actor = { externalId: "U1" };
const onboardingSkillDir = join(process.cwd(), "plugins/onboarding/skills");

function freshApp(overrides: Partial<Config> = {}) {
  const config: Config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-onboarding-")),
    pluginSkillDirs: [onboardingSkillDir],
    ...overrides,
  });
  return buildApp(config);
}

async function waitForOnboardingSkill(skills: ReturnType<typeof buildApp>["skills"]): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await skills.list()).some((s) => s.manifest.name === "onboarding" && s.status === "published")) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail("onboarding skill was not seeded");
}

test("onboarding memory markers are detected from readable memory bullets", () => {
  assert.equal(detectOnboardingStatus(""), "not_started");
  assert.equal(detectOnboardingStatus("## Onboarding\n\n- Onboarding: pending v2 since 2026-06-09."), "pending");
  assert.equal(detectOnboardingStatus("- (2026-06-09) Onboarding: completed v2 on 2026-06-09."), "completed");
  assert.equal(detectOnboardingStatus("- Onboarding: dismissed v2 on 2026-06-09."), "dismissed");
});

test("setOnboardingStatus replaces the marker fact and round-trips through detect", async () => {
  const memory = createMemoryService(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "onboarding-mem-"))));
  const scope = scopeId("personal", "U1");
  await memory.capture(scope, ["some prefs", "onboarding:  Pending v2."], Date.UTC(2026, 5, 1));

  await setOnboardingStatus(memory, scope, "completed", "2026-06-22", "admin");
  const completed = await memory.read(scope);
  assert.equal(detectOnboardingStatus(completed), "completed");
  assert.doesNotMatch(completed, /pending/i);
  assert.match(completed, /some prefs/);

  await setOnboardingStatus(memory, scope, "not_started", "2026-06-22", "admin");
  assert.equal(detectOnboardingStatus(await memory.read(scope)), "not_started");
  assert.match(await memory.read(scope), /some prefs/);
});

test("a new personal DM offers onboarding through the skills index", async () => {
  const { app, skills } = freshApp();
  await waitForOnboardingSkill(skills);

  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:onboarding-new" },
    text: "!sysprompt",
  } as TurnRequest);

  assert.match(sys.reply ?? "", /\*\*onboarding\*\*/);
});

test("the opener defers Slack setup until status can be checked without requiring provider configuration", () => {
  assert.match(PROACTIVE_OPENER_PROMPT, /Do not mention Slack bot setup in this automatic greeting/);
  assert.match(PROACTIVE_OPENER_PROMPT, /wait for their reply before reading admin-only status/);
  assert.match(PROACTIVE_OPENER_PROMPT, /empty direct OAuth list does not rule out Composio/);
  assert.match(PROACTIVE_OPENER_PROMPT, /skip connections and continue onboarding/);
  assert.match(PROACTIVE_OPENER_PROMPT, /Never ask regular users to create OAuth apps or supply project keys/);
});

test("incognito conversations skip onboarding and carry the incognito block on every turn", async () => {
  const { app, skills, memory } = freshApp();
  await waitForOnboardingSkill(skills);
  const threadRef = "web:U1:12345678-1234-4123-8123-00000000abcd";
  for (const incognito of [true, undefined]) {
    const sys = await app.turn({
      surface: "web",
      actor,
      conversation: { kind: "dm", threadRef },
      text: "!sysprompt",
      ...(incognito ? { incognito } : {}),
    } as TurnRequest);
    assert.equal(sys.incognito, true);
    assert.match(sys.reply ?? "", /## Incognito conversation\nThe user started this conversation in incognito mode/);
    assert.match(sys.reply ?? "", /Skip the onboarding skill and setup flow\./);
  }
  assert.equal(detectOnboardingStatus(await memory.read(scopeId("personal", "U1"))), "not_started");
  const ordinary = await app.turn({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:not-incognito" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.equal(ordinary.incognito, undefined);
  assert.doesNotMatch(ordinary.reply ?? "", /## Incognito conversation/);
});

test("ideas web conversations bypass onboarding on every turn without completing it", async () => {
  const { app, skills, memory } = freshApp();
  await waitForOnboardingSkill(skills);
  const threadRef = "web:U1:ideas:12345678-1234-4123-8123-123456789abc";
  for (let i = 0; i < 2; i++) {
    const sys = await app.turn({
      surface: "web",
      actor,
      conversation: { kind: "dm", threadRef },
      text: "!sysprompt",
    } as TurnRequest);
    assert.match(sys.reply ?? "", /Skip the onboarding skill and setup flow for this entire conversation/);
  }
  assert.equal(detectOnboardingStatus(await memory.read(scopeId("personal", "U1"))), "not_started");
  const ordinary = await app.turn({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:ordinary" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(ordinary.reply ?? "", /## Ideas conversation/);
});
