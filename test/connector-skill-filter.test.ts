import test from "node:test";
import assert from "node:assert/strict";
import { filterConnectorSkills } from "../src/core/orchestrator.ts";
import type { SkillResolution } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function skill(name: string, connector?: string): SkillResolution {
  return {
    skill: {
      id: name,
      scopeId: scopeId("org", "acme"),
      manifest: { name, description: name, requiredCapabilities: [], ...(connector ? { connector } : {}), body: name },
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

const names = (resolved: SkillResolution[]) => resolved.map((entry) => entry.skill?.manifest.name);

test("a skill declaring a connector is hidden until the admin configures that provider; others are always listed", () => {
  const all = [
    skill("memory"),
    skill("linear"),
    skill("google-workspace", "google"),
    skill("dropbox", "dropbox"),
    skill("tracker", "linear"),
    skill("slack-drafts", "slack"),
  ];
  assert.deepEqual(names(filterConnectorSkills(all, [])), ["memory", "linear"]);
  assert.deepEqual(names(filterConnectorSkills(all, ["google", "linear"])), [
    "memory",
    "linear",
    "google-workspace",
    "tracker",
  ]);
  assert.deepEqual(names(filterConnectorSkills(all, ["slack"])), ["memory", "linear", "slack-drafts"]);
});
