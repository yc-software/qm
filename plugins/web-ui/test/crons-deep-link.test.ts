import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/crons.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("a run's worklog link addresses the chats view, not the page it was rendered on", () => {
  assert.match(source, /class="cron-run-link" href=\$\{deepLinkPath\(UI_BASE, "chats", run\.sessionId\)\}/);
  assert.doesNotMatch(source, /location\.pathname\}\?session=/);
});

test("a cron row is a real link to its own path", () => {
  assert.match(source, /<a\s+class="cron-row-main"\s+href=\$\{deepLinkPath\(UI_BASE, "crons", null, null, c\.id\)\}/);
});

test("modified clicks fall through to the browser so open-in-tab and save-link still work", () => {
  const deepLink = readFileSync(new URL("../src/deep-link.ts", import.meta.url), "utf8");
  assert.match(deepLink, /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey \|\| e\.button !== 0/);
  assert.match(source, /if \(!isPlainLeftClick\(event\)\) return;/);
});

test("opening a cron from the list pushes history, so Back returns to the list", () => {
  assert.match(source, /openCron\(c, \{ push: true \}\)/);
  assert.match(source, /if \(push\) history\.pushState\(null, "", next\);\s+else history\.replaceState/);
  assert.match(shell, /addEventListener\("popstate"[\s\S]*?routeCronsHistory\(item\)/);
});

test("a failed load is never reported as a missing cron", () => {
  assert.match(source, /const loaded = await refreshCrons/);
  assert.match(source, /if \(!loaded\) return drawCronsPage\(\);/);
  const body = source.slice(source.indexOf("export async function renderCronsPage"));
  assert.ok(body.indexOf("if (!loaded)") < body.indexOf("wasn't found"));
});

test("a pending deep-linked cron is consumed even when the view changed mid-load", () => {
  const body = source.slice(source.indexOf("export async function renderCronsPage"));
  const consume = body.indexOf("pendingCronId = null");
  const guard = body.indexOf('appState.currentView !== "crons") return', body.indexOf("await refreshCrons"));
  assert.ok(consume !== -1 && guard !== -1 && consume < guard);
});
