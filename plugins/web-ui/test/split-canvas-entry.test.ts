import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const split = read("split.ts");
const sessions = read("sessions.ts");
const shell = read("shell.ts");
const chat = read("chat.ts");
const layout = read("split-layout.ts");
const css = read("shell.css");

const fn = (src: string, name: string): string => {
  const top = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m"))?.[0];
  const nested = src.match(new RegExp(`^ {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}`, "m"))?.[0];
  const body = top ?? nested ?? "";
  assert.ok(body, `${name} not found`);
  return body;
};

test("no new-chat affordance can cost the user their canvas", () => {
  assert.match(split, /export function addBlankPane\(scopeId\?: string\): boolean \{/);
  const add = fn(split, "addBlankPane");
  assert.match(add, /if \(!splitState\.active \|\| !dockApi\) return false;/, "no canvas ⇒ the caller must fall back");
  assert.match(add, /return true;\n\}$/, "having split, the canvas owns the click");
  assert.doesNotMatch(add.slice(add.indexOf("splitPane(")), /return false/, "a full canvas must not fall through");

  assert.match(shell, /if \(!addBlankPane\(\)\) mainConversation\(\)\.newChat\(\);/);
  const plus = fn(sessions, "startProjectChat");
  const claimed = plus.indexOf("addBlankPane(scopeId)");
  assert.ok(claimed > 0, "the project + must offer the click to the canvas");
  assert.match(plus.slice(claimed), /^addBlankPane\(scopeId\)\) return;/m, "and bail out when the canvas takes it");
  assert.ok(
    plus.indexOf("addPendingSession(mainConversation().newChat(") > claimed,
    "only then may it mount a single chat",
  );

  assert.match(fn(split, "exitSplitIfActive"), /splitState\.active = false;/);
  assert.doesNotMatch(fn(split, "exitSplitIfActive"), /removeItem|lastLayout = null/);
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
  assert.match(split, /onDidVisibilityChange\(\(e\) => \{\s*\n\s*if \(e\.isVisible\) void this\.load\(\);/);
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
  const zones = fn(split, "zonesTpl") + fn(split, "splitZonesTpl");
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

test("boot mounts a restored canvas before it awaits the session list", () => {
  const boot = shell.match(/export async function boot\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(boot, "boot not found");
  const early = boot.indexOf("if (bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas();");
  const listAwait = boot.indexOf("await refreshSessions({ showLoading: true });");
  assert.ok(early > 0, "boot must offer the canvas its head start");
  assert.ok(listAwait > 0, "boot still loads the session list");
  assert.ok(early < listAwait, "the mount must come BEFORE the list fetch the panes never read");

  assert.match(boot, /const bareEntry = !viewIntent && !wantedSession && wanted !== "app-edit" && !connectedProvider;/);

  assert.match(
    boot.slice(listAwait),
    /\} else if \(!mountRestoredCanvas\(\) && !mainConversation\(\)\.state\.threadRef\) \{/,
  );
  const mount = fn(split, "mountRestoredCanvas");
  assert.match(mount, /^ {2}if \(splitState\.active && \(dockApi\?\.panels\.length \?\? 0\) > 0\) return true;/m);
});

test("boot's fallback never replaces a chat the user mounted during the wait", () => {
  const boot = shell.match(/export async function boot\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? "";
  const listAwait = boot.indexOf("await refreshSessions({ showLoading: true });");
  const tail = boot.slice(listAwait);
  assert.match(tail, /\} else if \(!mountRestoredCanvas\(\) && !mainConversation\(\)\.state\.threadRef\) \{/);
  const guard = tail.indexOf("!mainConversation().state.threadRef");
  const mint = tail.indexOf("newChat();", guard);
  assert.ok(guard > 0 && mint > guard, "the guard must gate the mint, not follow it");

  assert.match(chat, /^ {2}function mountContinuable\(/m);
  assert.match(fn(chat, "mountContinuable"), /chatState\.threadRef = threadRef;/);

  const reconcile = fn(split, "reconcileAfterClose");
  assert.match(
    reconcile,
    /exitSplitIfActive\(\);\s*\n\s*mainConversation\(\)\.newChat\(\);/,
    "a blank lone survivor mounts a new chat",
  );
  assert.match(reconcile, /void maximizePane\(params\);/, "a lone survivor with a session is maximized");
  assert.match(fn(split, "exitSplitIfActive"), /splitState\.active = false;/);
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
