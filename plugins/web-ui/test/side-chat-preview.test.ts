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

test("side-chat previews show pending work and open loaded replies immediately", async () => {
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
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Use a durable queue" })];
  let release!: () => void;
  const refresh = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshing = false;
  let working = false;
  let narration = "";
  let finalized = false;
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, side],
    items,
    api(path) {
      if (!path.startsWith("/api/sessions/side?")) return undefined;
      const response = () =>
        Response.json({
          session: { ...side, working },
          items: working
            ? [
                ...items,
                item("AgentMessage", { seq: 1, variant: "narration", text: narration }),
                ...(finalized ? [item("AgentMessage", { seq: 2, text: "Both halves are tested." })] : []),
              ]
            : [...items, item("AgentMessage", { seq: 1, createdAt: Date.now(), text: "The queue survives restarts." })],
        });
      if (path === "/api/sessions/side?tailTurns=1") return response();
      refreshing = true;
      return refresh.then(response);
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(
      () => document.querySelector(".side-chat-preview")?.textContent?.includes("survives restarts") === true,
    );
    document.querySelector<HTMLElement>(".side-chat-preview")!.click();
    await until(() => refreshing);
    await until(
      () => document.querySelector(".side-chat-conversation")?.textContent?.includes("survives restarts") === true,
    );
    assert.equal(document.querySelector(".side-chat-marker")?.getAttribute("aria-expanded"), "true");
    working = true;
    document
      .querySelector(".side-chat-panel")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => document.querySelector(".side-chat-preview")?.textContent?.trim() === "Working…");
    narration = "On it: I will build both halves and test them.";
    h.visibleConversation().onDelivery(side.threadRef);
    await until(() => document.querySelector(".side-chat-preview")?.textContent?.trim() === narration);
    finalized = true;
    h.visibleConversation().onDelivery(side.threadRef);
    await until(() => document.querySelector(".side-chat-preview")?.textContent?.trim() === "Both halves are tested.");
  } finally {
    release();
    await h.close();
  }
});
