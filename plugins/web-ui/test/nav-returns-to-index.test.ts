import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");

const renderActive = shell.match(/function renderActiveView\([\s\S]*?\n\}/)?.[0] ?? "";
const refresh = shell.match(/function refreshActiveView\(v: View\): void \{[\s\S]*?\n\}/)?.[0] ?? "";

test("pressing the nav entry for the view you are already on drops back to its index", () => {
  assert.match(refresh, /syncUrlFromState\(\);/);
  assert.match(refresh, /renderActiveView\(v, null, true\)/);
});

test("every view with a detail page clears it, so no nav entry is a no-op", () => {
  assert.match(renderActive, /case "inbox":\s*resetActiveInboxItem\(\);/);
  for (const reset of ["resetActiveWebhook", "resetActiveCron", "resetActiveLoop", "resetActiveSkill"]) {
    assert.match(shell, new RegExp(String.raw`resetView: module\.${reset}`), `${reset} remains wired`);
  }
});

test("arriving from another view and re-pressing the nav entry share one reset", () => {
  const activate = shell.match(/function activateView\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(activate, /refreshActiveView\(v\);/);
  assert.match(activate, /renderActiveView\(v, item/);
  assert.match(shell, /module\.resetView\?\.\(\);/);
});

test("a deep link still wins: the reset clears the selection but never the pending item", () => {
  const reset = inbox.match(/export function resetActiveInboxItem\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reset, /fullSurface\.selectedId = null;/);
  assert.doesNotMatch(reset, /pendingItemId/);
  assert.match(
    shell,
    /if \(wanted === "inbox" && wantedItem\) openInboxItemById\(wantedItem\);\s*\n\s*await activateView\(wanted as View, wantedItem, true\);/,
  );
});

test("closing an item from the page and from the nav both persist the draft first", () => {
  const reset = inbox.match(/export function resetActiveInboxItem\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reset, /void persistDraft\(item\);/);
  const close = inbox.match(/function closeInboxItem\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(close, /resetActiveInboxItem\(\);/);
  assert.doesNotMatch(close, /persistDraft/);
});
