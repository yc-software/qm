import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("a thread pick that only mirrored the old default follows a new default", () => {
  assert.match(composer, /followDefault\(defaults\);\n\s+\}\n\s+defaults = next;/);
  assert.match(composer, /picked\.model\.id !== previous\.modelId\) return;\n\s+forgetThreadPick\(threadRef\);/);
});

test("runtime settings revalidate after each turn and when the tab regains focus", () => {
  assert.match(
    chat,
    /refreshTranscriptFromEntries\(agent\);\n\s+void ctx\.composer\.refreshRuntimeSelection\(scopeId, agent, true\);/,
  );
  assert.match(composer, /addEventListener\("visibilitychange", revalidateRuntime\)/);
  assert.match(composer, /removeEventListener\("visibilitychange", revalidateRuntime\)/);
});
