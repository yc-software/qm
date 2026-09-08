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

test("a tab offers an archive button beside close, for real sessions only", () => {
  assert.match(split, /this\.inStrip[\s\S]*?split-tab-actions[\s\S]*?sessionId \? sessionActions\(sessionId, true\)/);
  const btn = fn(split, "sessionActions");
  assert.match(btn, /archiveSessionById\(sessionId\)/);
  assert.match(btn, /@pointerdown=[\s\S]*?if \(inTab\) e\.stopPropagation\(\)/);
  assert.match(btn, /@click=[\s\S]*?if \(inTab\) e\.stopPropagation\(\)/);
  const archiveAt = split.indexOf("split-tab-archive");
  assert.ok(
    archiveAt !== -1 && split.indexOf('tip("Close pane")', archiveAt) !== -1,
    "archive sits before (next to) the close button",
  );
});

test("archiveSessionById routes through setArchived so surfaces close and Recents updates at once", () => {
  const body = fn(sessions, "archiveSessionById");
  assert.match(body, /sessionsState\.list\.find/, "resolves the session from the live list");
  assert.match(body, /if \(s && !s\.archived\)/, "idempotent — never double-archives a listed session");
  assert.match(body, /setArchived\(s, true\);/, "reuses the one archive path (optimistic list patch + surface close)");
  assert.match(body, /closeSessionSurfaces\(sessionId\);/, "still closes the pane when the list can't help");
  assert.match(
    body,
    /if \(!s\) void persistSessionPatch\(sessionId, \{ archived: true \}\);/,
    "archives by id when the session is not in the list yet",
  );
});

test("a lone session keeps archive in the group header instead of the tab", () => {
  const css = read("shell.css");
  assert.match(css, /\.dv-single-tab \.split-tab-actions\s*\{\s*display: none/);
  assert.match(css, /\.dv-single-tab \.split-group-session-action\s*\{\s*display: inline-flex/);
  assert.match(split, /sessionId \? sessionActions\(sessionId, false\) : nothing/);
});
