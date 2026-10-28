import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("Slack message bubbles render the message text without template whitespace", async () => {
  const text = "can you switch to fable here?\nsecond line";
  const h = await harness({
    path: "/s/sess-deep",
    session: { ...SESSION, type: "dm", createdAt: 1, surface: "slack", canContinue: false },
    entries: [{ seq: 1, type: "user", createdAt: 1, payload: { text } }],
  });
  try {
    await h.boot();
    let bubble: Element | null = null;
    for (let i = 0; i < 100 && !bubble; i++) {
      bubble = document.querySelector(".slack-wire-text");
      if (!bubble) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(bubble, "Slack bubble rendered");
    assert.equal(bubble.textContent, text);
  } finally {
    await h.close();
  }
});
