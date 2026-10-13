import assert from "node:assert/strict";
import test from "node:test";

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
