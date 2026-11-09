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

test("overlapping passages offer each chat and delayed expansion never overrides navigation", async () => {
  let delayed: "expand" | "refresh" = "expand";
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    title: "Queue design",
  };
  const other = { ...source, id: "other", threadRef: "web:tester:other" };
  const sides = ["Crash recovery", "Retry ordering"].map((title, index): CoreSession => ({
    ...source,
    id: `side-${index}`,
    threadRef: `web:tester:side-${index}`,
    title,
    forkedFrom: { sessionId: source.id },
    forkBoundarySeq: 0,
    sideChat: { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false },
  }));
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Use a durable queue" })];
  let release!: () => void;
  let held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let expanding = false;
  let previewText = "Answer about";
  let waiting = false;
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, other, ...sides],
    items,
    api(path) {
      if (path === "/api/sessions/side-1/expand") {
        expanding = true;
        return (async () => {
          if (delayed === "expand") {
            waiting = true;
            await held;
          }
          return Response.json({ session: { ...sides[1], sideChat: { ...sides[1]!.sideChat, expanded: true } } });
        })();
      }
      if (path.startsWith("/api/sessions?") && expanding && delayed === "refresh") {
        waiting = true;
        return held.then(() => Response.json({ sessions: [source, other, ...sides], nextCursor: null }));
      }
      if (path.startsWith("/api/sessions/other?")) return Response.json({ session: other, items });
      for (const side of sides) {
        if (path === `/api/sessions/${side.id}?tailTurns=1`)
          return Response.json({
            session: side,
            items: [
              ...items,
              item("AgentMessage", {
                seq: 1,
                text: `${previewText} ${side.title}`,
                variant: null,
                createdAt: Date.now(),
              }),
            ],
          });
        if (path.startsWith(`/api/sessions/${side.id}?`))
          return Response.json({
            session: side,
            items: [
              ...items,
              item("UserMessage", { seq: 1, text: "> durable\n\nExplain crash recovery", createdAt: Date.now() }),
              item("AgentMessage", { seq: 2, text: "The next worker retries the task.", createdAt: Date.now() }),
            ],
          });
      }
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    for (delayed of ["expand", "refresh"] as const) {
      expanding = false;
      waiting = false;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await h.openSession(source);
      await until(() => document.querySelectorAll(".side-chat-marker").length === 2);
      await until(() =>
        [...document.querySelectorAll(".side-chat-preview")].every((preview) =>
          preview.textContent?.includes("Answer about"),
        ),
      );
      assert.equal(
        document.querySelectorAll(".chat-scroll > .message-stack > .side-chat-markers .side-chat-card").length,
        2,
      );
      assert.match(document.querySelector(".side-chat-markers")!.textContent!, /Answer about Crash recovery/);
      assert.match(document.querySelector(".side-chat-markers")!.textContent!, /Answer about Retry ordering/);
      previewText = "Completed response about";
      h.visibleConversation().onDelivery(sides[0]!.threadRef);
      await until(() => document.querySelector(".side-chat-preview")?.textContent?.includes(previewText) === true);
      previewText = "Answer about";
      h.visibleConversation().onDelivery(sides[0]!.threadRef);
      await until(() => document.querySelector(".side-chat-preview")?.textContent?.includes(previewText) === true);
      Object.defineProperty(window.Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [{ left: 100, right: 160, top: 100, bottom: 120, width: 60, height: 20 }],
      });
      window.getSelection()!.removeAllRanges();
      document.querySelector(".message-row p")!.dispatchEvent(
        new window.MouseEvent("mouseup", {
          bubbles: true,
          clientX: 120,
          clientY: 110,
        }),
      );
      const choices = [...document.querySelectorAll<HTMLButtonElement>(".side-chat-marker.choice")];
      assert.equal(choices.length, 2);
      assert.match(choices[0]!.textContent!, /Crash recovery/);
      assert.match(choices[1]!.textContent!, /Retry ordering/);
      choices[1]!.click();
      await until(() => Boolean(document.querySelector(".side-chat-conversation .custom-chat")));
      await until(() =>
        Boolean(
          document.querySelector(".side-chat-panel .user-bubble")?.textContent?.includes("Explain crash recovery"),
        ),
      );
      assert.equal(document.querySelector(".side-chat-panel .user-bubble blockquote"), null);
      assert.match(document.querySelector(".side-chat-panel .user-row .speaker-label")!.textContent!, /You/);
      assert.ok(h.requests.some((path) => path.startsWith("/api/sessions/side-1?")));
      document.querySelector<HTMLButtonElement>('.side-chat-panel [aria-label="Open as session"]')!.click();
      await until(() => waiting);
      await h.openSession(other);
      assert.equal(h.visibleConversation().state.sessionId, "other");
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(h.visibleConversation().state.sessionId, "other");
      assert.equal(document.querySelector(".side-chat-panel"), null);
    }
  } finally {
    release();
    await h.close();
  }
});
