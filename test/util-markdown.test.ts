import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteAppLinks } from "../src/util/markdown.ts";

test("published app links resolve against the portal without rewriting code or external URLs", () => {
  assert.equal(
    absoluteAppLinks("[Pirates](/d/pirates/) [Other](https://example.com) `[/d/x/](/d/x/)`", "https://qm.example.com"),
    "[Pirates](https://qm.example.com/d/pirates/) [Other](https://example.com) `[/d/x/](/d/x/)`",
  );
  assert.equal(absoluteAppLinks("[Pirates](/d/pirates/)", undefined), "[Pirates](/d/pirates/)");
});

test("app links preserve tilde fences and multi-backtick code spans", () => {
  for (const text of ["~~~md\n[x](/d/x/)\n~~~", "``[x](/d/x/)``", "````md\n[x](/d/x/)\n````"]) {
    assert.equal(absoluteAppLinks(text, "https://qm.example.com"), text);
  }
});

test("app links stay linear-time on pathological backtick, bracket, and link floods", () => {
  const floods = ["`".repeat(40_000), "\t" + "[)".repeat(10_000), "[a](/d/".repeat(6_000)];
  const started = performance.now();
  for (const text of floods) assert.equal(absoluteAppLinks(text, "https://qm.example.com"), text);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `floods took ${Math.round(elapsed)}ms`);
});

test("app links are rewritten outside code and left alone inside an unclosed fence", () => {
  assert.equal(
    absoluteAppLinks("see [a [b](/d/b) and ``x ` [c](/d/c)`` then [d](/d/d)", "https://qm.example.com"),
    "see [a [b](https://qm.example.com/d/b) and ``x ` [c](/d/c)`` then [d](https://qm.example.com/d/d)",
  );
  assert.equal(absoluteAppLinks("```\n[x](/d/x/)", "https://qm.example.com"), "```\n[x](/d/x/)");
});

test("app link fences close on a same-mark run at least as long as the opener, indented up to three spaces", () => {
  assert.equal(
    absoluteAppLinks("```js\n[a](/d/a)\n````\n[b](/d/b)", "https://qm.example.com"),
    "```js\n[a](/d/a)\n````\n[b](https://qm.example.com/d/b)",
  );
  assert.equal(
    absoluteAppLinks(" ```\n[a](/d/a)\n ```\n[b](/d/b)", "https://qm.example.com"),
    " ```\n[a](/d/a)\n ```\n[b](https://qm.example.com/d/b)",
  );
  assert.equal(
    absoluteAppLinks("~~~\n[a](/d/a)\n```\n[b](/d/b)", "https://qm.example.com"),
    "~~~\n[a](/d/a)\n```\n[b](/d/b)",
  );
});

test("a code span inside a link label does not stop the link from resolving", () => {
  assert.equal(
    absoluteAppLinks("see [`a`](/d/1) and `[b](/d/2)`", "https://qm.example.com"),
    "see [`a`](https://qm.example.com/d/1) and `[b](/d/2)`",
  );
});
