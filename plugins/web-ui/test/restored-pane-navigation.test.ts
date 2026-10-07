import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

test("a restored load cannot overwrite a newer open of the same session", async () => {
  const session: CoreSession = { ...SESSION, type: "dm", createdAt: 1, threadRef: "dm:sample" };
  const h = await harness({ path: "/", session, holdTranscript: true });
  try {
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
    h.releaseSessions();
    await h.boot();
    for (let i = 0; i < 100 && !h.requests.some((p) => p.startsWith(`/api/sessions/${session.id}?`)); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(h.requests.some((p) => p.startsWith(`/api/sessions/${session.id}?`)));
    await h.openSession(
      session,
      Promise.resolve({
        session,
        entries: [{ seq: 2, type: "assistant", createdAt: 2, payload: { text: "Newer response" } }],
      }),
    );
    h.releaseTranscript();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(h.mainText(), /Newer response/);
    assert.doesNotMatch(h.mainText(), /No readable messages/);
  } finally {
    await h.close();
  }
});
