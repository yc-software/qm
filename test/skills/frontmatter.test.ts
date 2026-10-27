import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, parseSeedSkillFrontmatter } from "../../src/skills/frontmatter.ts";

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

test("folds a > block scalar into one line; keeps newlines for |, with YAML clip chomping", () => {
  const { attrs } = parseFrontmatter(`---
description: >
  Track and identify
  real-name individuals.
literal: |
  line one
  line two
---
body`);
  assert.equal(attrs.description, "Track and identify real-name individuals.\n");
  assert.equal(attrs.literal, "line one\nline two\n");
});

test("keeps nested maps and reads every scalar as a string", () => {
  const { attrs } = parseFrontmatter(`---
name: demo
private: true
version: 1.10
metadata:
  nested: value
  deeper:
    x: 1
description: ok
---
body`);
  assert.equal(attrs.private, "true");
  assert.equal(attrs.version, "1.10");
  assert.deepEqual(attrs.metadata, { nested: "value", deeper: { x: "1" } });
});

test("reads YAML quoting, escapes, comments, and multiline scalars", () => {
  const { attrs } = parseFrontmatter(`---
name: demo # trailing comment
description: "Use when: the user asks
  about a # sign"
single: 'it''s fine'
escaped: "tab\\there"
plain: first line
  continues here
capabilities: ["egress:example.com", 'a, b']
unindented:
- one
- two
---
body`);
  assert.equal(attrs.name, "demo");
  assert.equal(attrs.description, "Use when: the user asks about a # sign");
  assert.equal(attrs.single, "it's fine");
  assert.equal(attrs.escaped, "tab\there");
  assert.equal(attrs.plain, "first line continues here");
  assert.deepEqual(attrs.capabilities, ["egress:example.com", "a, b"]);
  assert.deepEqual(attrs.unindented, ["one", "two"]);
});

test("throws on frontmatter that is not valid YAML", () => {
  assert.throws(
    () => parseFrontmatter("---\nname: demo\ndescription: Use when: x\n---\nbody"),
    /^Error: frontmatter is not valid YAML: /,
  );
  assert.throws(() => parseFrontmatter("---\nname: a\nname: b\n---\nbody"));
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

test("seed skills report the field that is missing or mistyped", () => {
  assert.throws(() => parseSeedSkillFrontmatter("---\ndescription: d\n---\nbody"), /^Error: seed skill requires name$/);
  assert.throws(
    () => parseSeedSkillFrontmatter("---\nname: a\n---\nbody"),
    /^Error: seed skill a requires description$/,
  );
  assert.throws(
    () => parseSeedSkillFrontmatter("---\nname: a\ndescription: d\nrequiredCapabilities: one, two\n---\nbody"),
    /^Error: seed skill a requiredCapabilities must be a list of strings$/,
  );
  assert.throws(
    () => parseSeedSkillFrontmatter("---\nname: a\ndescription: d\n---\n  \n"),
    /^Error: seed skill a requires a body$/,
  );
  assert.deepEqual(parseSeedSkillFrontmatter("---\nname: a\ndescription: |\n  d\n---\nbody"), {
    name: "a",
    description: "d",
    requiredCapabilities: [],
    body: "body",
  });
});

test("an empty requiredCapabilities value reads as no capabilities", () => {
  assert.deepEqual(
    parseSeedSkillFrontmatter("---\nname: a\ndescription: d\nrequiredCapabilities:\n---\nbody").requiredCapabilities,
    [],
  );
});
