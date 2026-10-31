import { scopeId } from "../src/types.ts";
import "./support/auto-fake-sprites.ts";

import test from "node:test";
import assert from "node:assert/strict";
import { testSkillStore } from "./support/typed-stores.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { buildLoadedApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { TEST_ROOT_SCOPE } from "./support/tenant.ts";

const org = TEST_ROOT_SCOPE;
const manifest = { name: "demo", description: "d", requiredCapabilities: [], body: "# Demo" };

async function published() {
  const skills = testSkillStore();
  const s = await skills.create({ scopeId: org, manifest, createdBy: "pack:src1" });
  await skills.review(s.id, "system:pack-reviewer", []);
  await skills.publish(s.id);
  return { skills, id: s.id };
}

test("archive stops a skill resolving but keeps the record", async () => {
  const { skills, id } = await published();
  assert.equal((await skills.resolve("demo", [org])).skill?.id, id);
  assert.equal((await skills.visibleFor([org])).length, 1);

  const archived = await skills.archive(id);
  assert.equal(archived.status, "archived");
  assert.equal((await skills.resolve("demo", [org])).skill, null);
  assert.equal((await skills.visibleFor([org])).length, 0);
  assert.equal((await skills.get(id))!.status, "archived");
});

test("archive is idempotent", async () => {
  const { skills, id } = await published();
  await skills.archive(id);
  const again = await skills.archive(id);
  assert.equal(again.status, "archived");
});

test("an archived skill can be re-published (resurrection on re-import)", async () => {
  const { skills, id } = await published();
  await skills.archive(id);
  await skills.publish(id);
  assert.equal((await skills.resolve("demo", [org])).skill?.id, id);
});

test("create carries pack provenance, kept out of the signature", async () => {
  const skills = testSkillStore();
  const s = await skills.create({
    scopeId: org,
    manifest,
    createdBy: "pack:src1",
    pack: { packId: "src1", commit: "abc123", upstreamName: "demo" },
  });
  assert.deepEqual(s.pack, { packId: "src1", commit: "abc123", upstreamName: "demo" });
  assert.ok(skills.verify(s));
});

test("a person sees their archived skill stored under a linked identity", async (t) => {
  const built = await buildLoadedApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "skills-linked-")), seedSkills: false }),
  );
  installPrincipalLinks({
    canonical: (key) => (key === "U123" ? "alice@acme.com" : undefined),
    aliases: (key) => (key === "alice@acme.com" ? ["U123"] : []),
  });
  t.after(() => installPrincipalLinks(null));
  const sk = await built.skills.create({
    scopeId: scopeId("personal", "U123"),
    manifest: { name: "from-slack", description: "d", requiredCapabilities: [], body: "# x" },
    createdBy: "U123",
  });
  await built.skills.archive(sk.id);
  const archived = await built.app.listSkills({ archivedFor: "Alice@acme.com" });
  assert.deepEqual(
    archived.map((skill) => skill.id),
    [sk.id],
  );
  assert.deepEqual(await built.app.listSkills({ archivedFor: "bob@acme.com" }), []);
});
