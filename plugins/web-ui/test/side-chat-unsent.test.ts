import assert from "node:assert/strict";
import test from "node:test";
import { item } from "./item-fixture.ts";
import { harness, runtimeConfig } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

test("leaving a side chat before sending keeps a typed draft as a card and drops an empty one", async () => {
  const base = { scopeId: "personal:tester", type: "dm", canContinue: true, createdAt: 0 } as const;
  const source: CoreSession = { ...base, id: "source", threadRef: "web:tester:source" };
  const sideChat = { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false };
  const forkedFrom = { sessionId: "source" };
  const side = { ...base, id: "side", threadRef: "web:tester:side", forkBoundarySeq: 0, sideChat, forkedFrom };
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Use a durable queue" })];
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source],
    items,
    api(path) {
      if (path.startsWith("/api/runtime-config")) return Response.json(runtimeConfig);
      if (path.endsWith("/side-chats")) return Response.json({ sessions: [] });
      if (path.endsWith("/fork") || path.startsWith("/api/sessions/side?"))
        return Response.json({ session: side, items });
      return undefined;
    },
  });
  const outside = () => {
    for (const kind of ["pointerdown", "click"])
      document.querySelector(".message-row")!.dispatchEvent(new window.MouseEvent(kind, { bubbles: true }));
  };
  const input = () => document.querySelector<HTMLTextAreaElement>(".side-chat-card .side-chat-panel textarea");
  const ask = async () => {
    const paragraph = document.querySelector(".message-row p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 4);
    range.setEnd(paragraph.firstChild!, 11);
    Object.defineProperty(range, "getBoundingClientRect", { value: () => ({ left: 100, top: 150 }) });
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new window.Event("selectionchange"));
    paragraph.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".side-chat-discuss")!.click();
    await until(() => Boolean(input()));
  };
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(".message-row p")));
    await ask();
    outside();
    await until(() => !document.querySelector(".side-chat-card"));
    await ask();
    input()!.value = "Why durable?";
    input()!.dispatchEvent(new window.Event("input", { bubbles: true }));
    outside();
    await until(() => document.querySelector(".side-chat-preview.draft")?.textContent === "Draft Why durable?");
  } finally {
    await h.close();
  }
});
