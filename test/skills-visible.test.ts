import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const config: Config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-skvis-")),
    orgId: "acme",
    seedSkills: false,
  });
  return buildApp(config);
}

async function publish(
  skills: ReturnType<typeof buildApp>["skills"],
  scope: ScopeId,
  name: string,
  description: string,
) {
  const sk = await skills.create({
    scopeId: scope,
    manifest: { name, description, requiredCapabilities: [], body: `# ${name}\n${description}` },
    createdBy: "author",
  });
  await skills.review(sk.id, "reviewer-1", []);
  return skills.publish(sk.id);
}

test("another principal does not see U1's personal skill (scope boundary)", async () => {
  const { app, skills } = freshApp();
  await publish(skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");

  const visible = await app.listVisibleSkills("U2");
  assert.ok(!visible.some((r) => r.skill!.manifest.name === "make-digest"));
});

test("an unpublished (draft/reviewed) skill is not visible", async () => {
  const { app, skills } = freshApp();
  const draft = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "wip", description: "not ready", requiredCapabilities: [], body: "# wip" },
    createdBy: "U1",
  });
  await skills.review(draft.id, "reviewer-1", []);

  const visible = await app.listVisibleSkills("U1");
  assert.ok(!visible.some((r) => r.skill!.manifest.name === "wip"));
});
