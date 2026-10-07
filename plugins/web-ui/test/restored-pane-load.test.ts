import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import type { CoreSession, TranscriptPage } from "../src/core-bridge.ts";

const session: CoreSession = { ...SESSION, threadRef: "dm:sample", type: "dm", createdAt: 1 };
const entries = [{ seq: 1, type: "assistant", createdAt: 1, payload: { text: "Stored response" } }];
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate());
}
function restore(): void {
  localStorage.setItem(
    "web-ui:split-canvas:v1",
    JSON.stringify({
      v: 1,
      active: true,
      root: {
        kind: "split",
        a: { kind: "leaf", sessionId: session.id, threadRef: session.threadRef },
        b: { kind: "leaf", threadRef: "web:tester:other" },
      },
    }),
  );
}

test("restored transcript failure offers retry in the same pane, distinct from empty success", async () => {
  const h = await harness({ path: "/", session, entries, transcriptStatus: 500 });
  try {
    restore();
    h.releaseSessions();
    await h.boot();
    await waitFor(() => h.mainText().includes("Couldn't load this conversation."));
    assert.doesNotMatch(h.mainText(), /No readable messages/);
    const failedRequests = h.requests.filter((p) => p.startsWith(`/api/sessions/${session.id}?`)).length;
    const panes = document.querySelectorAll(".split-pane-content").length;
    const retry = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Retry");
    assert.ok(retry);
    retry.click();
    await waitFor(
      () =>
        h.requests.filter((p) => p.startsWith(`/api/sessions/${session.id}?`)).length > failedRequests &&
        h.mainText().includes("Couldn't load this conversation."),
    );
    h.setTranscriptStatus(200);
    const nextRetry = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Retry");
    assert.ok(nextRetry);
    nextRetry.click();
    await waitFor(() => h.mainText().includes("Stored response"));
    assert.equal(document.querySelectorAll(".split-pane-content").length, panes);
    assert.doesNotMatch(h.mainText(), /Couldn't load|No readable messages/);
    await h.openSession(session, Promise.resolve({ session, entries: [] } as TranscriptPage));
    assert.match(h.mainText(), /No readable messages/);
    assert.doesNotMatch(h.mainText(), /Couldn't load/);

    h.sessionsState.list = [session];
    h.setTranscriptStatus(500);
    await h.openSession(session, Promise.resolve(null));
    assert.match(h.mainText(), /Couldn't load this conversation/);
    h.setTranscriptStatus(200);
    await h.openSession(session);
    assert.match(h.mainText(), /Stored response/);
  } finally {
    await h.close();
  }
});
