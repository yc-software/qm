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

test("cron index rows keep details and raw schedules out of the summary", () => {
  const row = source.slice(source.indexOf("function cronPageRow"), source.indexOf("function cronRowActions"));
  assert.doesNotMatch(row, /cronPreview|cronScheduleSummary/);
  assert.match(row, /cronRunSummary\(c\)/);
});

test("cron index keeps only search in its header controls", () => {
  const page = source.slice(source.indexOf("function drawCronsPage"), source.indexOf("function setCronTab"));
  assert.doesNotMatch(page, /onScope|onRefresh|label: "New cron"/);
  assert.match(page, /placeholder: "Search crons"/);
});

test("reopening a cron refreshes recent runs without a manual refresh control", () => {
  assert.match(source, /const shouldRefreshRuns = opts\.refreshRuns \|\| activeCronId !== c\.id;/);
  assert.match(source, /openCron\(c, \{ refreshRuns: true \}\)/);
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

test("permanent delete is only offered once a cron is archived", () => {
  const detail = source.slice(source.indexOf("function openCron"), source.indexOf("function showCronDialog"));
  assert.match(
    detail,
    /c\.archived\s+\? html`<button class="btn danger" @click=\$\{\(\) => showCronDialog\("delete", c\)\}>/,
  );
  assert.equal(detail.match(/showCronDialog\("delete"/g)?.length, 1);
  const row = source.slice(source.indexOf("function cronRowActions"), source.indexOf("function openCron"));
  assert.doesNotMatch(row, /showCronDialog\("delete"/);
});

test("the delete confirmation says where and when the cron runs", () => {
  const dialog = source.slice(source.indexOf("function cronDialogTpl"), source.indexOf("Delete permanently"));
  assert.match(dialog, /scopeChip\(c\.ownerScopeId, c\.scopeName \?\? null\)\} \$\{cronScheduleDetail\(c\)\}/);
});

test("archiving says how to get the cron back", () => {
  const archive = source.slice(source.indexOf("async function archiveCron"), source.indexOf("function setCronEnabled"));
  assert.match(archive, /cronActionNotice = "Archived\. Unarchive it from the Archived tab/);
});
