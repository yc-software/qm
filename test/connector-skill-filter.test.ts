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
  ];
  assert.deepEqual(
    filterConnectorSkills(all, []).map((entry) => entry.skill?.manifest.name),
    ["memory"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["google", "linear"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "google-workspace", "linear"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["slack"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "slack-drafts"],
  );
});
