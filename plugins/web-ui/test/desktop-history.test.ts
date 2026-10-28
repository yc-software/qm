import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("desktop app gets back/forward buttons that follow navigation state; the sidebar has no Home row", async () => {
  const h = await harness({ path: "/" });
  const listeners: Array<() => void> = [];
  const navigation = {
    canGoBack: false,
    canGoForward: false,
    addEventListener: (_: string, f: () => void) => listeners.push(f),
  };
  const moves: string[] = [];
  const back = history.back.bind(history);
  const forward = history.forward.bind(history);
  history.back = () => moves.push("back");
  history.forward = () => moves.push("forward");
  Object.assign(window, { qmDesktop: {}, navigation });
  try {
    h.releaseSessions();
    await h.boot();
    const button = (label: string) =>
      document.querySelector<HTMLButtonElement>(`.brand .history-nav [aria-label="${label}"]`)!;
    assert.equal(button("Back").disabled, true);
    assert.equal(button("Forward").disabled, true);
    navigation.canGoBack = true;
    for (const listener of listeners) listener();
    assert.equal(button("Back").disabled, false);
    assert.equal(button("Forward").disabled, true);
    button("Back").click();
    assert.deepEqual(moves, ["back"]);
    assert.equal(document.querySelector('.quick-nav [aria-label="Home"]'), null);
  } finally {
    history.back = back;
    history.forward = forward;
    Reflect.deleteProperty(window, "qmDesktop");
    Reflect.deleteProperty(window, "navigation");
    await h.close();
  }
});

test("switching conversations and views adds history entries that back/forward restore", async () => {
  const other = { ...SESSION, id: "sess-other", threadRef: "web:tester:other", title: "Other chat" };
  const h = await harness({ path: "/", listSessions: [SESSION, other] });
  const popped = () => new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    h.releaseSessions();
    h.releaseTranscript();
    await h.boot();
    await h.sessionsReady();
    const start = history.length;
    await h.openSession(SESSION as CoreSession);
    await settle();
    await h.openSession(other as CoreSession);
    await settle();
    h.switchView("settings");
    await settle();
    assert.equal(location.pathname, "/settings");
    assert.equal(history.length, start + 3);
    for (const expected of ["/s/sess-other", "/s/sess-deep"]) {
      const event = popped();
      history.back();
      await event;
      await settle();
      assert.equal(location.pathname, expected);
      assert.equal(h.visibleConversation().state.sessionId, expected.slice(3));
    }
    const event = popped();
    history.forward();
    await event;
    await settle();
    assert.equal(location.pathname, "/s/sess-other");
    assert.equal(h.visibleConversation().state.sessionId, "sess-other");
    assert.equal(history.length, start + 3, "restoring an entry keeps the forward stack");
  } finally {
    await h.close();
  }
});
