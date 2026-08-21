import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const sessions = read("../src/sessions.ts");
const contexts = read("../src/contexts.ts");
const shell = read("../src/shell.ts");

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
  assert.match(openSessionBody, /const surfaceRevision = claimMainSurface\(\);/);
  assert.match(openSessionBody, /openSessionInto\(mainConversation\(\), s, entriesPrefetch, surfaceRevision\)/);
});

test("a delayed main-session load cannot replace a newer surface", () => {
  const body = sessions.match(/export async function openSessionInto\([^]*?\n\}/)?.[0] ?? "";
  assert.ok(body, "openSessionInto exists");
  const wait = body.indexOf("await Promise.all");
  const current = body.indexOf("mainSurfaceIsCurrent(trackedRevision!)", wait);
  const generation = body.indexOf("openingRequest !== mainSessionOpenRevision", wait);
  const continuable = body.lastIndexOf("conv.mountContinuable");
  const readOnly = body.lastIndexOf("conv.mountReadOnly");
  assert.ok(wait > 0 && generation > wait && current > generation, "both request and surface tokens follow loading");
  assert.ok(current < continuable && current < readOnly, "stale loads must stop before either transcript mount");
  assert.match(body.slice(wait, continuable), /sessionsState\.openingKey = null;\s*renderList\(\);\s*return;/);
});

test("authentication gates and a newly mounted shell retire prior main-session loads", () => {
  const gate = shell.match(/export function renderAuthGate\([^]*?\n\}/)?.[0] ?? "";
  const mount = shell.match(/export function mountShell\([^]*?\n\}/)?.[0] ?? "";
  assert.match(gate, /claimMainSurface\(\);\s*shellMounted = false/);
  assert.match(mount, /claimMainSurface\(\);\s*applySavedSidebarWidth\(\)/);
  assert.match(openSessionBody, /const surfaceRevision = claimMainSurface\(\)/);
});

test("same-session retries keep ownership with the newest request", () => {
  const body = sessions.match(/export async function openSessionInto\([^]*?\n\}/)?.[0] ?? "";
  const request = body.indexOf("const openingRequest = tracked ? ++mainSessionOpenRevision : 0");
  const clear = body.indexOf("sessionsState.openingKey = null", request);
  const noId = body.indexOf("if (!s.id)");
  const sameId = body.indexOf("if (s.id === conv.state.sessionId) return");
  assert.ok(request > 0 && clear > request && clear < noId && noId < sameId);
  assert.match(body, /openingRequest === mainSessionOpenRevision/);
  assert.match(body, /openingRequest !== mainSessionOpenRevision \|\| sessionsState\.openingKey !== opening/);
});

test("a disposed pane cannot mount after its transcript finishes loading", () => {
  const body = sessions.match(/export async function openSessionInto\([^]*?\n\}/)?.[0] ?? "";
  const wait = body.indexOf("await Promise.all");
  const live = body.indexOf("if (!isCurrent()) return", wait);
  const continuable = body.lastIndexOf("conv.mountContinuable");
  const readOnly = body.lastIndexOf("conv.mountReadOnly");
  assert.ok(wait > 0 && live > wait && live < continuable && live < readOnly);
  assert.match(body, /const skeletonTimer = window\.setTimeout\(\(\) => \{\s*if \(!isCurrent\(\)\) return;/);
  assert.match(
    read("../src/split.ts"),
    /openSessionInto\(this\.conversation, session, undefined, undefined, \(\) => !this\.disposed\)/,
  );
});

test("openFromContext delegates the view switch to openSession", () => {
  const body = contexts.match(/async function openFromContext\([^]*?\n\}/)?.[0] ?? "";
  assert.ok(body, "openFromContext exists");
  assert.match(body, /await openSession\(s\)/);
  assert.doesNotMatch(body, /appState\.currentView = "chats"/);
});
