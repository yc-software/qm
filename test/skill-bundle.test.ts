import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSharedBundle, type FetchedRepo } from "../src/skills/ingest.ts";
import { computeBundleHash, createSkillBundleStore } from "../src/skills/skill-bundle-store.ts";
import type { SkillFile } from "../src/skills/skill-store.ts";

function repo(files: Array<[string, string, boolean?]>): FetchedRepo {
  return { commit: "c1", files: files.map(([path, text, binary]) => ({ path, text, binary: binary ?? false })) };
}

const examplesShaped = repo([
  ["skills/gmail/SKILL.md", "gmail body"],
  ["skills/gmail/helper.mjs", "own-folder helper"],
  ["skills/enrich/SKILL.md", "enrich body"],
  ["lib/cite.mjs", "cite"],
  ["skills/conventions/quality.md", "quality"],
  ["skills/WorkspaceBridge/cv.mjs", "cv"],
  ["trusted/private-investigator/SKILL.md", "PI"],
  ["trusted/notes.md", "secret"],
  ["assets/logo.png", "", true],
]);

test("collectSharedBundle keeps only files outside any skill dir, minus excluded + binary", () => {
  const paths = collectSharedBundle(examplesShaped, { exclude: ["trusted/*"] }).map((f) => f.path);
  assert.deepEqual(
    [...paths].sort(),
    ["lib/cite.mjs", "skills/WorkspaceBridge/cv.mjs", "skills/conventions/quality.md"],
    "shared = lib/ + non-skill dirs under skills/; not skill-folder files, not trusted/*, not binary",
  );
  assert.ok(!paths.includes("skills/gmail/helper.mjs"), "a skill's own-folder file is not shared");
  assert.ok(!paths.some((p) => p.startsWith("trusted/")), "excluded dir contents never reach the bundle");
});

test("collectSharedBundle drops loose files under an excluded dir at any depth (ancestor-aware)", () => {
  const r = repo([
    ["skills/a/SKILL.md", "A"],
    ["trusted/deep/sub/secret.md", "x"],
    ["lib/keep.mjs", "k"],
  ]);
  const paths = collectSharedBundle(r, { exclude: ["trusted/*"] }).map((f) => f.path);
  assert.deepEqual(
    paths,
    ["lib/keep.mjs"],
    "trusted/deep/sub/secret.md is excluded by ancestor match, not just trusted/*",
  );
});

test("collectSharedBundle returns nothing for a repo-root SKILL.md (the whole repo is one skill)", () => {
  const r = repo([
    ["SKILL.md", "root skill"],
    ["scripts/run.mjs", "x"],
  ]);
  assert.deepEqual(collectSharedBundle(r), [], "no shared bundle when the repo root itself is a skill");
});

test("collectSharedBundle is empty for a self-contained repo (every file under a skill dir)", () => {
  const r = repo([
    ["skills/a/SKILL.md", "A"],
    ["skills/a/scripts/x.py", "x"],
    ["skills/b/SKILL.md", "B"],
  ]);
  assert.deepEqual(collectSharedBundle(r), [], "self-contained repos need no shared bundle");
});

test("collectSharedBundle drops generic repo metadata (.gitignore/README/LICENSE/.github/.claude-plugin/.claude) so unrelated packs don't collide on them", () => {
  const r = repo([
    ["skills/a/SKILL.md", "A"],
    ["lib/keep.mjs", "k"],
    [".gitignore", "node_modules"],
    ["README.md", "# repo"],
    ["LICENSE", "MIT"],
    [".github/workflows/ci.yml", "ci"],
    [".claude-plugin/marketplace.json", "{}"],
    [".claude/settings.json", "{}"],
    ["skills/conventions/quality.md", "q"],
  ]);
  const paths = collectSharedBundle(r)
    .map((f) => f.path)
    .sort();
  assert.deepEqual(
    paths,
    ["lib/keep.mjs", "skills/conventions/quality.md"],
    "only skill-supporting files; generic repo metadata is excluded",
  );
  assert.ok(
    !paths.includes(".gitignore") && !paths.includes("README.md") && !paths.includes("LICENSE"),
    "two unrelated packs would otherwise both claim these generic paths and collide",
  );
  assert.ok(
    !paths.some((p) => p.startsWith(".claude-plugin/") || p.startsWith(".claude/")),
    "Claude plugin/config metadata is excluded — two skill repos must not collide on .claude-plugin/marketplace.json",
  );
});

test("computeBundleHash is stable under reordering and busts on content change", () => {
  const a: SkillFile = { path: "lib/x.mjs", content: "1" };
  const b: SkillFile = { path: "lib/y.mjs", content: "2" };
  assert.equal(computeBundleHash([a, b]), computeBundleHash([b, a]), "order-independent");
  assert.notEqual(
    computeBundleHash([a, b]),
    computeBundleHash([a, { ...b, content: "changed" }]),
    "content change busts",
  );
});

test("SkillBundleStore get/put/delete/list round-trips by packId", async () => {
  const store = createSkillBundleStore();
  const files: SkillFile[] = [{ path: "lib/x.mjs", content: "1" }];
  await store.put({ packId: "s1", commit: "c1", files, hash: computeBundleHash(files) });
  assert.equal((await store.get("s1"))?.commit, "c1");
  assert.equal((await store.list()).length, 1);
  await store.delete("s1");
  assert.equal(await store.get("s1"), null);
});
