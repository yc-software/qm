import assert from "node:assert/strict";
import test from "node:test";
import { comments, isProduction, stripComments } from "../../scripts/strip-comments.ts";

test("script comments go, directives, strings, regexes and JSX text stay", () => {
  const source = [
    "#!/usr/bin/env node",
    '/// <reference types="node" />',
    "/** Docs. */",
    'export const url = "http://x"; // trailing',
    "const re = /\\/\\/ not a comment/;",
    "// eslint-disable-next-line no-console",
    "const pure = /*#__PURE__*/ make();",
    "const view = <p>// shown {/* hidden */}</p>;",
    "const sum = a/* gap */+b;",
    "",
  ].join("\n");
  const expected = [
    "#!/usr/bin/env node",
    '/// <reference types="node" />',
    'export const url = "http://x";',
    "const re = /\\/\\/ not a comment/;",
    "// eslint-disable-next-line no-console",
    "const pure = /*#__PURE__*/ make();",
    "const view = <p>// shown {}</p>;",
    "const sum = a +b;",
    "",
  ].join("\n");
  assert.equal(stripComments("a.tsx", source), expected);
  assert.equal(stripComments("a.tsx", expected), expected);
});

test("SQL and CSS comments go, quoted and dollar-quoted text stays", () => {
  assert.equal(stripComments("e.sql", "SELECT E'it\\'s -- x' -- real\n"), "SELECT E'it\\'s -- x'\n");
  const sql =
    "-- header\nSELECT '--kept' AS a, \"x--y\" /* gone /* nested */ */ FROM t;\nDO $$ BEGIN -- body\nEND $$;\n";
  assert.equal(stripComments("a.sql", sql), "SELECT '--kept' AS a, \"x--y\" FROM t;\nDO $$ BEGIN -- body\nEND $$;\n");
  assert.equal(stripComments("a.css", '/* gone */\na { content: "/* kept */"; }\n'), 'a { content: "/* kept */"; }\n');
});

test("tests, vendored code and docs are not production", () => {
  assert.deepEqual(
    [
      "src/a.ts",
      "src/a.test.ts",
      "test/a.ts",
      "src/deploy/vendor/devbar.js",
      "docs/x.ts",
      "src/turns/absurd.sql",
      "plugins/x/y.css",
    ].filter(isProduction),
    ["src/a.ts", "plugins/x/y.css"],
  );
  assert.equal(comments("a.ts", "// @ts-expect-error\nconst a = 1;").length, 0);
});
