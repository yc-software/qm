import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");

const resetDetail = shell.match(/function resetActiveDetail\(v: View\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
const refresh = shell.match(/function refreshActiveView\(v: View\): void \{[\s\S]*?\n\}/)?.[0] ?? "";

test("pressing the nav entry for the view you are already on drops back to its index", () => {
  assert.match(refresh, /^\s*resetActiveDetail\(v\);/m);
  assert.match(refresh, /syncUrlFromState\(\);/);
});

test("every view with a detail page clears it, so no nav entry is a no-op", () => {
  for (const [view, reset] of [
    ["inbox", "resetActiveInboxItem"],
    ["webhooks", "resetActiveWebhook"],
    ["crons", "resetActiveCron"],
    ["loops", "resetActiveLoop"],
    ["skills", "resetActiveSkill"],
  ]) {
    assert.match(resetDetail, new RegExp(String.raw`case "${view}":\s*${reset}\(\);`), `${view} keeps its detail open`);
  }
});

test("arriving from another view and re-pressing the nav entry share one reset", () => {
  assert.equal(shell.match(/resetActiveDetail\(v\);/g)?.length, 2);
  const switcher = shell.match(/export function switchView\(v: View\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(switcher, /resetActiveDetail\(v\);/);
  for (const reset of ["resetActiveWebhook", "resetActiveCron", "resetActiveLoop", "resetActiveSkill"]) {
    assert.doesNotMatch(
      switcher,
      new RegExp(String.raw`${reset}\(\);`),
      `${reset} should only run via resetActiveDetail`,
    );
  }
});

test("a deep link still wins: the reset clears the selection but never the pending item", () => {
  const reset = inbox.match(/export function resetActiveInboxItem\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reset, /fullSurface\.selectedId = null;/);
  assert.doesNotMatch(reset, /pendingItemId/);
  assert.match(
    shell,
    /if \(wanted === "inbox" && wantedItem\) openInboxItemById\(wantedItem\);\s*\n\s*.*\n?\s*switchView\(wanted as View\);/,
  );
});

test("closing an item from the page and from the nav both persist the draft first", () => {
  const reset = inbox.match(/export function resetActiveInboxItem\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reset, /void persistDraft\(item\);/);
  const close = inbox.match(/function closeInboxItem\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(close, /resetActiveInboxItem\(\);/);
  assert.doesNotMatch(close, /persistDraft/);
});
