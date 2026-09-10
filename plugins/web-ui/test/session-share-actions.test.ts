import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const split = read("split.ts");
const sessions = read("sessions.ts");
const css = read("shell.css");

test("tab and header sharing use the same session actions", () => {
  assert.match(
    split,
    /this\.inStrip[\s\S]*?split-tab-actions[\s\S]*?sessionId \? sessionActions\(sessionId, true\) : nothing/,
  );
  const actions = split.slice(split.indexOf("function sessionActions"), split.indexOf("class PaneTab"));
  assert.match(actions, /split-tab-share[\s\S]*?openSessionShare\(sessionId\)[\s\S]*?icon\(Link, 13\)/);
  assert.match(actions, /split-tab-archive[\s\S]*?archiveSessionById\(sessionId\)/);
  assert.doesNotMatch(split, /session-share-button/);
});

test("a lone header orders tools before sharing and archive", () => {
  const group = split.slice(split.indexOf("class GroupActions"), split.indexOf("function notePaneSession"));
  const render = group.slice(group.indexOf("    render("));
  assert.match(render, /split-tools[\s\S]*?sessionActions\(sessionId, false\)[\s\S]*?buttons\.map/);
  assert.match(css, /\.dv-single-tab \.split-tab-actions\s*\{\s*display: none/);
  assert.match(css, /\.split-group-session-action\s*\{\s*display: none/);
  assert.match(css, /\.dv-single-tab \.split-group-session-action\s*\{\s*display: inline-flex/);
});

test("session lists open sharing inline beside archive", () => {
  assert.match(
    sessions,
    /class="session-menu-btn session-share-btn"[\s\S]*?openSessionShare\(s.id\)[\s\S]*?session-archive-btn/,
  );
  const row = sessions.slice(
    sessions.indexOf("function chatPageRow"),
    sessions.indexOf("export function addPendingSession"),
  );
  assert.match(row, /openSessionShare\(s.id\)[\s\S]*?tip\(s.archived/);
  assert.doesNotMatch(row, /Copy link/);
  assert.match(css, /\.sidebar \.session-share-btn,\s*\.sidebar \.session-archive-btn\s*\{\s*display: none/);
});

test("a topbar without archive does not offer a separate share button", () => {
  assert.doesNotMatch(read("session-scope.ts"), /session-share-button|openSessionShare/);
  assert.doesNotMatch(css, /\.session-share-button\s*\{/);
});
