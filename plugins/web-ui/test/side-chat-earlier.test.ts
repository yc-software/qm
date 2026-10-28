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

test("open a side chat from an earlier inherited assistant reply", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    forkedFrom: { sessionId: "parent" },
    forkBoundarySeq: 1,
  };
  const entries = [
    "Explain queues",
    "Persisted jobs survive worker crashes",
    "Give an example",
    "Retry the job safely",
  ].map((text, seq) => ({
    seq,
    type: seq % 2 ? "assistant" : "user",
    createdAt: Date.now(),
    payload: { text },
  }));
  let forkBody: unknown;
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source],
    entries,
    api(path, init) {
      if (path.endsWith("/side-chats")) return Response.json({ sessions: [] });
      if (path === "/api/sessions/source/fork") {
        forkBody = JSON.parse(String(init?.body));
        return Response.json({
          session: {
            ...source,
            id: "side",
            threadRef: "web:tester:side",
            forkedFrom: { sessionId: "source" },
            forkBoundarySeq: 3,
            sideChat: { entrySeq: 1, quote: "worker crashes", expanded: false },
          },
          entries,
        });
      }
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(".fork-origin-toggle")));
    document.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
    await until(() =>
      [...document.querySelectorAll(".message-row p")].some((p) => p.textContent === entries[1].payload.text),
    );
    const paragraph = [...document.querySelectorAll(".message-row p")].find(
      (p) => p.textContent === entries[1].payload.text,
    )!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 22);
    range.setEnd(paragraph.firstChild!, paragraph.textContent!.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    Object.defineProperty(range, "getBoundingClientRect", { value: () => ({ left: 100, top: 150 }) });
    paragraph.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    const discuss = document.querySelector<HTMLButtonElement>(".side-chat-discuss");
    assert.ok(discuss);
    discuss.click();
    await until(() => Boolean(forkBody));
    assert.deepEqual(forkBody, { upToSeq: 3, sideChat: { entrySeq: 1, quote: "worker crashes", occurrence: 0 } });
  } finally {
    await h.close();
  }
});
