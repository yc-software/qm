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
  const btn = split.match(/this\.inStrip && sessionId[\s\S]*?split-tab-archive[\s\S]*?<\/button>`/)?.[0] ?? "";
  assert.ok(btn, "archive button must render only in the tab strip and only when the pane shows a session");
  assert.match(btn, /archiveSessionById\(sessionId\)/, "click archives the pane's session");
  assert.match(btn, /e\.stopPropagation\(\)/, "click must not also activate the tab");
  assert.match(
    btn,
    /@pointerdown=\$\{\(e: Event\) => e\.stopPropagation\(\)\}/,
    "pointerdown must not activate an inactive tab before the archive click lands",
  );
  assert.ok(
    split.indexOf("split-tab-archive") < split.indexOf('title="Close pane"'),
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

test("a lone tab keeps its archive button even though its close yields to the group header", () => {
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const hide = css.indexOf(".dv-single-tab .split-tab-close");
  const keep = css.indexOf(".dv-single-tab .split-tab-archive");
  assert.ok(hide !== -1 && keep !== -1, "both single-tab rules exist");
  assert.ok(keep > hide, "the archive exemption must come after (and defeat) the hide rule");
  const rule = css.slice(keep, css.indexOf("}", keep));
  assert.match(rule, /display: inline-flex/);
});
