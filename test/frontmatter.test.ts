import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, parseSeedSkillFrontmatter } from "../src/skills/frontmatter.ts";

test("parses plain and quoted scalars", () => {
  const { attrs, body } = parseFrontmatter(`---
name: demo
description: "a quoted desc"
other: 'single quoted'
---
# Body
text`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, "a quoted desc");
  assert.equal(attrs.other, "single quoted");
  assert.match(body as string, /^# Body/);
});

test("parses block lists (key:\\n  - item)", () => {
  const { attrs } = parseFrontmatter(`---
name: demo
requiredCapabilities:
  - egress:example.com
  - command:demo
---
body`);
  assert.deepEqual(attrs.requiredCapabilities, ["egress:example.com", "command:demo"]);
});

test("parses inline flow arrays", () => {
  const { attrs } = parseFrontmatter(`---
sync_targets: [atlas, zion]
empty: []
---
body`);
  assert.deepEqual(attrs.sync_targets, ["atlas", "zion"]);
  assert.deepEqual(attrs.empty, []);
});

test("folds a > block scalar into one line; keeps newlines for |", () => {
  const { attrs } = parseFrontmatter(`---
description: >
  Track and identify
  real-name individuals.
literal: |
  line one
  line two
---
body`);
  assert.equal(attrs.description, "Track and identify real-name individuals.");
  assert.equal(attrs.literal, "line one\nline two");
});

test("tolerates unknown / nested shapes instead of throwing", () => {
  const { attrs } = parseFrontmatter(`---
name: demo
metadata:
  nested: value
  deeper:
    x: 1
weird line without a colon
description: ok
---
body`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, "ok");
  assert.deepEqual(attrs.metadata, []);
});

test("skips comments and blank lines", () => {
  const { attrs } = parseFrontmatter(`---
# a comment
name: demo

description: ok
---
body`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, "ok");
});

test("throws on a missing or unclosed fence (the structural contract)", () => {
  assert.throws(() => parseFrontmatter("no fence here"));
  assert.throws(() => parseFrontmatter("---\nname: x\nnever closed"));
});

test("accepts a BOM and CRLF without changing the body line endings", () => {
  const parsed = parseFrontmatter("\uFEFF---\r\nname: demo\r\ndescription: test\r\n---\r\nline one\r\nline two\r\n");
  assert.equal(parsed.attrs.name, "demo");
  assert.equal(parsed.body, "line one\r\nline two\r\n");
});

test("seed skill names cannot escape or alias their materialized directory", () => {
  const skill = (name: string) => `---\nname: ${name}\ndescription: test\n---\nbody`;
  for (const name of ["..", ".", "foo/bar", "foo\\bar", "foo bar", ".hidden", "foo."]) {
    assert.throws(() => parseSeedSkillFrontmatter(skill(name)), /skill name must/);
  }
  assert.equal(parseSeedSkillFrontmatter(skill("foo-bar_v1.2")).name, "foo-bar_v1.2");
});

test("drops unquoted inline comments but keeps # inside quotes or words", () => {
  const { attrs } = parseFrontmatter(`---
name: demo # human-readable note
description: "a # inside quotes" # trailing note
tag: c#sharp
joined: foo# bar
caps: [one, two] # why
folded: > # note
  folded body
empty: # nothing left
list:
  - command:demo # why
---
body`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, "a # inside quotes");
  assert.equal(attrs.tag, "c#sharp");
  assert.equal(attrs.joined, "foo# bar");
  assert.deepEqual(attrs.caps, ["one", "two"]);
  assert.equal(attrs.folded, "folded body");
  assert.deepEqual(attrs.empty, []);
  assert.deepEqual(attrs.list, ["command:demo"]);
});

test("a commented-out value is missing, not a literal comment", () => {
  assert.throws(() => parseSeedSkillFrontmatter("---\nname: # note\ndescription: d\n---\nbody"), /requires name/);
  assert.equal(parseSeedSkillFrontmatter("---\nname: demo # note\ndescription: d # note\n---\nbody").name, "demo");
});

test("a # inside quotes (with escapes, doubling, or an unclosed quote) is not a comment", () => {
  const { attrs } = parseFrontmatter(`---
escaped: "He said \\"go\\" # really"
doubled: 'it''s # fine'
unclosed: use 'em all # note
caps:
  - one # why
  - # dropped
  - two
---
body`);
  assert.equal(attrs.escaped, 'He said \\"go\\" # really');
  assert.equal(attrs.doubled, "it''s # fine");
  assert.equal(attrs.unclosed, "use 'em all");
  assert.deepEqual(attrs.caps, ["one", "two"]);
});

test("inline comment stripping stays linear on long scalars", () => {
  const value = `a${" ".repeat(200_000)}${'\\"'.repeat(100_000)}b`;
  const started = performance.now();
  const { attrs } = parseFrontmatter(`---\nname: demo\ndescription: "${value}"\n---\nbody`);
  assert.ok(performance.now() - started < 2_000, "parseFrontmatter must not backtrack on long scalars");
  assert.equal(attrs.description, value);
});
