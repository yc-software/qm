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

test("skillGlobs match the SKILL.md path as well as the skill directory", () => {
  const nativeNames = new Set<string>();

  const byPath = planIngest(repo(), { config: { skillGlobs: ["skills/*/SKILL.md"] }, nativeNames });
  assert.equal(byPath.counts.total, 9, "a glob written against the file the pattern names selects every skill");
  assert.equal(byPath.counts.filtered, 1, "and the one outside skills/ is reported as filtered, not as absent");

  const byDir = planIngest(repo(), { config: { skillGlobs: ["skills/*"] }, nativeNames });
  assert.equal(byDir.counts.total, 9, "a glob written against the directory keeps working unchanged");
  assert.equal(byDir.counts.filtered, 1);

  const neither = planIngest(repo(), { config: { skillGlobs: ["packs/*"] }, nativeNames });
  assert.equal(neither.counts.total, 0);
  assert.equal(
    neither.counts.filtered,
    10,
    "a filter that matches nothing says so rather than looking like an empty repository",
  );
});

test("an empty repository and a filtered-out one are distinguishable", () => {
  const nativeNames = new Set<string>();
  const empty = planIngest({ commit: "abc", files: [] }, { nativeNames });

  assert.equal(empty.counts.total, 0);
  assert.equal(empty.counts.filtered, 0, "nothing was filtered because there was nothing to filter");

  const filtered = planIngest(repo(), { config: { skillGlobs: ["nope/*"] }, nativeNames });
  assert.equal(filtered.counts.total, 0);
  assert.notEqual(filtered.counts.filtered, 0);
});

test("exclude is counted as filtered too", () => {
  const { counts } = planIngest(repo(), { config: { exclude: ["trusted/*"] }, nativeNames: new Set<string>() });
  assert.equal(counts.filtered, 1);
  assert.equal(counts.total, 9);
});

test("exclude matches a skill by ancestor and by SKILL.md path, as it already did for bundle files", () => {
  const nativeNames = new Set<string>();
  const byAncestor = planIngest(repo(), { config: { exclude: ["trusted"] }, nativeNames });
  assert.equal(
    byAncestor.candidates.find((c) => c.upstreamName === "stalker-watch"),
    undefined,
    "a bare directory name excludes the skill under it, not only its bundle files",
  );
  assert.equal(byAncestor.counts.filtered, 1);

  const byManifest = planIngest(repo(), { config: { exclude: ["trusted/*/SKILL.md"] }, nativeNames });
  assert.equal(
    byManifest.candidates.find((c) => c.upstreamName === "stalker-watch"),
    undefined,
  );
  assert.equal(byManifest.counts.filtered, 1);
});

test("a directory-shaped glob is not widened by the SKILL.md leniency", () => {
  const { counts } = planIngest(repo(), { config: { skillGlobs: ["skills/*/*"] }, nativeNames: new Set<string>() });
  assert.equal(counts.total, 0, "no skill sits at that depth, and none is admitted by its manifest path");
  assert.equal(counts.filtered, 10);
});

test("exclude is normalized like skillGlobs, so a file-shaped glob does not uninstall the pack", () => {
  const nativeNames = new Set<string>();

  const docs = planIngest(repo(), { config: { exclude: ["**/*.md"] }, nativeNames });
  assert.equal(docs.counts.total, 10, "stripping .md out of the bundle leaves every skill selected");
  assert.equal(docs.counts.filtered, 0);

  const deeper = planIngest(repo(), { config: { exclude: ["skills/*/*"] }, nativeNames });
  assert.equal(deeper.counts.total, 10, "a depth-2 glob does not reach a skill at depth 1 through its manifest");
  assert.equal(deeper.counts.filtered, 0);
});

test("a bare SKILL.md glob selects the repository-root skill", () => {
  const rootRepo = {
    commit: "abc1234",
    files: [
      { path: "SKILL.md", text: md("name: root-skill\ndescription: d\nscope: company"), binary: false },
      { path: "skills/other/SKILL.md", text: md("name: other\ndescription: d\nscope: company"), binary: false },
    ],
  };
  const { counts, candidates } = planIngest(rootRepo, {
    config: { skillGlobs: ["SKILL.md"] },
    nativeNames: new Set<string>(),
  });
  assert.equal(counts.total, 1);
  assert.equal(counts.filtered, 1, "and the one under skills/ is filtered, not silently absent");
  assert.equal(candidates[0]!.skillPath, "SKILL.md");
});

test("an empty skillGlobs means unset rather than nothing", () => {
  const { counts } = planIngest(repo(), { config: { skillGlobs: [] }, nativeNames: new Set<string>() });
  assert.equal(counts.total, 10, "an empty allowlist does not silently uninstall the pack");
  assert.equal(counts.filtered, 0);
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
