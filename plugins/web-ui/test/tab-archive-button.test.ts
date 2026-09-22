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

test("a tab offers only close; archive is a header control", () => {
  const tab = split.slice(split.indexOf("class PaneTab"), split.indexOf("class StripDrop"));
  assert.match(tab, /split-tab-actions[\s\S]*?tip\("Close pane"\)/);
  assert.doesNotMatch(tab, /split-tab-archive|archiveSessionById/);
  const btn = fn(split, "sessionActions");
  assert.match(btn, /split-tab-archive[\s\S]*?archiveSessionById\(sessionId\)/);
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

test("every group keeps archive in the header instead of the tab", () => {
  const css = read("shell.css");
  assert.match(css, /\.dv-single-tab \.split-tab-actions\s*\{\s*display: none/);
  assert.match(css, /\.split-group-session-action\s*\{\s*display: inline-flex/);
  assert.match(split, /sessionId \? sessionActions\(sessionId, panel!\.id\) : nothing/);
});
