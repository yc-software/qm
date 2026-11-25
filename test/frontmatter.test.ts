import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, parseSeedSkillFrontmatter } from "../src/skills/frontmatter.ts";

test("parses plain, quoted, and escaped YAML scalars", () => {
  const { attrs, body } = parseFrontmatter(`---
name: demo # trailing comment
description: "Write a \\"quoted\\" note\\nwith escapes"
other: 'it''s single quoted'
---
# Body
text`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, 'Write a "quoted" note\nwith escapes');
  assert.equal(attrs.other, "it's single quoted");
  assert.match(body, /^# Body/);
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

test("parses inline flow arrays, including commas inside quotes", () => {
  const { attrs } = parseFrontmatter(`---
sync_targets: ["a, b", zion]
empty: []
---
body`);
  assert.deepEqual(attrs.sync_targets, ["a, b", "zion"]);
  assert.deepEqual(attrs.empty, []);
});

test("folds > block scalars and keeps newlines for |, including indented ---", () => {
  const { attrs } = parseFrontmatter(`---
description: >-
  Track and identify
  real-name individuals.
literal: |-
  line one
  ---
  line two
---
body`);
  assert.equal(attrs.description, "Track and identify real-name individuals.");
  assert.equal(attrs.literal, "line one\n---\nline two");
});

test("parses nested mappings and rejects malformed YAML or non-mapping roots", () => {
  const { attrs } = parseFrontmatter(`---
name: demo
metadata:
  nested: value
  deeper:
    x: 1
description: ok
---
body`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, "ok");
  assert.deepEqual(attrs.metadata, { nested: "value", deeper: { x: 1 } });
  assert.throws(() => parseFrontmatter("---\nname: demo\nweird line without a colon\ndescription: ok\n---\nbody"));
  assert.throws(() => parseFrontmatter("---\n- a\n- b\n---\nbody"), /expected a YAML mapping/);
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

test("throws on a missing or unclosed fence, and ignores non-fence --- lines", () => {
  assert.throws(() => parseFrontmatter("no fence here"));
  assert.throws(() => parseFrontmatter("---\nname: x\nnever closed"));
  assert.throws(() => parseFrontmatter("---\nname: x\n---not-a-fence\nbody"));
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
