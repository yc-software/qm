import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const split = read("split.ts");
const sessions = read("sessions.ts");
const shell = read("shell.ts");
const layout = read("split-layout.ts");
const css = read("shell.css");

const fn = (src: string, name: string): string => {
  const body = src.match(new RegExp(`^(?:export )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("no new-chat affordance can cost the user their canvas", () => {
  assert.match(split, /export function addBlankPane\(scopeId\?: string\): boolean \{/);
  const add = fn(split, "addBlankPane");
  assert.match(add, /if \(!splitState\.active \|\| !dockApi\) return false;/, "no canvas ⇒ the caller must fall back");
  assert.match(add, /return true;\n\}$/, "having split, the canvas owns the click");
  assert.doesNotMatch(add.slice(add.indexOf("splitPane(")), /return false/, "a full canvas must not fall through");

  assert.match(shell, /if \(!addBlankPane\(\)\) newChat\(\);/);
  const plus = fn(sessions, "startProjectChat");
  const claimed = plus.indexOf("addBlankPane(scopeId)");
  assert.ok(claimed > 0, "the project + must offer the click to the canvas");
  assert.match(plus.slice(claimed), /^addBlankPane\(scopeId\)\) return;/m, "and bail out when the canvas takes it");
  assert.ok(plus.indexOf("addPendingSession(newChat(") > claimed, "only then may it mount a single chat");

  assert.match(fn(split, "exitSplitIfActive"), /splitState\.active = false;/);
  assert.doesNotMatch(fn(split, "exitSplitIfActive"), /removeItem|lastLayout = null/);
});

test("a pane opened from a project's + starts its chat in that project", () => {
  assert.match(split, /scopeId\?: string;/, "PaneParams must carry the project");
  const src = fn(split, "paneSrc");
  assert.match(src, /scope=\$\{encodeURIComponent\(params\.scopeId\)\}/);
  assert.match(src, /if \(sessionId\) return/, "an adopted session still wins over the seed scope");

  const embed = shell.match(/if \(embedMode\) \{[\s\S]*?\n {4}\}\n {4}return;/)?.[0] ?? "";
  assert.ok(embed, "the embed boot branch not found");
  assert.match(embed, /await ensureContexts\(\)\)\.find\(\(c\) => c\.scopeId === scope\)/);
  assert.doesNotMatch(embed, /newChat\(\{ scopeId: scope/, "the URL's scope must not reach newChat unchecked");
  assert.match(embed, /newChat\(context \? \{ scopeId: context\.scopeId/);
});

test("a conversation dropped on a pane's tab strip joins that pane — and only there", () => {
  const accept = split.match(/api\.onUnhandledDragOver\(\(e\) => \{[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
  assert.ok(accept, "onUnhandledDragOver not wired");
  assert.match(accept, /sessionDrag && \(e\.target === "tab" \|\| e\.target === "header_space"\)/);
  assert.doesNotMatch(accept, /"content"|"edge"/);

  const drop = split.match(/api\.onDidDrop\(\(e\) => \{[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
  assert.ok(drop, "onDidDrop not wired");
  assert.match(drop, /tabIntoPane\(anchor\.id, \{ sessionId: drag\.sessionId, threadRef: drag\.threadRef \}/);
  assert.match(drop, /focusExistingPane\(drag\.sessionId\)/, "a conversation already on screen is focused, not cloned");
  assert.match(drop, /endSessionDrag\(\);/, "the zone overlays must come down with the drag");

  assert.match(accept, /if \(sessionDrag/, "only a live session drag may be accepted");
});

test("a strip drop lands where a dragged pane header would, not merely at the end", () => {
  const drop = fn(split, "buildDock");
  assert.match(drop, /e\.panel \? e\.group\?\.panels\.indexOf\(e\.panel\) : undefined/);
  assert.match(drop, /tabIntoPane\([\s\S]{0,120}at === -1 \? undefined : at\)/);

  const into = fn(split, "tabIntoPane");
  assert.match(into, /index\?: number/, "tabIntoPane must accept an insertion index");
  assert.match(into, /direction: "within"/);
  assert.match(into, /index === undefined \? \{\} : \{ index \}/, "and forward it to addPane");
  const add = fn(split, "addPane");
  assert.match(add, /index\?: number/, "addPane must pass dockview its own position.index");
});

test("the pane body no longer offers a tab zone", () => {
  assert.doesNotMatch(layout, /"tab"/, "DropEdge must drop the zone that no longer exists");
  const zones = fn(split, "zonesTpl");
  assert.doesNotMatch(zones, /tab/i);
  assert.match(zones, /zoneTpl\("center", t\("Open here"\)/);
  for (const edge of ["left", "right", "top", "bottom"]) assert.match(zones, new RegExp(`zoneTpl\\("${edge}"`));
  assert.doesNotMatch(css, /\.zone-tab \{/);
  const center = css.match(/\.zone-center \{[^}]*\}/)?.[0] ?? "";
  assert.match(center, /top: 26%;/);
  assert.match(center, /bottom: 26%;/);
  assert.doesNotMatch(css, /\.split-zones-single \.zone-center/, "with one zone layout the exception is dead");
});

test("the tile cap only judges dockview's own panel drags", () => {
  const hold = split.match(/const holdTileCap = \(e: DockviewWillDropEvent\): void => \{[\s\S]*?\n {2}\};/)?.[0] ?? "";
  assert.ok(hold, "holdTileCap not found");
  const bail = hold.indexOf("if (e.getData() === undefined) return;");
  assert.ok(bail > 0, "a foreign drag must be waved through");
  assert.ok(bail < hold.indexOf("dropAddsTile"), "before the tile arithmetic, not after");
});
