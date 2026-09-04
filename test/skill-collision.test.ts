import { test } from "node:test";
import assert from "node:assert/strict";
import {
  skillRecordPaths,
  persistedSkillRecordPaths,
  detectPathCollisions,
  materializationControlPathCollisions,
  SkillPackCollisionError,
} from "../src/skills/skill-collision.ts";

test("skillRecordPaths mirrors materialize's validated skills/<name>/ layout", () => {
  assert.deepEqual(
    skillRecordPaths("My-Skill", [{ path: "scripts/x.py", content: "" }]).sort(),
    ["skills/My-Skill/.tree", "skills/My-Skill/SKILL.md", "skills/My-Skill/scripts/x.py"],
    "files land under the validated name (same as materialize)",
  );
  assert.throws(() => skillRecordPaths("My Skill", []), /skill name must/);
});

test("materialization marker paths are reserved from shared bundles", () => {
  assert.deepEqual(
    materializationControlPathCollisions([
      "lib/ok.mjs",
      "skills/.index",
      "skills/alpha/.tree",
      "skills/alpha/.tree/child",
    ]),
    [
      { path: "skills/.index", owner: "core skill materialization metadata" },
      { path: "skills/alpha/.tree", owner: "core skill materialization metadata" },
      { path: "skills/alpha/.tree/child", owner: "core skill materialization metadata" },
    ],
  );
});

test("persistedSkillRecordPaths quarantines a legacy unsafe name without inventing a path", () => {
  assert.deepEqual(persistedSkillRecordPaths("My Skill", [{ path: "asset.txt", content: "x" }]), []);
  assert.throws(() => skillRecordPaths("My Skill", []), /skill name must/);
});

test("detectPathCollisions flags incoming paths an owner already claims (de-duped, order-stable)", () => {
  const claimed = new Map([
    ["lib/cite.mjs", "pack:A"],
    ["skills/x/SKILL.md", "seed"],
  ]);
  const hits = detectPathCollisions(["lib/cite.mjs", "lib/new.mjs", "lib/cite.mjs", "skills/x/SKILL.md"], claimed);
  assert.deepEqual(hits, [
    { path: "lib/cite.mjs", owner: "pack:A" },
    { path: "skills/x/SKILL.md", owner: "seed" },
  ]);
});

test("detectPathCollisions returns nothing when footprints are disjoint", () => {
  assert.deepEqual(detectPathCollisions(["lib/a.mjs"], new Map([["lib/b.mjs", "pack:A"]])), []);
});

test("SkillPackCollisionError summarizes the conflicts (and carries them)", () => {
  const err = new SkillPackCollisionError([{ path: "lib/cite.mjs", owner: "pack:A" }]);
  assert.match(err.message, /clobber 1 existing path/);
  assert.match(err.message, /lib\/cite\.mjs \(owned by pack:A\)/);
  assert.equal(err.collisions.length, 1);
});
