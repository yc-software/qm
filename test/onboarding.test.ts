import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import {
  detectOnboardingStatus,
  resolveOnboardingStatus,
  setOnboardingStatus,
  PROACTIVE_OPENER_PROMPT,
} from "../src/onboarding/onboarding.ts";
import { testConfig } from "./support/test-config.ts";

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
  assert.match(sys.reply ?? "", /load the onboarding skill with the skills tool/);
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

test("the opener defers Slack setup until status can be checked without requiring provider configuration", () => {
  assert.match(PROACTIVE_OPENER_PROMPT, /Do not mention Slack bot setup in this automatic greeting/);
  assert.match(PROACTIVE_OPENER_PROMPT, /wait for their reply before reading admin-only status/);
  assert.match(PROACTIVE_OPENER_PROMPT, /empty direct OAuth list does not rule out Composio/);
  assert.match(PROACTIVE_OPENER_PROMPT, /skip connections and continue onboarding/);
  assert.match(PROACTIVE_OPENER_PROMPT, /do not ask them to create OAuth apps or supply project keys/);
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
    assert.doesNotMatch(sys.reply ?? "", /## Pending Onboarding/);
    assert.match(sys.reply ?? "", /## Incognito conversation\nThe user started this conversation in incognito mode/);
  }
  assert.equal(detectOnboardingStatus(await memory.read(scopeId("personal", "U1"))), "not_started");
  const ordinary = await app.turn({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:not-incognito" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.equal(ordinary.incognito, undefined);
  assert.match(ordinary.reply ?? "", /## Pending Onboarding/);
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
    assert.doesNotMatch(sys.reply ?? "", /## Pending Onboarding/);
    assert.match(sys.reply ?? "", /Skip the onboarding skill and setup flow for this entire conversation/);
  }
  assert.equal(detectOnboardingStatus(await memory.read(scopeId("personal", "U1"))), "not_started");
  const ordinary = await app.turn({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "web:U1:ordinary" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(ordinary.reply ?? "", /## Pending Onboarding/);
  const slack = await app.turn({
    surface: "slack",
    actor,
    conversation: { kind: "dm", threadRef },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(slack.reply ?? "", /## Pending Onboarding/);
});

for (const initialStatus of ["not_started", "pending"] as const) {
  test(`three personal chats durably dismiss ${initialStatus} onboarding`, async () => {
    const { app, skills, memory, sessions } = freshApp();
    await waitForOnboardingSkill(skills);
    const scope = scopeId("personal", "U1");
    await memory.replace(scope, setOnboardingStatus("## Notes\n\nKeep my preferences.\n", initialStatus, "2026-09-17"));
    const prompt = async () =>
      (
        await app.turn({
          surface: "test",
          actor,
          conversation: { kind: "dm", threadRef: "dm:U1:current" },
          text: "!sysprompt",
        } as TurnRequest)
      ).reply ?? "";
    for (let i = 0; i < 3; i++) {
      assert.equal(await resolveOnboardingStatus(memory, sessions, scope), initialStatus);
      const session = await sessions.getOrCreateByThread(`web:U1:past-${i}`, "dm", scope);
      const { lease } = await sessions.acquireLease(session.id);
      assert.ok(lease);
      await sessions.append(lease, { type: "user", payload: { text: "Help with my work" }, scopeLabel: scope });
      await sessions.releaseLease(lease);
    }
    assert.doesNotMatch(await prompt(), /## Pending Onboarding/);
    assert.equal(detectOnboardingStatus(await memory.read(scope)), "dismissed");
    assert.match(await memory.read(scope), /Keep my preferences/);
    const dismissed = await memory.read(scope);
    for (const session of await sessions.listByScope(scope)) await sessions.deleteSession(session.id);
    assert.doesNotMatch(await prompt(), /## Pending Onboarding/);
    assert.equal(await memory.read(scope), dismissed);
  });
}

test("automatic dismissal preserves concurrent completion and memory changes", async () => {
  const { memory, sessions } = freshApp();
  const scope = scopeId("personal", "U1");
  const countingSessions = {
    ...sessions,
    async countPersonalConversations() {
      await memory.replace(scope, "- Onboarding: completed v2 on 2026-09-17.\n- A concurrent preference.\n");
      return 3;
    },
  };
  await resolveOnboardingStatus(memory, countingSessions, scope);
  assert.equal(detectOnboardingStatus(await memory.read(scope)), "completed");
  assert.match(await memory.read(scope), /A concurrent preference/);
});

test("completed and dismissed onboarding do not recount or rewrite history", async () => {
  const { memory, sessions } = freshApp();
  const scope = scopeId("personal", "U1");
  const noCounting = {
    ...sessions,
    async countPersonalConversations() {
      throw new Error("unexpected count");
    },
  };
  for (const status of ["completed", "dismissed"] as const) {
    const content = setOnboardingStatus("Keep this.", status, "2026-09-17");
    await memory.replace(scope, content);
    assert.equal(await resolveOnboardingStatus(memory, noCounting, scope), status);
    assert.equal(await memory.read(scope), content);
  }
});

test("automatic dismissal writes the permanent notebook with scratch-promote memory", async () => {
  const { memory, sessions } = freshApp({ memoryStrategy: "scratch-promote" });
  const scope = scopeId("personal", "U1");
  let count = 3;
  const history = {
    ...sessions,
    async countPersonalConversations() {
      return count;
    },
  };
  await resolveOnboardingStatus(memory, history, scope);
  assert.equal(detectOnboardingStatus(await memory.read(scope)), "dismissed");
  count = 0;
  assert.equal(await resolveOnboardingStatus(memory, history, scope), "dismissed");
});

test("automatic dismissal retries a notebook revision conflict without losing new facts", async () => {
  const { memory, sessions } = freshApp();
  const scope = scopeId("personal", "U1");
  let attempts = 0;
  const racingMemory = {
    ...memory,
    async replaceIfRevision(s: typeof scope, body: string, revision: string) {
      if (attempts++ === 0) await memory.replace(s, "- A concurrently saved fact.\n");
      return memory.replaceIfRevision!(s, body, revision);
    },
  };
  await resolveOnboardingStatus(
    racingMemory,
    {
      ...sessions,
      async countPersonalConversations() {
        return 3;
      },
    },
    scope,
  );
  assert.equal(attempts, 2);
  assert.equal(detectOnboardingStatus(await memory.read(scope)), "dismissed");
  assert.match(await memory.read(scope), /A concurrently saved fact/);
});
