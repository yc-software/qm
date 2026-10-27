import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../../src/config.ts";
import { PROACTIVE_OPENER_PROMPT } from "../../src/onboarding/onboarding.ts";
import type { TurnRequest } from "../../src/types.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";

const actor = { externalId: "U1" };
const onboardingSkillDir = join(process.cwd(), "plugins/onboarding/skills");

function freshApp(overrides: Partial<Config> = {}) {
  const config: Config = testConfig({ pluginSkillDirs: [onboardingSkillDir], ...overrides });
  return buildApp(config);
}

async function waitForOnboardingSkill(skills: ReturnType<typeof buildApp>["skills"]): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if ((await skills.list()).some((s) => s.manifest.name === "onboarding" && s.status === "published")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("onboarding skill was not seeded");
}

test("a new personal DM offers onboarding through the skills index", async () => {
  const { app, skills } = freshApp();
  await waitForOnboardingSkill(skills);

  const sys = await app.turn({
    origin: { kind: "direct" },
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

test("ideas web conversations bypass onboarding on every turn without completing it", async () => {
  const { app, skills } = freshApp();
  await waitForOnboardingSkill(skills);
  const threadRef = "web:U1:ideas:12345678-1234-4123-8123-123456789abc";
  for (let i = 0; i < 2; i++) {
    const sys = await app.turn({
      origin: { kind: "direct" },
      surface: "web",
      actor,
      conversation: { kind: "dm", threadRef },
      text: "!sysprompt",
    } as TurnRequest);
    assert.match(sys.reply ?? "", /Skip the onboarding skill and setup flow for this entire conversation/);
  }
  const ordinary = await app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:ordinary" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(ordinary.reply ?? "", /## Ideas conversation/);
});

const onboarding = readFileSync("plugins/onboarding/skills/onboarding/SKILL.md", "utf8");
const admin = readFileSync("skills-seed/admin/SKILL.md", "utf8");

test("onboarding checks bot status before offering setup and silently skips an existing bot", () => {
  assert.match(onboarding, /before mentioning Slack bot setup/);
  assert.match(onboarding, /configured: true[^\n]*skip silently/);
  assert.match(onboarding, /no Slack setup heading, checklist, status announcement, or verification task/);
  assert.match(onboarding, /unknown, not missing/);
  assert.match(onboarding, /never ask regular users to provision it/);
});

test("automatic greetings cannot advertise unverified Slack setup", () => {
  assert.match(PROACTIVE_OPENER_PROMPT, /Do not mention Slack bot setup in this automatic greeting/);
  assert.doesNotMatch(PROACTIVE_OPENER_PROMPT, /offer Slack bot setup first/);
});

test("missing-bot setup presents available links together, without inventing URLs", () => {
  assert.match(admin, /all three links together in one message/);
  assert.match(admin, /Create token/);
  assert.match(admin, /Submit token/);
  assert.match(admin, /Add to Slack/);
  assert.match(admin, /Never invent URLs/);
  assert.match(admin, /not a generic keychain token-drop/);
  assert.match(admin, /without another assistant reply/);
  assert.doesNotMatch(admin, /walk the admin through.*one step at a time/i);
});

test("admins set up a connector source before voice or work questions", () => {
  assert.match(PROACTIVE_OPENER_PROMPT, /first step is connecting their tools/);
  assert.ok(onboarding.indexOf("Connector source first for admins") < onboarding.indexOf("Slack bot first for admins"));
  assert.match(onboarding, /Never ask for the key or client\s+secrets in chat/);
  assert.match(onboarding, /GET \/v1\/composio\/toolkits/);
  assert.match(onboarding, /Connected apps block/);
  assert.match(onboarding, /unknown, not absent/);
  assert.doesNotMatch(onboarding, /connector-sources/);
  assert.match(admin, /view=credentials[\s\S]*COMPOSIO_API_KEY/);
  assert.match(admin, /<web origin>\/settings\/credentials[\s\S]*<web origin>\/settings\/connectors/);
  assert.match(admin, /<web origin>\/v1\/connectors\/oauth\/<provider>\/callback/);
  assert.match(admin, /Never\s+ask\s+regular\s+users\s+to\s+configure\s+a\s+source/);
});
