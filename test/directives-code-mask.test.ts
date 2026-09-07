import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDirectives } from "../src/slack/directives.ts";

test("captured directive groups are unmasked, so quoted code never leaves as a placeholder", () => {
  const reply = "Sure.\n@agent please run `npm test` and report\nThanks";
  const { text, matches } = extractDirectives(reply, /^@agent (.+)$/gm, /$^/, (groups) => groups[0]);
  assert.deepEqual(matches, ["please run `npm test` and report"]);
  assert.equal(text, "Sure.\n\nThanks");
  assert.ok(!matches[0]!.includes("\u0000"));
});
