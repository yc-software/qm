import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROACTIVE_OPENER_PROMPT } from "../src/onboarding/onboarding.ts";

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
