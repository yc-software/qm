import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("Slack message bubbles render the message text without template whitespace", async () => {
  const text = "can you switch to fable here?\nsecond line";
  const h = await harness({
    path: "/s/sess-deep",
    session: { ...SESSION, type: "dm", createdAt: 1, surface: "slack", canContinue: false },
    items: [item("UserMessage", { seq: 1, createdAt: 1, text })],
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

test("bare URLs in Slack message text render as links", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    session: { ...SESSION, type: "dm", createdAt: 1, surface: "slack", canContinue: false },
    items: [item("UserMessage", { seq: 1, createdAt: 1, text: "see https://example.com/x?y=1&amp;z=2 ok" })],
  });
  try {
    await h.boot();
    let link: HTMLAnchorElement | null = null;
    for (let i = 0; i < 100 && !link; i++) {
      link = document.querySelector<HTMLAnchorElement>(".slack-wire-text a.inbox-text-link");
      if (!link) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(link?.getAttribute("href"), "https://example.com/x?y=1&z=2");
    assert.equal(document.querySelector(".slack-wire-text")?.textContent, "see https://example.com/x?y=1&z=2 ok");
  } finally {
    await h.close();
  }
});
