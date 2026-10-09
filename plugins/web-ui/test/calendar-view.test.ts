import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deepLinkPath, parseDeepLink } from "../src/deep-link.ts";
import { documentTitle, PRODUCT_TITLE } from "../src/document-title.ts";

const calendar = readFileSync(new URL("../src/calendar.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const shellState = readFileSync(new URL("../src/shell-state.ts", import.meta.url), "utf8");

test("calendar is a first-class empty view directly below Inbox", () => {
  assert.match(shellState, /"chats",\s*"inbox",\s*"calendar",\s*"contexts"/);
  assert.match(shell, /inboxNavRow\(\).*navRow\("calendar", ICON\.calendar, "Calendar"\)/s);
  assert.match(shell, /case "calendar":\s*renderCalendar\(\);/);
  assert.match(calendar, /host\.className = "pane content-wide-page"/);
  assert.match(calendar, /<div class="pane-head">/);
  assert.match(calendar, /<h1 class="pane-title">Calendar<\/h1>/);
  assert.match(calendar, /Coming soon\./);
});

test("calendar reuses the Inbox permission gate", () => {
  assert.match(shell, /can\("inbox"\) \? html`\$\{inboxNavRow\(\)\} \$\{navRow\("calendar"/);
  assert.match(shellState, /if \(view === "inbox" \|\| view === "calendar"\) return can\("inbox"\);/);
});

test("calendar has a stable route and document title", () => {
  assert.equal(deepLinkPath("", "calendar", null), "/calendar");
  assert.deepEqual(parseDeepLink("", "/calendar", ""), { view: "calendar", session: null, item: null });
  assert.equal(documentTitle("calendar"), `Calendar · ${PRODUCT_TITLE}`);
});
