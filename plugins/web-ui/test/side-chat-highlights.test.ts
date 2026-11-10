import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Side chat did not reach the expected state");
}

test("repainting a parent preserves its nested conversation's passage highlights", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    title: "Queue design",
  };
  const side: CoreSession = {
    ...source,
    id: "side",
    threadRef: "web:tester:side",
    forkedFrom: { sessionId: source.id },
    forkBoundarySeq: 0,
    sideChat: { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false },
  };
  const nested: CoreSession = {
    ...side,
    id: "nested",
    threadRef: "web:tester:nested",
    forkedFrom: { sessionId: side.id },
    forkBoundarySeq: 1,
    sideChat: { entrySeq: 1, quote: "retries", occurrence: 0, expanded: false },
  };
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Use a durable queue" })];
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, side, nested],
    items,
    api(path) {
      if (path.startsWith("/api/sessions/side?"))
        return Response.json({
          session: side,
          items: [...items, item("UserMessage", { seq: 1, createdAt: Date.now(), text: "Explain retries" })],
        });
      if (path.startsWith("/api/sessions/nested?")) return Response.json({ session: nested, items: [] });
      return undefined;
    },
  });
  try {
    Object.defineProperty(window.Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [{ left: 100, right: 160, top: 100, bottom: 120, width: 60, height: 20 }],
    });
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(".side-chat-marker")));
    document.querySelector<HTMLButtonElement>(".side-chat-marker")!.click();
    await until(() => Boolean(document.querySelector(".side-chat-conversation .side-chat-marker")));
    const parent = document.querySelector(".chat-scroll")!;
    const child = document.querySelector(".side-chat-conversation .chat-scroll")!;
    child.dispatchEvent(new window.MouseEvent("mouseleave"));
    const highlight = child.querySelector('.side-chat-highlight[data-key="nested:0"]');
    assert.ok(highlight);
    parent.dispatchEvent(new window.MouseEvent("mouseleave"));
    assert.equal(highlight.isConnected, true);
    assert.equal(child.querySelector('.side-chat-highlight[data-key="nested:0"]'), highlight);
    assert.ok(parent.querySelector(':scope > .message-stack > .side-chat-markers > [data-key="side:0"]'));
  } finally {
    await h.close();
  }
});
