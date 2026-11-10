import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

test("Slack conversations can jump back to the bottom without replacing the reply composer", async () => {
  const session = { ...SESSION, type: "group" as const, createdAt: 1, surface: "slack", canContinue: false };
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    items: [item("UserMessage", { seq: 1, text: "A Slack message" })],
  });
  try {
    h.releaseSessions();
    await h.boot();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const scroller = document.querySelector<HTMLElement>(".chat-scroll")!;
    const reply = document.querySelector("qm-slack-reply");
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Scroll to bottom"]');
    assert.ok(button);
    assert.ok(reply);
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 500 },
    });
    scroller.scrollTop = 1500;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event("scroll"));
    assert.ok(scroller.hasAttribute("data-away-from-bottom"));
    button.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(scroller.scrollTop, 2000);
    scroller.dispatchEvent(new Event("scroll"));
    assert.equal(scroller.hasAttribute("data-away-from-bottom"), false);
    assert.equal(document.querySelector("qm-slack-reply"), reply);
  } finally {
    await h.close();
  }
});
