import assert from "node:assert/strict";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

test("a new pane adopts its saved identity and later title while its first turn is streaming", async () => {
  const listSessions: CoreSession[] = [];
  const h = await harness({ path: "/", listSessions });
  let stopStream = (): void => {};
  let turn: Promise<void> | undefined;
  let turnError: unknown;
  try {
    h.releaseSessions();
    await h.boot();
    const conversation = h.visibleConversation();
    const { agent, threadRef } = conversation.state;
    assert.ok(agent);
    assert.ok(threadRef);
    assert.equal(conversation.state.sessionId, null);
    assert.match(document.querySelector(".split-pane-title-text")?.textContent ?? "", /New session/);
    await agent.waitForIdle();
    agent.state.model = getModel("openai", "gpt-4o");
    agent.streamFn = () =>
      new Promise((_resolve, reject) => {
        stopStream = () => reject(new Error("QA stream stopped"));
      });
    turn = agent.prompt("Investigate live title updates").catch((error) => {
      turnError = error;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(agent.state.isStreaming, String(turnError));
    const session: CoreSession = {
      id: "newly-saved-session",
      threadRef,
      scopeId: "personal:tester",
      type: "dm",
      createdAt: Date.now(),
      title: "",
    };
    listSessions.push(session);
    await h.refreshSessions();
    assert.equal(conversation.state.sessionId, session.id);
    assert.equal(conversation.state.rememberedSessionId, session.id);
    assert.equal(location.pathname, `/s/${session.id}`);
    assert.ok(document.querySelector('[aria-label="Share conversation"]'));
    assert.match(localStorage.getItem("web-ui:split-canvas:v1") ?? "", /newly-saved-session/);

    session.title = "Investigate live title updates";
    await h.refreshSessions();
    assert.equal(document.querySelector(".split-pane-title-text")?.textContent, session.title);
    assert.match(document.title, /Investigate live title updates/);
    assert.ok(agent.state.isStreaming, String(turnError));
    assert.equal(conversation.state.agent, agent);
    assert.equal(document.querySelectorAll(".split-pane-content").length, 1);

    session.title = "Renamed during the same turn";
    await h.refreshSessions();
    assert.equal(document.querySelector(".split-pane-title-text")?.textContent, session.title);
    assert.ok(agent.state.isStreaming, String(turnError));
  } finally {
    stopStream();
    await turn;
    await h.close();
  }
});
