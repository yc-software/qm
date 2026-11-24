import assert from "node:assert/strict";
import test from "node:test";
import { item } from "./item-fixture.ts";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Side chat did not reach the expected state");
}

test("a side chat whose turn is still running shows as working, collapsed or open", async () => {
  const startedAt = Date.now() - 180_000;
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: startedAt,
  };
  const side: CoreSession = { ...source, id: "side", threadRef: "web:tester:side", forkBoundarySeq: 0 };
  Object.assign(side, { forkedFrom: { sessionId: source.id }, working: true, workingSince: startedAt });
  side.sideChat = { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false };
  const items = [item("UserMessage", { seq: 0, createdAt: startedAt, text: "Use a durable queue" })];
  const call = (seq: number, tool: string, body: Record<string, unknown>) =>
    item("ToolCall", { seq, createdAt: startedAt + seq * 1000, tool, callId: `c${seq}`, body });
  const work = [
    call(2, "files", { action: "read", path: "src/import.ts" }),
    call(3, "execute", { command: "npm run import", purpose: "Reproduce the import error" }),
  ];
  const sideItems = [...items, item("UserMessage", { seq: 1, createdAt: startedAt, text: "Why?" }), ...work];
  const input = { runId: "r1", seq: 1, text: "Why?", createdAt: startedAt };
  const run = { status: "running", alive: true, startedAt, input, activity: work.map((entry) => ({ item: entry })) };
  let listedWorking = true;
  let listRequests = 0;
  let releaseRun!: () => void;
  const runKnown = new Promise<void>((resolve) => (releaseRun = resolve));
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, side],
    items,
    api(path) {
      if (path === "/api/sessions/source/side-chats")
        return Response.json({
          sessions: [listedWorking ? side : { ...side, working: false, workingSince: undefined }],
        });
      if (path.startsWith("/api/sessions/side?")) return Response.json({ session: side, items: sideItems });
      if (path.includes("/api/runs/active") && path.includes("side"))
        return runKnown.then(() => Response.json({ runId: "r1", run: { ...run, result: null }, queued: [] }));
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json({ ...run, result: null });
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const collapsed = () => document.querySelector<HTMLElement>(".side-chat-card.collapsed");
    await until(() => /Working\s*3m/.test(collapsed()?.querySelector(".side-chat-working")?.textContent ?? ""));
    assert.doesNotMatch(collapsed()!.textContent ?? "", /No reply|Loading/, "a running side chat shows its work");
    collapsed()!.querySelector<HTMLElement>(".side-chat-working")!.click();
    const panel = () => document.querySelector<HTMLElement>(".side-chat-panel");
    await until(() => panel()?.textContent?.includes("Why?") === true);
    const head = () => panel()?.querySelector("summary.work-head")?.textContent ?? "";
    for (let i = 0; i < 20; i++) {
      assert.doesNotMatch(panel()!.textContent ?? "", /Worked/, "a running turn must not render as finished");
      assert.match(head(), /Reproduce the import error[\s\S]*3m/, "the running step and its elapsed time show");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    listedWorking = false;
    listRequests = h.requests.filter((path) => path === "/api/sessions/source/side-chats").length;
    panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => h.requests.filter((path) => path === "/api/sessions/source/side-chats").length > listRequests);
    for (let i = 0; i < 10; i++) {
      assert.match(collapsed()?.querySelector(".side-chat-working")?.textContent ?? "", /Working/);
      assert.doesNotMatch(collapsed()!.textContent ?? "", /No reply|Loading/, "a collapsed live turn keeps working");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    sideItems.push(item("AgentMessage", { seq: 4, createdAt: Date.now(), text: "The import needs a durable queue." }));
    h.visibleConversation().onDelivery(side.threadRef);
    await until(
      () => collapsed()?.querySelector(".side-chat-preview")?.textContent?.includes("durable queue") === true,
    );
    await until(() => !collapsed()?.querySelector(".side-chat-working"));
  } finally {
    releaseRun();
    await h.close();
  }
});
