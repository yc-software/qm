import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION, type Harness } from "./deep-link-boot-fixture.ts";

test("a share link paints its conversation from the transcript, without waiting for the session list", async () => {
  const h = await harness({ path: "/s/sess-deep" });
  try {
    await h.boot();
    assert.equal(h.sessionsState.loaded, false, "the sidebar list must still be in flight");
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id, "the linked chat is already mounted");
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [SESSION.id],
      "the row the transcript carried seeds the list, so the header has its title",
    );
    assert.match(h.mainText(), /Deep linked chat/);
    assert.equal(
      h.requests.filter((p) => p === "/api/sessions").length,
      1,
      "boot must not stampede the expensive list route",
    );
    assert.equal(
      h.requests.filter((p) => p === `/api/sessions/${SESSION.id}?tailTurns=25`).length,
      1,
      "the pane reuses the prefetched transcript",
    );
    const transcript = h.requests.indexOf(`/api/sessions/${SESSION.id}?tailTurns=25`);
    assert.ok(transcript >= 0, "the transcript is fetched with the tail window");
    assert.ok(transcript < h.requests.indexOf("/me"), "and is in flight before /me is even asked");
    const approvals = h.requests.indexOf(`/api/sessions/${SESSION.id}/approvals`);
    assert.ok(approvals >= 0, "the pending approvals the mount needs are fetched too");
    assert.ok(approvals < h.requests.indexOf("/me"), "…in the same first round trip, not a serial one after it");
    assert.ok(
      h.requests.indexOf("/api/runtime-config") < h.requests.indexOf("/me"),
      "runtime-config rides the same round trip rather than queueing behind /me",
    );
  } finally {
    await h.close();
  }
});

test("a share link whose transcript 404s falls back to the session list", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true, "the fallback waits for the list");
    assert.equal(h.visibleConversation().state.sessionId, null, "no conversation is mounted");
    assert.match(h.mainText(), /Conversation not found/);
    assert.match(h.mainText(), /404/);
    assert.match(h.mainText(), /Back to chats/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(document.activeElement?.id, "conversation-error-title");
  } finally {
    await h.close();
  }
});

test("a share link whose transcript fetch flakes still opens from the session list", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    transcriptStatus: 503,
    transcriptFailures: 1,
    listSessions: [SESSION],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a session list that wins the race keeps its own decorated rows", async () => {
  const listed = { ...SESSION, working: true };
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", holdTranscript: true, listSessions: [other, listed] });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseTranscript();
    await booted;
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [other.id, SESSION.id],
      "the list the server sent keeps its order — the transcript's copy must not jump the queue",
    );
    assert.equal(
      (h.sessionsState.list.find((s) => s.id === SESSION.id) as { working?: boolean }).working,
      true,
      "…nor strip the decorations only the list route computes",
    );
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a list that omits the open conversation does not drop its row", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", listSessions: [other] });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the conversation the user is reading must keep its sidebar row",
    );
  } finally {
    await h.close();
  }
});

test("a list landing mid-open still keeps the row of the conversation being opened", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", holdApprovals: true, listSessions: [other] });
  try {
    const booted = h.boot();
    while (!h.sessionsState.openingKey) await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseApprovals();
    await booted;
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the row must survive a refresh that lands between the open starting and the mount finishing",
    );
  } finally {
    await h.close();
  }
});

test("a bare entry still mints a new chat once the list lands", async () => {
  const h = await harness({ path: "/" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.appState.currentView, "chats");
    assert.equal(h.visibleConversation().state.sessionId, null);
    assert.ok(h.visibleConversation().state.threadRef, "a fresh chat is mounted");
  } finally {
    await h.close();
  }
});

test("a view deep link still waits for the list and never fetches a transcript", async () => {
  const h = await harness({ path: "/crons" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.appState.currentView, "crons");
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.requests.filter((p) => p.startsWith(`/api/sessions/${SESSION.id}`)).length, 0);
  } finally {
    await h.close();
  }
});

test("a server failure shows a retry page rather than a missing conversation", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 503 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.match(h.mainText(), /Couldn't load conversation/);
    assert.match(h.mainText(), /Try again/);
    assert.doesNotMatch(h.mainText(), /404/);
    assert.equal(location.pathname, "/s/sess-deep");
  } finally {
    await h.close();
  }
});

test("a missing share link keeps its error page instead of restoring the saved canvas", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404, savedCanvas: true });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(h.mainText(), /Conversation not found/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector(".dockview-theme-light"), null);
    assert.equal(document.querySelector("textarea"), null);
  } finally {
    await h.close();
  }
});

async function waitForText(h: Harness, text: RegExp): Promise<void> {
  for (let i = 0; i < 100 && !text.test(h.mainText()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(h.mainText(), text);
}

test("saved empty welcome stays an empty chat and doesn't show another starter heading", async () => {
  const h = await harness({ path: "/s/sess-deep", welcome: true });
  try {
    await h.boot();
    await waitForText(h, /Connect your apps/);
    assert.ok(document.querySelector(".empty-chat qm-onboarding-welcome"));
    assert.equal(document.querySelector(".chat-cta"), null);
  } finally {
    await h.close();
  }
});

test("a failed connection refresh removes previously verified badges", async () => {
  const h = await harness({ path: "/s/sess-deep", welcome: true });
  try {
    h.setConnections([{ id: "ca_test", toolkit: "gmail" }]);
    await h.boot();
    await waitForText(h, /Gmail connected/);
    h.setConnections([], 503);
    window.dispatchEvent(new Event("focus"));
    await waitForText(h, /Could not check connected apps/);
    assert.doesNotMatch(h.mainText(), /Gmail connected/);
  } finally {
    await h.close();
  }
});
