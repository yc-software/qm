import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("a restored conversation paints its transcript while the sidebar list is still pending", async () => {
  const h = await harness({
    path: "/",
    welcome: true,
    remoteCanvas: {
      v: 1,
      active: true,
      root: {
        kind: "split",
        a: { kind: "leaf", sessionId: SESSION.id, threadRef: SESSION.threadRef },
        b: { kind: "leaf" },
      },
    },
    entries: [{ seq: 1, type: "user", createdAt: 1, payload: { text: "Restored conversation is ready" } }],
  });
  const booted = h.boot();
  try {
    for (let i = 0; i < 100 && !h.mainText().includes("Restored conversation is ready"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(h.mainText(), /Restored conversation is ready/);
    assert.equal(h.sessionsState.loaded, false);
    assert.equal(h.requests.filter((path) => path === "/api/sessions").length, 1);
    assert.equal(h.requests.filter((path) => path === `/api/sessions/${SESSION.id}?tailTurns=25`).length, 1);
    assert.equal(document.querySelector(".split-pane-content .chat-loading"), null);
  } finally {
    h.releaseSessions();
    await booted;
    await h.close();
  }
});
