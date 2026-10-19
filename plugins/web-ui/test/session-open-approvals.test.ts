import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

const entries = [{ seq: 1, type: "user", createdAt: Date.now(), payload: { text: "please run the deploy" } }];
const approval = { requestId: "a1", command: "deploy --prod", reason: "requires approval" };
const OTHER = { ...SESSION, id: "sess-other", threadRef: "web:tester:other", title: "Other chat" } as CoreSession;

const cards = (): number => document.querySelectorAll(".approval-btn").length;
const chatText = (): string => document.querySelector(".main")?.textContent ?? "";

// Opening must not wait on the held approvals request.
function promptly<T>(opening: Promise<T>): Promise<T> {
  const stalled = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("opening the chat waited for its approvals")), 3000),
  );
  return Promise.race([opening, stalled]);
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition did not settle");
}

test("a chat draws its transcript before its approvals arrive, then shows the card", async () => {
  const h = await harness({ path: "/s/sess-deep", entries, holdApprovals: true, approvals: () => [approval] });
  try {
    await promptly(h.boot());
    const conv = h.visibleConversation();
    assert.equal(conv.state.sessionId, SESSION.id);
    assert.match(chatText(), /please run the deploy/, "the transcript is drawn while approvals are in flight");
    assert.equal(cards(), 0);
    assert.equal(conv.hasUnresolvedApproval(), false, "nothing blocks the composer until an approval arrives");

    h.releaseApprovals();
    await until(() => cards() > 0);
    assert.match(chatText(), /please run the deploy/);
    assert.deepEqual(
      conv.activePendingApprovals().map((a) => a.requestId),
      ["a1"],
    );
    assert.equal(conv.hasUnresolvedApproval(), true, "a blocking approval locks the composer");
  } finally {
    await h.close();
  }
});

test("a transcript refresh that fails while approvals load doesn't lose the card", async () => {
  const h = await harness({ path: "/s/sess-deep", holdApprovals: true, approvals: () => [approval] });
  try {
    await promptly(h.boot());
    const conv = h.visibleConversation();
    h.setTranscriptStatus(503);
    const refreshes = h.requests.length;
    conv.onDelivery(SESSION.threadRef);
    await until(() => h.requests.slice(refreshes).some((p) => /^\/api\/sessions\/sess-deep($|\?)/.test(p)));
    await new Promise((resolve) => setTimeout(resolve, 20));

    h.releaseApprovals();
    await until(() => cards() > 0);
    assert.deepEqual(
      conv.activePendingApprovals().map((a) => a.requestId),
      ["a1"],
    );
  } finally {
    await h.close();
  }
});

test("approvals that land after switching chats stay out of the new chat", async () => {
  const h = await harness({
    path: "/",
    holdApprovals: true,
    listSessions: [SESSION, OTHER],
    approvals: (id) => (id === SESSION.id ? [approval] : []),
    api: (path) =>
      path.startsWith(`/api/sessions/${OTHER.id}?`) ? Response.json({ session: OTHER, entries: [] }) : undefined,
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    await promptly(h.openSession(SESSION as CoreSession));
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id, "the chat opens without its approvals");
    await promptly(h.openSession(OTHER));
    assert.equal(h.visibleConversation().state.sessionId, OTHER.id);

    h.releaseApprovals();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const conv = h.visibleConversation();
    assert.equal(conv.state.sessionId, OTHER.id);
    assert.equal(cards(), 0);
    assert.deepEqual(conv.activePendingApprovals(), []);
    assert.equal(conv.hasUnresolvedApproval(), false);
  } finally {
    await h.close();
  }
});
