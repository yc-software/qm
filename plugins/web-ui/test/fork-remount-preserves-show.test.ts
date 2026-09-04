import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

// A same-session readonly remount (delivery refresh, earlier pages) must not
// reset the fork-origin controller: reset bumps the toggle generation and
// discards an in-flight multi-page "show" load with no error.
test("readonly remount resets the fork-origin controller only when the session changes", () => {
  assert.match(
    chat,
    /const sameSession = chatState\.sessionId === s\.id && chatState\.threadRef === null;\s*if \(!sameSession\) forkOriginController\.reset\(\);/,
  );
});
