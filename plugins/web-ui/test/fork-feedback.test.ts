import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("fork feedback survives delayed success, failure, and navigation", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    type: "dm",
    createdAt: Date.now(),
    title: "Source conversation",
  };
  const entries = [{ seq: 0, type: "user", createdAt: Date.now(), payload: { text: "Fork this message" } }];
  const h = await harness({ path: "/s/source", session: source, listSessions: [source], entries });
  let finish: (response: Response) => void = () => {};
  const anchorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLAnchorElement");
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    Object.defineProperty(globalThis, "HTMLAnchorElement", { configurable: true, value: window.HTMLAnchorElement });
    const baseFetch = globalThis.fetch;
    for (const outcome of ["success", "failure", "navigate"] as const) {
      await h.openSession(source);
      await until(() => document.querySelector(".msg-fork") !== null);
      const response = new Promise<Response>((resolve) => (finish = resolve));
      let requests = 0;
      globalThis.fetch = (input, init) => {
        if (String(input).endsWith("/api/sessions/source/fork")) {
          requests++;
          return response;
        }
        return baseFetch(input, init);
      };
      const button = document.querySelector<HTMLButtonElement>(".msg-fork")!;
      button.click();
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("aria-busy"), "true");
      button.dispatchEvent(new window.MouseEvent("mouseenter"));
      assert.equal(document.querySelector("[role=tooltip]")?.textContent, "Forking...");
      button.dispatchEvent(new window.MouseEvent("mouseleave"));
      assert.match(document.querySelector(".session[aria-busy=true]")?.textContent ?? "", /Forking/);
      button.click();
      await until(() => requests === 1);
      await h.refreshSessions();
      assert.match(document.querySelector(".session[aria-busy=true]")?.textContent ?? "", /Forking/);
      const pending = h.sessionsState.list.find((session) => !session.id)!;
      await h.openSession(pending as CoreSession);
      assert.equal(h.visibleConversation().state.sessionId, source.id);
      const conv = h.visibleConversation();
      if (outcome === "navigate") conv.newChat();
      const newThread = conv.state.threadRef;
      const fork: CoreSession = {
        ...source,
        id: "fork",
        threadRef: "web:tester:fork",
        title: "Source conversation (fork)",
        forkedFrom: { sessionId: source.id, title: source.title },
        forkBoundarySeq: 0,
      };
      const refreshes = h.requests.filter((path) => path === "/api/sessions").length;
      finish(
        outcome === "failure"
          ? Response.json({ error: "Could not copy history" }, { status: 500 })
          : Response.json({ session: fork, entries }),
      );
      await until(() => !document.querySelector(".session[aria-busy=true]"));
      assert.equal(requests, 1);
      assert.equal(
        h.sessionsState.list.some((session) => !session.id),
        false,
      );
      if (outcome === "failure") {
        assert.equal(conv.state.sessionId, source.id);
        assert.equal(document.querySelector<HTMLButtonElement>(".msg-fork")?.disabled, false);
        assert.match(h.mainText(), /Could not copy history/);
      } else {
        assert.equal(h.sessionsState.list.filter((session) => session.id === fork.id).length, 1);
        assert.equal(h.requests.filter((path) => path === "/api/sessions").length, refreshes);
        if (outcome === "navigate") assert.equal(conv.state.threadRef, newThread);
        else assert.equal(conv.state.sessionId, fork.id);
      }
    }
  } finally {
    finish(Response.json({ error: "test ended" }, { status: 500 }));
    await h.close();
    if (anchorDescriptor) Object.defineProperty(globalThis, "HTMLAnchorElement", anchorDescriptor);
    else Reflect.deleteProperty(globalThis, "HTMLAnchorElement");
  }
});
