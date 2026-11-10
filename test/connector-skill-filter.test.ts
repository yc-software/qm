import test from "node:test";
import assert from "node:assert/strict";
import { filterConnectorSkills } from "../src/core/orchestrator.ts";
import type { SkillResolution } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function skill(name: string): SkillResolution {
  return {
    skill: {
      id: name,
      scopeId: scopeId("org", "acme"),
      manifest: { name, description: name, requiredCapabilities: [], body: name },
      signature: "sig",
      status: "published",
      createdBy: "test",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
      createdAt: 1,
      updatedAt: 1,
    },
    shadowed: [],
  };
}

test("provider skills are visible only for connectors configured by the admin", () => {
  const all = [
    skill("memory"),
    skill("google-workspace"),
    skill("dropbox"),
    skill("linear"),
    skill("x"),
    skill("slack-drafts"),
    skill("zoom"),
  ];
  assert.deepEqual(
    filterConnectorSkills(all, [], false).map((entry) => entry.skill?.manifest.name),
    ["memory"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["google", "linear"], false).map((entry) => entry.skill?.manifest.name),
    ["memory", "google-workspace", "linear"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["slack"], false).map((entry) => entry.skill?.manifest.name),
    ["memory", "slack-drafts"],
  );
});

test("the credential-backed Composio skill needs no dedicated OAuth configuration", () => {
  assert.deepEqual(
    filterConnectorSkills([skill("composio"), skill("google-workspace")], [], false).map(
      (entry) => entry.skill?.manifest.name,
    ),
    ["composio"],
  );
});

test("app connections make the proxy-capable native skills visible without their own OAuth app", () => {
  const all = [
    skill("google-workspace"),
    skill("google-drive-sheets"),
    skill("dropbox"),
    skill("linear"),
    skill("zoom"),
    skill("slack-drafts"),
    skill("email-voice-profile"),
  ];
  assert.deepEqual(
    filterConnectorSkills(all, [], true).map((entry) => entry.skill?.manifest.name),
    ["google-workspace", "google-drive-sheets", "dropbox", "linear", "zoom"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, [], false).map((entry) => entry.skill?.manifest.name),
    [],
  );
});
