import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("Slack message bubbles render Slack mrkdwn as Markdown", async () => {
  const lines = "can you switch to fable here?\nsecond line";
  const h = await harness({
    path: "/s/sess-deep",
    session: { ...SESSION, type: "dm", createdAt: 1, surface: "slack", canContinue: false },
    items: [
      item("UserMessage", { seq: 1, createdAt: 1, text: lines }),
      item("UserMessage", { seq: 2, createdAt: 2, text: "see https://example.com/x?y=1&amp;z=2 ok" }),
      item("UserMessage", { seq: 3, createdAt: 3, text: "&gt; *Our plan:* ship it <@U1|ada>, `*code*` stays" }),
    ],
  });
  try {
    await h.boot();
    let quote: Element | null = null;
    for (let i = 0; i < 300 && !quote; i++) {
      quote = document.querySelector(".slack-wire-text blockquote");
      if (!quote) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const paragraphs = [...document.querySelectorAll(".slack-wire-text > qm-markdown p")];
    assert.equal(paragraphs[0]?.textContent, lines);
    assert.equal(paragraphs[1]?.textContent, "see https://example.com/x?y=1&z=2 ok");
    assert.equal(paragraphs[1]?.querySelector("a")?.getAttribute("href"), "https://example.com/x?y=1&z=2");
    assert.equal(quote?.querySelector("strong")?.textContent, "Our plan:");
    assert.equal(quote?.querySelector(".slack-mention")?.textContent, "@ada");
    assert.equal(quote?.querySelector("code")?.textContent, "*code*");
  } finally {
    await h.close();
  }
});
