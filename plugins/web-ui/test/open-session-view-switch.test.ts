import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");

const openSessionBody = sessions.match(/export async function openSession\([^]*?\n\}/)?.[0] ?? "";

test("openSession returns to the chats view before mounting (sidebar sessions are visible on every view)", () => {
  const guard = openSessionBody.match(/if \(appState\.currentView !== "chats"\) \{[^]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(guard, "openSession must switch back to the chats view when invoked from another view");
  assert.match(guard, /appState\.currentView = "chats"/);
  assert.match(guard, /appState\.viewRenderSeq\+\+/, "must invalidate pending renders of the previous view");
  assert.match(guard, /renderSidebarTop\(\)/);
  assert.match(guard, /if \(splitState\.active\) drawCanvas\(\)/, "split canvas must be redrawn on return to chats");
  assert.match(
    guard,
    /syncUrlFromState\(s\.id \|\| null\)/,
    "URL must leave the old view — with the target session, not a stale remembered one — even when the split intercept returns early",
  );
  assert.ok(
    openSessionBody.indexOf(guard) < openSessionBody.indexOf("splitInterceptsOpen"),
    "view switch must happen before the split intercept so canvas opens intercept correctly",
  );
});

test("openFromContext delegates the view switch to openSession", () => {
  const body = contexts.match(/async function openFromContext\([^]*?\n\}/)?.[0] ?? "";
  assert.ok(body, "openFromContext exists");
  assert.match(body, /await openSession\(s\)/);
  assert.doesNotMatch(body, /appState\.currentView = "chats"/);
});
