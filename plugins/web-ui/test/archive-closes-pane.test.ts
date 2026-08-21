import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string =>
  readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const split = read("split.ts");
const sessions = read("sessions.ts");

const fn = (src: string, name: string): string => {
  const body = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("archiving a session closes any surface still showing it", () => {
  const close = fn(split, "closeSessionSurfaces");
  assert.match(close, /if \(splitState\.active\)/, "hidden persisted docks must still be maintained");
  assert.match(close, /if \(dockApi\)/);
  assert.match(close, /paneSeedMatchesSession\(panelParams\(panel\), sessionId, threadRef\)/);
  assert.match(close, /closePanels\(showing\)/, "open panes must be removed, and reconciled by closePanels");
  assert.match(close, /conv\.state\.sessionId !== sessionId\) return false;/, "leave other conversations alone");
  assert.match(close, /conv\.newChat\(\);/, "outside the canvas the main view drops the archived session");

  const archived = fn(sessions, "setArchived");
  assert.match(archived, /if \(archived && s\.id\) closeSessionSurfaces\(s\.id, s\.threadRef\);/);
  assert.match(archived, /else if \(s\.id\) cancelPendingSessionClosure\(s\.id\);/);
  assert.ok(
    archived.indexOf("closeSessionSurfaces") < archived.indexOf("persistSessionPatch"),
    "close the surface before the patch round-trip so the UI reacts immediately",
  );
  assert.doesNotMatch(archived, /!archived.*closeSessionSurfaces/s, "unarchiving must not close anything");
});

test("closing a pane from a detached canvas persists without navigating", () => {
  const close = fn(split, "closePanels");
  assert.match(close, /reconcileAfterClose\(\);/);
  assert.doesNotMatch(close, /exitSplitIfActive|switchView|openSession/);
  assert.match(fn(split, "reconcileAfterClose"), /persist\(\);/);
});

test("archiving from a view that has not mounted its pending canvas defers the exact pane closure", () => {
  const close = fn(split, "closeSessionSurfaces");
  assert.match(close, /else if \(pendingSeedShowsSession\(sessionId, threadRef\)\) \{/);
  assert.match(close, /pendingSessionClosures\.set\(sessionId, threadRef\)/);
  const mount = fn(split, "mountRestoredCanvas");
  assert.match(mount, /closePendingSessionPanels\(\);/);
  assert.ok(mount.indexOf("closePendingSessionPanels()") < mount.indexOf("if (dockApi.panels.length === 0)"));
  const changed = fn(split, "notifySessionsChanged");
  assert.match(changed, /^ {2}if \(closePendingSessionPanels\(\)\) return;/m);
  const pending = fn(split, "closePendingSessionPanels");
  assert.doesNotMatch(pending, /session\.archived/, "explicitly opened archived sessions must remain viewable");
  assert.match(pending, /closePanels\(showing, false\)/, "deferred cleanup is not a new user surface claim");
  assert.match(split, /pendingSessionClosures\.clear\(\);\n\s+return;\n\s+\}/);
  assert.match(split, /retainPendingSessionClosures\(pendingSeed\);/);
  assert.match(split, /paneSeedMatchesSession\(pane, sessionId, threadRef\)/);
});
