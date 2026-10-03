import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("opening the app restores the last session unless the person opted into a new chat", () => {
  const shell = read("shell.ts");
  const boot = shell.slice(shell.indexOf("const remoteSplitFetch = fetchRemoteSplit();"));
  assert.match(boot, /const restoreLast = viewIntent \|\| !\(await openNewChatFetch\);/);
  assert.match(boot, /if \(restoreLast\) loadPersistedSplit\(\);/, "the saved layout is only adopted when restoring");
  assert.match(
    boot,
    /if \(restoreLast && bareEntry && !restoredCanvasNeedsSessionList\(\)\) mountRestoredCanvas\(true\);/,
  );
  assert.match(
    boot,
    /\} else if \(!\(restoreLast && mountRestoredCanvas\(\)\) && !mainConversation\(\)\.state\.threadRef\) \{\s*mainConversation\(\)\.newChat\(\);/,
  );
  assert.doesNotMatch(boot, /^ {2}loadPersistedSplit\(\);$/m, "no unconditional layout restore on open");
});

test("the open setting is stored per user and defaults to the last session", () => {
  const settings = read("settings.ts");
  assert.match(settings, /openNewChat = rec\.value === true;/);
  assert.match(settings, /putUiState\(OPEN_NEW_CHAT_KEY/);
  assert.doesNotMatch(settings, /localStorage\.\w+\(OPEN_NEW_CHAT_KEY/);
  assert.match(settings, /\$\{openBehaviorRow\(\)\}/);
  assert.match(settings, /\{ newChat: false, label: "Last session" \}/);
});

test("opting into a new chat skips the saved multiview layout on a bare visit", async () => {
  const { harness } = await import("./deep-link-boot-fixture.ts");
  const h = await harness({ path: "/", savedCanvas: true, openNewChat: true });
  try {
    const saved = localStorage.getItem("web-ui:split-canvas:v1");
    h.releaseSessions();
    await h.boot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(localStorage.getItem("web-ui:split-canvas:v1"), saved, "the saved layout survives for a later opt-in");
    assert.equal(document.querySelectorAll(".split-pane-content").length, 0);
    assert.doesNotMatch(h.visibleConversation().state.threadRef ?? "", /old-a|old-b/);
    assert.doesNotMatch(h.mainText(), /old-a|old-b/);
  } finally {
    await h.close();
  }
});

test("by default the saved multiview layout reopens", async () => {
  const { harness } = await import("./deep-link-boot-fixture.ts");
  const h = await harness({ path: "/", savedCanvas: true });
  try {
    h.releaseSessions();
    await h.boot();
    for (let i = 0; i < 200 && document.querySelectorAll(".split-pane-content").length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelectorAll(".split-pane-content").length, 2);
  } finally {
    await h.close();
  }
});
