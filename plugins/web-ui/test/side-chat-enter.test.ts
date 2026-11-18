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

test("Enter typed while a new side chat is still opening sends the first message once it opens", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    title: "Queue design",
  };
  const items = [item("UserMessage", { seq: 0, createdAt: Date.now(), text: "Use a durable queue" })];
  const fork: CoreSession = {
    ...source,
    id: "side",
    threadRef: "web:tester:side",
    forkedFrom: { sessionId: source.id },
    forkBoundarySeq: 0,
    sideChat: { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false },
  };
  const turns: Array<{ threadRef?: string; text?: string }> = [];
  let releaseFork!: () => void;
  const forkReady = new Promise<void>((resolve) => {
    releaseFork = resolve;
  });
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source],
    items,
    api(path, init) {
      if (path.startsWith("/api/runtime-config"))
        return Response.json({
          scopeId: "personal:tester",
          models: ["m"],
          modelCatalog: {
            m: {
              id: "m",
              name: "Test model",
              provider: "openai",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
          orgDefault: { modelId: "m", revision: 1 },
          scopeOverride: null,
          effective: { modelId: "m" },
          upgradeAvailable: false,
        });
      if (path === "/api/sessions/source/side-chats") return Response.json({ sessions: [] });
      if (path === "/api/sessions/side/side-chats") return Response.json({ sessions: [] });
      if (path === "/api/sessions/source/fork") return forkReady.then(() => Response.json({ session: fork, items }));
      if (path.startsWith("/api/sessions/side?") || path === "/api/sessions/side")
        return Response.json({ session: fork, items });
      if (path === "/api/turn") {
        turns.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "queued", runId: "run-1" });
      }
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(".message-row p")));
    const paragraph = document.querySelector(".message-row p")!;
    const text = paragraph.firstChild!;
    const range = document.createRange();
    const start = text.textContent!.indexOf("durable");
    range.setStart(text, start);
    range.setEnd(text, start + "durable".length);
    Object.defineProperty(range, "getBoundingClientRect", { value: () => ({ left: 100, top: 150, bottom: 170 }) });
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".side-chat-discuss")!.click();
    const pending = document.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea")!;
    pending.value = "What does this mean?";
    pending.dispatchEvent(new window.Event("input", { bubbles: true }));
    for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const key = new window.KeyboardEvent("keydown", { key: "Enter", ...options, bubbles: true, cancelable: true });
      pending.dispatchEvent(key);
      assert.equal(key.defaultPrevented, false);
    }
    const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.querySelector(".side-chat-draft textarea")!.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(document.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea")!.readOnly, true);
    assert.equal(turns.length, 0);
    releaseFork();
    await until(() => turns.length === 1);
    assert.equal(turns[0]!.threadRef, "web:tester:side");
    assert.match(turns[0]!.text!, /What does this mean\?$/);
    assert.match(turns[0]!.text!, /durable/);
    assert.equal(document.querySelector<HTMLTextAreaElement>(".side-chat-conversation textarea")!.value, "");
  } finally {
    releaseFork();
    await h.close();
  }
});
