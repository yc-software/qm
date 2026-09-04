import test from "node:test";
import assert from "node:assert/strict";
import { planIngest, importPack, type FetchedRepo } from "../src/skills/ingest.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createSkillPackStore } from "../src/skills/skill-pack-store.ts";
import { scopeId } from "../src/types.ts";

const md = (front: string, body = "# Body\ntext") => `---\n${front}\n---\n${body}`;

function repo(): FetchedRepo {
  const f = (path: string, text: string, binary = false) => ({ path, text, binary });
  return {
    commit: "abc1234",
    files: [
      f("skills/company-directory/SKILL.md", md("name: company-directory\ndescription: d\nscope: company")),
      f("skills/both-skill/SKILL.md", md("name: both-skill\ndescription: d\nscope: both")),
      f("skills/with-asset/SKILL.md", md("name: with-asset\ndescription: d\nscope: company")),
      f("skills/with-asset/scripts/foo.py", "print('hi')"),
      f("skills/personal-skill/SKILL.md", md("name: personal-skill\ndescription: d\nscope: personal")),
      f("skills/no-scope/SKILL.md", md("name: no-scope\ndescription: d")),
      f("skills/private-skill/SKILL.md", md("name: private-skill\ndescription: d\nscope: company\nprivate: true")),
      f("skills/publish/SKILL.md", md("name: publish\ndescription: d\nscope: company")),
      f("skills/with-binary/SKILL.md", md("name: with-binary\ndescription: d\nscope: company")),
      f("skills/with-binary/logo.png", "\\u0000PNGDATA", true),
      f("skills/malformed/SKILL.md", "no frontmatter here"),
      f("trusted/stalker-watch/SKILL.md", md("name: stalker-watch\ndescription: d\nscope: company")),
    ],
  };
}

const ctx = { config: { exclude: ["trusted/*"] }, nativeNames: new Set(["publish"]) };

test("planIngest classifies eligibility with reasons and excludes by config", () => {
  const { candidates, counts } = planIngest(repo(), ctx);
  const by = (n: string) => candidates.find((c) => c.upstreamName === n);

  assert.equal(by("stalker-watch"), undefined);

  assert.equal(by("company-directory")!.eligible, true);
  assert.equal(by("both-skill")!.eligible, true);
  assert.equal(by("with-asset")!.eligible, true);
  assert.equal(by("no-scope")!.eligible, true);
  assert.equal(by("personal-skill")!.excludeReason, "scope");
  assert.equal(by("private-skill")!.excludeReason, "private");
  assert.equal(by("publish")!.excludeReason, "collision");
  assert.equal(by("with-binary")!.excludeReason, "binary-asset");
  assert.equal(by("malformed")!.excludeReason, "malformed");

  assert.equal(counts.eligible, 4);
  assert.equal(counts.scope, 1);
  assert.equal(counts.private, 1);
  assert.equal(counts.collision, 1);
  assert.equal(counts["binary-asset"], 1);
  assert.equal(counts.malformed, 1);
});

test("importPack publishes eligible skills with provenance + assets; native publish untouched", async () => {
  const store = createSkillStore();
  const org = scopeId("org", "acme");
  const native = await store.create({
    scopeId: org,
    manifest: { name: "publish", description: "native", requiredCapabilities: [], body: "# native" },
    createdBy: "system:skills-seed",
  });
  await store.review(native.id, "system:skills-reviewer", []);
  await store.publish(native.id);

  const packs = createSkillPackStore();
  const pack = await packs.create({
    kind: "git",
    url: "u",
    ref: "abc1234",
    syncMode: "pinned",
    trustTier: "third-party",
    config: { exclude: ["trusted/*"] },
    targetScopeId: org,
    subset: "all",
    createdBy: "u1",
  });

  const res = await importPack(repo(), store, { pack, selected: "all", nativeNames: new Set(["publish"]) });
  assert.deepEqual(res.imported.sort(), ["both-skill", "company-directory", "no-scope", "with-asset"]);

  const published = (await store.list()).filter((s) => s.status === "published");
  const imported = published.find((s) => s.manifest.name === "with-asset")!;
  assert.equal(imported.createdBy, `pack:${pack.id}`);
  assert.deepEqual(imported.pack, { packId: pack.id, commit: "abc1234", upstreamName: "with-asset" });
  assert.deepEqual(imported.manifest.files, [{ path: "scripts/foo.py", content: "print('hi')" }]);

  const pub = published.find((s) => s.manifest.name === "publish" && s.createdBy === "system:skills-seed")!;
  assert.equal(pub.manifest.description, "native");
});

test("re-import is idempotent (all skipped on the second run)", async () => {
  const store = createSkillStore();
  const packs = createSkillPackStore();
  const pack = await packs.create({
    kind: "git",
    url: "u",
    ref: "abc1234",
    syncMode: "pinned",
    trustTier: "third-party",
    config: { exclude: ["trusted/*"] },
    targetScopeId: scopeId("org", "acme"),
    subset: "all",
    createdBy: "u1",
  });
  const nativeNames = new Set<string>();
  const first = await importPack(repo(), store, { pack, selected: "all", nativeNames });
  assert.ok(first.imported.includes("publish"));
  const second = await importPack(repo(), store, { pack, selected: "all", nativeNames });
  assert.deepEqual(second.imported, []);
  assert.equal(second.skipped.length, first.imported.length);
});

test("a shared bundle cannot clobber a skill record in another scope", async () => {
  const store = createSkillStore();
  const packs = createSkillPackStore();
  const pack = await packs.create({
    kind: "git",
    url: "u",
    ref: "abc1234",
    syncMode: "pinned",
    trustTier: "third-party",
    targetScopeId: scopeId("personal", "alice"),
    subset: "all",
    createdBy: "u1",
  });
  const claimedBundlePaths = new Map([["skills/existing/helpers/run.ts", "skill existing in org:acme"]]);

  await assert.rejects(
    importPack(repo(), store, {
      pack,
      selected: "all",
      nativeNames: new Set(),
      claimedBundlePaths,
      bundleFiles: [{ path: "skills/existing/helpers/run.ts", content: "clobber" }],
    }),
    /skills\/existing\/helpers\/run\.ts \(owned by skill existing in org:acme\)/,
  );
  assert.equal((await store.list()).length, 0);
});

test("a shared bundle cannot write core materialization markers", async () => {
  const store = createSkillStore();
  const packs = createSkillPackStore();
  const pack = await packs.create({
    kind: "git",
    url: "u",
    ref: "abc1234",
    syncMode: "pinned",
    trustTier: "third-party",
    targetScopeId: scopeId("org", "acme"),
    subset: "all",
    createdBy: "u1",
  });

  await assert.rejects(
    importPack(repo(), store, {
      pack,
      selected: "all",
      nativeNames: new Set(),
      bundleFiles: [{ path: "skills/company-directory/.tree", content: "forged" }],
    }),
    /skills\/company-directory\/\.tree \(owned by core skill materialization metadata\)/,
  );
  assert.equal((await store.list()).length, 0);
});
