import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const split = read("split.ts");
const sessions = read("sessions.ts");
const css = read("shell.css");

test("a strip tab carries its own session's share and archive, drawn from one action list", () => {
  const tab = split.slice(split.indexOf("class PaneTab"), split.indexOf("class StripDrop"));
  assert.match(tab, /split-tab-session[\s\S]*?sessionActions\(sessionId, panel\.id, ""\)/);
  assert.match(tab, /split-tab-more[\s\S]*?toggleTabMenu\(panel\.id, e\.currentTarget as HTMLElement\)/);
  const items = split.slice(split.indexOf("function sessionActionItems"), split.indexOf("function sessionActions"));
  assert.match(items, /split-tab-share[\s\S]*?openSessionShare\(sessionId\)/);
  assert.match(items, /glyph: Link/);
  assert.match(items, /split-tab-archive[\s\S]*?archiveSessionById\(sessionId\)/);
  assert.match(split, /icon\(a\.glyph, 13\)/);
  assert.doesNotMatch(split, /session-share-button|sessionMenuItems/);
  assert.match(css, /\.dv-tab:not\(\.dv-active-tab\) \.split-tab-session \{\s*display: none;/);
});

test("under 400px the active tab folds share and archive into one caret menu the header draws", () => {
  assert.match(
    css,
    /@container pane-group \(max-width: 400px\) \{\s*\.dv-tab \.split-tab-session \{\s*display: none;\s*\}\s*\.dv-tab\.dv-active-tab \.split-tab-more \{\s*display: inline-flex;/,
  );
  const group = split.slice(split.indexOf("class GroupActions"), split.indexOf("function notePaneSession"));
  assert.match(
    group,
    /split-tab-menu[\s\S]*?placeBelow\(tabMenu\.anchor\)[\s\S]*?sessionActionItems\(menuSession, menuPanel\.id\)/,
  );
  assert.match(group, /if \(!this\.menuOpen && !tabMenu\) return;[\s\S]*?tabMenu = null;/);
});

test("a lone tab's header orders tools, sharing and archive before the pane controls, which fold when narrow", () => {
  const group = split.slice(split.indexOf("class GroupActions"), split.indexOf("function notePaneSession"));
  const render = group.slice(group.indexOf("    render("));
  assert.match(
    render,
    /split-tools[\s\S]*?sessionActions\(sessionId, panel!\.id, "split-group-session-action"\)[\s\S]*?split-pane-actions-wide[\s\S]*?buttons\.filter\(\(b\) => !b\.cls\)/,
  );
  assert.match(css, /\.dv-single-tab \.split-tab-actions\s*\{\s*display: none/);
  assert.match(css, /\.split-group-session-action\s*\{\s*display: inline-flex/);
  assert.match(css, /:not\(\.dv-single-tab\) \.split-group-session-action \{\s*display: none;/);
  assert.match(css, /@container pane-group \(max-width: 560px\) \{\s*\.split-pane-actions-wide \{\s*display: none;/);
  assert.match(css, /\.dockview-theme-qm \.dv-groupview \{[^}]*container: pane-group \/ inline-size;/);
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
