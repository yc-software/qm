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

test("side chats follow passage order even when created in reverse order", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    title: "Garden",
  };
  const sides = [2, 1, 0].map((occurrence): CoreSession => ({
    ...source,
    id: `side-${occurrence}`,
    threadRef: `web:tester:side-${occurrence}`,
    forkedFrom: { sessionId: source.id },
    forkBoundarySeq: 0,
    sideChat: { entrySeq: 0, quote: "garden", occurrence, expanded: false },
  }));
  const items = [
    item("UserMessage", { seq: 0, createdAt: Date.now(), text: "First garden. Second garden. Third garden." }),
  ];
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, ...sides],
    items,
    api(path) {
      const side = sides.find((side) => path.startsWith(`/api/sessions/${side.id}?`));
      return side ? Response.json({ session: side, items }) : undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => document.querySelector<HTMLElement>(".side-chat-card")?.dataset.sideChatId === "side-0");
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>(".side-chat-card")].map((card) => card.dataset.sideChatId),
      ["side-0", "side-1", "side-2"],
    );
  } finally {
    await h.close();
  }
});
