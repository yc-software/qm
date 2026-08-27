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
  const top = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0];
  const nested = src.match(new RegExp(`^ {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`, "m"))?.[0];
  const body = top ?? nested ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("the canvas owns ordinary new-chat actions even with one pane", () => {
  const replace = fn(split, "openBlankInFocusedPane");
  assert.match(replace, /replaceFocusedPane/);
  assert.match(shell, /openBlankInFocusedPane\(\);/);
  assert.doesNotMatch(shell, /if \(!addBlankPane\(\)\) mainConversation/);

  const project = fn(sessions, "startProjectChat");
  assert.match(project, /openBlankInFocusedPane\(scopeId\)/);
  assert.doesNotMatch(project, /mainConversation\(\)\.newChat/);

  const close = fn(split, "reconcileAfterClose");
  assert.match(close, /if \(dockApi\.panels\.length === 0\) addPane\(\{\}\)/);
  assert.doesNotMatch(close, /exitSplitIfActive|maximizePane|mainConversation/);
});

test("a pane opened from a project's + starts its chat in that project", () => {
  assert.match(split, /scopeId\?: string;/, "PaneParams must carry the project");
  const load = split.match(/private async load\(\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(load, "the pane loader not found");
  const seeded = load.indexOf("contextsState.list.find((c) => c.scopeId === scopeId)");
  assert.ok(seeded > 0, "the seed scope must resolve against contexts the viewer can actually use");
  assert.ok(load.indexOf("if (!wanted)") < seeded, "an adopted session still wins over the seed scope");
  assert.doesNotMatch(load, /newChat\(\{ scopeId: scopeId/, "an unchecked scope must not reach newChat");
  assert.match(load, /newChat\(context \? \{ scopeId: context\.scopeId/);
});

test("a pane is an element in this document — never a second copy of the app", () => {
  assert.doesNotMatch(split, /iframe/i, "panes must not reload the whole SPA per conversation");
  assert.doesNotMatch(split, /postMessage/, "same-document panes talk by call, not by message");
  assert.doesNotMatch(split, /defaultRenderer: "always"/, "a pane behind a tab must cost nothing until shown");
  assert.match(split, /createConversation\(\{/, "each pane owns a conversation instance");
  assert.match(split, /disposeConversation\(this\.conversation\)/, "and releases it when the pane closes");
  const load = split.match(/private async load\(\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(
    load,
    /if \(this\.loaded \|\| this\.disposed\) return;/,
    "a pane loads its transcript once, and never after it closes",
  );
  assert.match(load, /if \(this\.disposed\) return;/, "and drops the continuation if the pane closed mid-load");
  assert.match(split, /onDidVisibilityChange\(\(e\) => \{\s*\n\s*if \(!e\.isVisible\) return;/);
});

test("a conversation dropped on a pane's tab strip joins that pane — and only there", () => {
  const strip = split.match(/^class StripDrop[\s\S]*?\n\}/m)?.[0] ?? "";
  assert.ok(strip, "StripDrop not wired");
  assert.match(split, /createPrefixHeaderActionComponent: \(\) => new StripDrop\(\)/);
  assert.match(strip, /tabIntoPane\(anchor\.id, \{ sessionId: drag\.sessionId, threadRef: drag\.threadRef \}\)/);
  assert.match(
    strip,
    /focusExistingPane\(drag\.sessionId\)/,
    "a conversation already on screen is focused, not cloned",
  );
  assert.match(strip, /endSessionDrag\(\);/, "the zone overlays must come down with the drag");
  assert.match(strip, /stripJoinable\(\)/, "only a live session drag that would really add a tab");
});

test("the pane body no longer offers a tab zone", () => {
  assert.doesNotMatch(layout, /"tab"/, "DropEdge must drop the zone that no longer exists");
  const zones = fn(split, "paneZonesTpl") + fn(split, "splitZonesTpl");
  assert.doesNotMatch(zones, /"tab"/);
  assert.match(zones, /zoneTpl\("center", "Open here"/);
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

test("boot mounts a one-pane canvas before it awaits the session list", () => {
  const boot = shell.match(/export async function boot\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(boot, "boot not found");
  const early = boot.indexOf("if (bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas();");
  const listAwait = boot.indexOf("await refreshSessions({ showLoading: true });");
  assert.ok(early > 0 && early < listAwait, "the baseline canvas mounts before session refresh when it can");
  assert.match(boot.slice(listAwait), /\} else \{\s*mountRestoredCanvas\(\);\s*\}/);

  const mount = fn(split, "mountRestoredCanvas");
  assert.match(mount, /splitState\.active = true;/);
  assert.match(mount, /if \(dockApi\.panels\.length === 0\) addPane\(\{\}\)/);
});

test("one-pane layouts persist and restore as first-class canvas layouts", () => {
  const adopt = fn(split, "adoptPersisted");
  assert.match(adopt, /if \(n < 1 \|\| n > MAX_PANES/);
  assert.doesNotMatch(adopt, /o\.active !== true|n < 2/);
  assert.match(fn(split, "loadPersistedSplit"), /splitState\.active = true;/);
});

test("a pane gives the conversation the same height chain the full-screen .main does", () => {
  // .custom-chat sizes itself with flex: 1 / min-height: 0, so every container it
  // mounts into must be a flex column of definite height — .main is; the pane
  // wrapper must be too, or the transcript never scroll-contains and the composer
  // trails the content instead of pinning to the pane's bottom edge.
  const main = css.match(/^\.main \{[^}]*\}/m)?.[0] ?? "";
  assert.match(main, /display: flex;/);
  assert.match(main, /flex-direction: column;/);
  const pane = css.match(/^\.split-pane-chat \{[^}]*\}/m)?.[0] ?? "";
  assert.match(pane, /display: flex;/, "the pane wrapper must be a flex container");
  assert.match(pane, /flex-direction: column;/, "…a column, like .main");
  assert.match(pane, /height: 100%;/, "…of definite height");
  assert.match(pane, /overflow: hidden;/, "…that clips instead of growing the pane");
});

test("adopting a remote layout normalizes the mirrored timestamp to the server record", () => {
  const adopt = fn(split, "adoptRemoteSplit");
  assert.match(adopt, /persistedUpdatedAt = at;/, "the in-memory watermark takes the server record's time");
  assert.match(
    adopt,
    /JSON\.stringify\(\{ \.\.\.rec\.value, updatedAt: at \}\)/,
    "the local mirror must carry the server-clamped timestamp, not the value's inner claim",
  );
});
