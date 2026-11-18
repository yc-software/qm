import assert from "node:assert/strict";
import test from "node:test";
import { item } from "./item-fixture.ts";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Side chat did not reach the expected state");
}

test("clicking outside an open side chat collapses it, clicking inside keeps it open", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
  };
  const side: CoreSession = { ...source, id: "side", threadRef: "web:tester:side", forkBoundarySeq: 0 };
  side.forkedFrom = { sessionId: source.id };
  side.sideChat = { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false };
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Use a durable queue" })];
  const sideItems = [
    ...items,
    item("UserMessage", { seq: 1, createdAt: Date.now(), text: "Why?" }),
    item("AgentMessage", { seq: 2, createdAt: Date.now(), text: "Jobs survive restarts." }),
  ];
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, side],
    items,
    api(path) {
      if (path.startsWith("/api/sessions/side?")) return Response.json({ session: side, items: sideItems });
      return undefined;
    },
  });
  const press = (target: Element) => {
    target.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  };
  const open = () => document.querySelector(".side-chat-card:not(.collapsed) .side-chat-panel");
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(".side-chat-preview")));
    const note = document.querySelector<HTMLElement>(".side-chat-card")!;
    note.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    assert.ok(note.classList.contains("hovered"), "a focused note is marked so it lights up with its passage");
    note.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    assert.ok(!note.classList.contains("hovered"));
    document.querySelector<HTMLElement>(".side-chat-preview")!.click();
    await until(() => open()?.textContent?.includes("Jobs survive restarts.") === true);
    press(open()!.querySelector(".message-row")!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(open(), "a click inside the side chat keeps it open");
    press(document.querySelector(".chat-scroll > .message-stack > .message-row")!);
    await until(() => !open() && Boolean(document.querySelector(".side-chat-card.collapsed")));
  } finally {
    await h.close();
  }
});
