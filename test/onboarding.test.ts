import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { detectOnboardingStatus, setOnboardingStatus } from "../src/onboarding/onboarding.ts";
import { testConfig } from "./support/test-config.ts";

const actor = { externalId: "U1" };
const onboardingSkillDir = join(process.cwd(), "plugins/onboarding/skills");

function freshApp() {
  const config: Config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-onboarding-")),
    pluginSkillDirs: [onboardingSkillDir],
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

test("setOnboardingStatus rewrites the marker and round-trips through detect", () => {
  const completed = setOnboardingStatus("## Notes\n\nsome prefs\n", "completed", "2026-06-22");
  assert.equal(detectOnboardingStatus(completed), "completed");
  assert.match(completed, /- Onboarding: completed v2 on 2026-06-22\./);
  assert.match(completed, /some prefs/);

  const reset = setOnboardingStatus(completed, "not_started", "2026-06-22");
  assert.equal(detectOnboardingStatus(reset), "not_started");
  assert.doesNotMatch(reset, /Onboarding:/);
  assert.match(reset, /some prefs/);

  const flipped = setOnboardingStatus(
    "- (2026-01-01) Onboarding: completed v2 on 2026-01-01.\n",
    "dismissed",
    "2026-06-22",
  );
  assert.equal(detectOnboardingStatus(flipped), "dismissed");
  assert.doesNotMatch(flipped, /completed/);

  assert.equal(setOnboardingStatus("", "not_started", "2026-06-22"), "");
  assert.equal(detectOnboardingStatus(setOnboardingStatus("", "pending", "2026-06-22")), "pending");
});

test("a new personal DM gets the high-priority pending onboarding prompt", async () => {
  const { app, skills } = freshApp();
  await waitForOnboardingSkill(skills);

  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:onboarding-new" },
    text: "!sysprompt",
  } as TurnRequest);

  assert.match(sys.reply ?? "", /## Pending Onboarding/);
  assert.match(sys.reply ?? "", /high-priority setup task/);
  assert.match(sys.reply ?? "", /no reason to skip it/);
  assert.match(sys.reply ?? "", /skills\/onboarding\/SKILL\.md/);
});

test("completed or dismissed onboarding markers suppress the pending prompt", async () => {
  const { app, skills, memory } = freshApp();
  await waitForOnboardingSkill(skills);
  await memory.replace(scopeId("personal", "U1"), "## Onboarding\n\n- Onboarding: completed v2 on 2026-06-09.\n");

  const completed = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:onboarding-completed" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(completed.reply ?? "", /## Pending Onboarding/);

  await memory.replace(scopeId("personal", "U1"), "## Onboarding\n\n- Onboarding: dismissed v2 on 2026-06-09.\n");
  const dismissed = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:onboarding-dismissed" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(dismissed.reply ?? "", /## Pending Onboarding/);
});

test("onboarding prompt does not appear in channel sessions", async () => {
  const { app, skills } = freshApp();
  await waitForOnboardingSkill(skills);

  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef: "C1:onboarding", channelRef: "C1", audience: [actor] },
    text: "!sysprompt",
  } as TurnRequest);

  assert.doesNotMatch(sys.reply ?? "", /## Pending Onboarding/);
});
