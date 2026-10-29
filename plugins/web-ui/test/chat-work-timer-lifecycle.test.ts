import assert from "node:assert/strict";
import test from "node:test";
import { entriesToMessages, type AssistantWork } from "../src/core-bridge.ts";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("replacing and disposing a chat disconnects its live work timer", async (t) => {
  const h = await harness({ path: "/", openNewChat: true });
  try {
    h.releaseSessions();
    await h.boot();
    const chat = h.visibleConversation();
    const interval = globalThis.setInterval;
    const clear = globalThis.clearInterval;
    const ticking = new Set<ReturnType<typeof setInterval>>();
    t.mock.method(globalThis, "setInterval", (fn: () => void, delay: number) => {
      const id = interval(fn, delay);
      if (delay === 50) ticking.add(id);
      return id;
    });
    t.mock.method(globalThis, "clearInterval", (id: ReturnType<typeof setInterval>) => {
      ticking.delete(id);
      clear(id);
    });
    for (const release of [
      () => chat.newChat(),
      () => chat.mountReadOnly({ ...SESSION, type: "dm", createdAt: 1000, canContinue: false }, []),
      () => chat.dispose(),
    ]) {
      chat.newChat();
      const agent = chat.state.agent!;
      const startedAt = Date.now() - 1230;
      const message = entriesToMessages([
        { seq: 1, type: "assistant", payload: { text: "QA", workStartedAt: startedAt }, createdAt: startedAt },
      ])[0] as AssistantWork;
      message.content = [];
      message.work = {
        status: "working",
        startedAt,
        activity: [
          {
            seq: 2,
            parentSeq: null,
            type: "tool_call",
            payload: { tool: "execute", command: "printf start" },
            createdAt: startedAt,
          },
          {
            seq: 3,
            parentSeq: null,
            type: "tool_call",
            payload: { tool: "execute", command: "sleep 10" },
            createdAt: startedAt,
          },
        ],
      };
      Object.assign(agent.state, { messages: [], streamingMessage: message, isStreaming: true });
      chat.drawActiveChat();
      const oldHost = chat.state.host!;
      assert.match(oldHost.textContent ?? "", /1s/);
      assert.equal(ticking.size, 1);
      release();
      assert.equal(oldHost.textContent, "");
      assert.equal(ticking.size, 0);
    }
  } finally {
    t.mock.restoreAll();
    await h.close();
  }
});
