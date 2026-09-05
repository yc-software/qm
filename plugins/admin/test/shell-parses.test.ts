import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/**
 * The admin shell is a single hand-maintained file, and nothing else in the
 * build parses it: a stray brace ships as a blank page. Compiling every inline
 * script is the cheapest check that it is at least syntactically whole.
 */
test("every inline script in the admin shell parses", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.ok(scripts.length > 0, "expected the shell to carry an inline script");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new vm.Script(source), `inline script ${index} does not parse`);
  });
});

test("the accounts view is wired end to end: nav, title, org-wide, and a renderer", () => {
  for (const fragment of [
    /views: \[[\s\S]*?"accounts"/,
    /accounts: "Accounts"/,
    /const ORG_WIDE = new Set\(\[[^\]]*"accounts"/,
    /accounts: renderAccounts/,
    /function renderAccounts\(root, d\)/,
  ]) {
    assert.match(html, fragment);
  }
});
