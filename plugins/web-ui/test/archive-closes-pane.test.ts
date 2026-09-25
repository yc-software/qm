import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const split = read("split.ts");
const sessions = read("sessions.ts");

const fn = (src: string, name: string): string => {
  const body = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("archiving a session closes any surface still showing it", () => {
  const close = fn(split, "closeSessionSurfaces");
  assert.match(close, /dockApi\.panels\.filter\(\(p\) => panelParams\(p\)\.sessionId === sessionId\)/);
  assert.match(close, /closePanels\(showing\)/, "open panes must be removed, and reconciled by closePanels");
  assert.match(close, /conv\.state\.sessionId !== sessionId\) return false;/, "leave other conversations alone");
  assert.match(close, /conv\.newChat\(\);/, "outside the canvas the main view drops the archived session");

  const archived = fn(sessions, "setArchived");
  assert.match(archived, /if \(archived && s\.id\) closeSessionSurfaces\(s\.id\);/);
  assert.ok(
    archived.indexOf("closeSessionSurfaces") < archived.indexOf("persistSessionPatch"),
    "close the surface before the patch round-trip so the UI reacts immediately",
  );
  assert.doesNotMatch(archived, /!archived.*closeSessionSurfaces/s, "unarchiving must not close anything");
});
