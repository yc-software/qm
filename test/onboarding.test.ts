import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { detectOnboardingStatus, setOnboardingStatus, PROACTIVE_OPENER_PROMPT } from "../src/onboarding/onboarding.ts";
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

test("the proactive opener checks connection availability before offering account linking", () => {
  assert.match(PROACTIVE_OPENER_PROMPT, /Connected apps/);
  assert.match(PROACTIVE_OPENER_PROMPT, /admin/);
  assert.doesNotMatch(PROACTIVE_OPENER_PROMPT, /start onboarding by walking them through connecting their accounts/);
});

for (const isAdmin of [true, false]) {
  for (const appState of ["configured", "disabled", "no"]) {
    const configured = appState === "configured";
    test(`onboarding routes ${isAdmin ? "admin" : "member"} with ${appState} OAuth apps`, async () => {
      const built = buildApp(
        testConfig({
          pluginSkillDirs: [onboardingSkillDir],
          signingSecret: "onboarding-test-signing-secret-long-enough",
          apiBaseUrl: "http://localhost:3000",
          publicWebUrl: "https://qm.example",
          adminGrants: "admin-alice:org_admin",
        }),
      );
      await waitForOnboardingSkill(built.skills);
      if (appState !== "no") {
        await built.config.setConnectorClient(scopeId("org", "default-org"), "google", {
          clientId: "test-client",
          clientSecret: "test-secret",
          enabled: configured,
        });
      }
      const sys = await built.app.turn({
        surface: "test",
        actor: { externalId: isAdmin ? "admin-alice" : "U1" },
        conversation: { kind: "dm", threadRef: `dm:onboarding:${isAdmin}:${configured}` },
        origin: { kind: "human" },
        text: "!sysprompt",
      } as TurnRequest);
      const prompt = sys.reply ?? "";
      assert.match(prompt, /## Pending Onboarding/);
      assert.equal(prompt.includes("## Acting for an org admin"), isAdmin);
      const apps = prompt.split("## Connected apps")[1]?.split("\n## ")[0] ?? "";
      if (configured) {
        assert.match(apps, /Available to connect: Google/);
        assert.doesNotMatch(apps, /offer to walk/);
      } else {
        assert.match(apps, /Do not mint native OAuth consent links for unconfigured providers/);
        if (isAdmin) {
          assert.match(apps, /offer to walk.*OAuth app setup/);
          assert.match(apps, /https:\/\/qm\.example\/admin\/connectors/);
        } else {
          assert.match(apps, /an org admin needs to configure/);
          assert.doesNotMatch(apps, /offer to walk/);
        }
      }
    });
  }
}

test("automated turns do not inherit the admin OAuth setup path", async () => {
  const { app } = buildApp(
    testConfig({
      signingSecret: "onboarding-test-signing-secret-long-enough",
      apiBaseUrl: "http://localhost:3000",
      adminGrants: "admin-alice:org_admin",
    }),
  );
  const sys = await app.turn({
    surface: "test",
    actor: { externalId: "admin-alice" },
    conversation: { kind: "dm", threadRef: "dm:onboarding:automated" },
    origin: { kind: "automation" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(sys.reply ?? "", /## Acting for an org admin|offer to walk.*OAuth app setup/);
});

for (const isAdmin of [true, false]) {
  for (const granted of [true, false]) {
    test(`onboarding checks alternate sources for ${isAdmin ? "admin" : "member"}, grant=${granted}`, async () => {
      const built = buildApp(
        testConfig({
          pluginSkillDirs: [onboardingSkillDir],
          signingSecret: "onboarding-test-signing-secret-long-enough",
          apiBaseUrl: "http://localhost:3000",
          adminGrants: "admin-alice:org_admin",
        }),
      );
      await waitForOnboardingSkill(built.skills);
      const actorId = isAdmin ? "admin-alice" : "U1";
      await built.serviceCreds.setServiceCredential("org:default-org", {
        slug: "connector-hub",
        name: "Composio",
        secret: "source-fixture-secret",
        host: "connectors.example",
      });
      await built.acl.grant({
        ownerScopeId: "org:default-org",
        ref: "service-cred:connector-hub",
        granteeScopeId: granted ? scopeId("personal", actorId) : "personal:someone-else",
        permission: "read",
        grantedBy: "admin-alice",
      });
      const sys = await built.app.turn({
        surface: "test",
        actor: { externalId: actorId },
        conversation: { kind: "dm", threadRef: `dm:sources:${actorId}:${granted}` },
        origin: { kind: "human" },
        text: "!sysprompt",
      } as TurnRequest);
      assert.equal(sys.status, "ok");
      const prompt = sys.reply ?? "";
      assert.equal(prompt.includes("`connector-hub` →"), granted, "only granted sources enter the live manifest");
      assert.doesNotMatch(prompt, /source-fixture-secret/);
      const apps = prompt.split("## Connected apps")[1]?.split("\n## ")[0] ?? "";
      assert.match(apps, /native OAuth connections only/);
      assert.match(apps, /other authorized sources/);
      assert.match(apps, /account.*permissions/);
      assert.doesNotMatch(apps, /Do not suggest or offer any app connection/);
      assert.match(PROACTIVE_OPENER_PROMPT, /other authorized sources/);
    });
  }
}
