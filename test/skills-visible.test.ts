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
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";

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

test("listVisibleSkills returns a principal's personal + org skills with scope labels", async () => {
  const { app, skills } = freshApp();
  await publish(skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
  await publish(skills, scopeId("org", "default-org"), "deploy-bot", "ship the bot to prod");

  const visible = await app.listVisibleSkills("U1");
  const byName = new Map(visible.map((r) => [r.skill!.manifest.name, r]));
  assert.equal(byName.get("make-digest")!.skill!.scopeId, scopeId("personal", "U1"));
  assert.equal(byName.get("deploy-bot")!.skill!.scopeId, scopeId("org", "default-org"));
});

test("a personal skill shadows a same-named org skill (most-specific wins, shadow surfaced)", async () => {
  const { app, skills } = freshApp();
  await publish(skills, scopeId("org", "default-org"), "notes", "the org-wide notes skill");
  await publish(skills, scopeId("personal", "U1"), "notes", "U1's own notes skill");

  const visible = await app.listVisibleSkills("U1");
  const notes = visible.filter((r) => r.skill!.manifest.name === "notes");
  assert.equal(notes.length, 1, "one winner per name");
  assert.equal(notes[0]!.skill!.scopeId, scopeId("personal", "U1"), "personal wins over org");
  assert.equal(notes[0]!.shadowed.length, 1, "the org skill it shadows is surfaced");
  assert.equal(notes[0]!.shadowed[0]!.scopeId, scopeId("org", "default-org"));
});

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

test("visibleFor reads the full skills table once, not once per skill name", async () => {
  const backing = createMemoryMap<Skill>();
  let allReads = 0;
  const originalAll = backing.all.bind(backing);
  backing.all = () => {
    allReads += 1;
    return originalAll();
  };
  const skills = createSkillStore({ backing });

  const org = scopeId("org", "default-org");
  const personal = scopeId("personal", "U1");
  for (let i = 0; i < 200; i++) {
    const scope = i % 2 === 0 ? org : personal;
    const sk = await skills.create({
      scopeId: scope,
      manifest: { name: `skill-${i}`, description: `skill ${i}`, requiredCapabilities: [], body: `# skill-${i}` },
      createdBy: "author",
    });
    await skills.review(sk.id, "reviewer-1", []);
    await skills.publish(sk.id);
  }
  const shadowing = await skills.create({
    scopeId: personal,
    manifest: { name: "skill-0", description: "personal override", requiredCapabilities: [], body: "# skill-0" },
    createdBy: "U1",
  });
  await skills.review(shadowing.id, "reviewer-1", []);
  await skills.publish(shadowing.id);

  allReads = 0;
  const visible = await skills.visibleFor([personal, org]);

  assert.equal(allReads, 1, "one full skills read per visibleFor call");
  assert.equal(visible.length, 200);
  const shadowed = visible.find((r) => r.skill!.manifest.name === "skill-0")!;
  assert.equal(shadowed.skill!.scopeId, personal);
  assert.equal(shadowed.shadowed.length, 1);
  assert.equal(shadowed.shadowed[0]!.scopeId, org);
});
