import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("opening the app lands on a new chat unless the person opted to restore their last session", () => {
  const shell = read("shell.ts");
  const boot = shell.slice(shell.indexOf("const remoteSplitFetch = fetchRemoteSplit();"));
  assert.match(boot, /const restoreLast = viewIntent \|\| restoreLastOnOpen\(\);/);
  assert.match(boot, /if \(restoreLast\) loadPersistedSplit\(\);/, "the saved layout is not adopted by default");
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

test("the restore-on-open setting defaults off and is a per-browser choice in settings", () => {
  const settings = read("settings.ts");
  assert.match(settings, /return localStorage\.getItem\(RESTORE_ON_OPEN_KEY\) === "1";/);
  assert.match(settings, /\$\{openBehaviorRow\(\)\}/);
  assert.match(settings, /\{ restore: false, label: "New chat" \}/);
});

test("a saved multiview layout is not reopened on a bare visit by default", async () => {
  const { harness } = await import("./deep-link-boot-fixture.ts");
  const h = await harness({ path: "/", savedCanvas: true, restoreLast: false });
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

test("opting in reopens the saved multiview layout", async () => {
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
