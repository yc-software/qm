import assert from "node:assert/strict";
import test from "node:test";
import { item } from "./item-fixture.ts";
import { harness, runtimeConfig } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Side chat did not reach the expected state");
}

test("a side chat shows as working while its turn is sent or running, collapsed or open", async () => {
  const startedAt = Date.now() - 180_000;
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: startedAt,
  };
  const idle: CoreSession = { ...source, id: "side", threadRef: "web:tester:side", forkBoundarySeq: 0 };
  Object.assign(idle, { forkedFrom: { sessionId: source.id } });
  idle.sideChat = { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false };
  const side = { ...idle, working: true, workingSince: startedAt };
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
  let listed: CoreSession = side;
  let running = true;
  let releaseRun!: () => void;
  const runKnown = new Promise<void>((resolve) => (releaseRun = resolve));
  let answer!: (response: Response | Promise<Response>) => void;
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, side],
    items,
    api(path) {
      if (path.startsWith("/api/runtime-config")) return Response.json(runtimeConfig);
      if (path === "/api/sessions/source/side-chats") return Response.json({ sessions: [listed] });
      if (path.startsWith("/api/sessions/side?")) return Response.json({ session: listed, items: sideItems });
      if (path.includes("/api/runs/active") && path.includes("side"))
        return running
          ? runKnown.then(() => Response.json({ runId: "r1", run: { ...run, result: null }, queued: [] }))
          : Response.json({ runId: null, queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json({ ...run, result: null });
      if (path === "/api/turn") return new Promise<Response>((resolve) => (answer = resolve));
      return undefined;
    },
  });
  const collapsed = () => document.querySelector<HTMLElement>(".side-chat-card.collapsed");
  const working = () => collapsed()?.querySelector(".side-chat-working")?.textContent ?? "";
  const preview = () => collapsed()?.querySelector(".side-chat-preview")?.textContent ?? "";
  const panel = () => document.querySelector<HTMLElement>(".side-chat-panel");
  const escape = () => panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const settled = async (wake: () => void) => {
    listed = idle;
    wake();
    await until(() => {
      assert.doesNotMatch(collapsed()!.textContent ?? "", /No reply|Loading/, "the card never falls back to a note");
      return !working();
    });
    assert.match(preview(), /durable queue/);
  };
  const ask = async () => {
    collapsed()!.querySelector<HTMLElement>(".side-chat-preview")!.click();
    await until(() => Boolean(panel()?.querySelector("textarea")));
    const box = panel()!.querySelector("textarea")!;
    box.value = "And then?";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    const turns = h.requests.filter((path) => path === "/api/turn").length;
    box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => h.requests.filter((path) => path === "/api/turn").length > turns);
    escape();
    await until(() => /Working/.test(working()));
    assert.match(preview(), /durable queue/, "the earlier reply stays while the next question is sent");
  };
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => /Working\s*3m/.test(working()));
    assert.doesNotMatch(collapsed()!.textContent ?? "", /No reply|Loading/, "a running side chat shows its work");
    collapsed()!.querySelector<HTMLElement>(".side-chat-working")!.click();
    await until(() => panel()?.textContent?.includes("Why?") === true);
    const head = () => panel()?.querySelector("summary.work-head")?.textContent ?? "";
    for (let i = 0; i < 20; i++) {
      assert.doesNotMatch(panel()!.textContent ?? "", /Worked/, "a running turn must not render as finished");
      assert.match(head(), /Reproduce the import error[\s\S]*3m/, "the running step and its elapsed time show");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseRun();
    escape();
    const lists = () => h.requests.filter((path) => path === "/api/sessions/source/side-chats").length;
    const before = lists();
    await until(() => lists() > before);
    assert.match(working(), /Working\s*3m/, "a collapsed running turn keeps working");
    running = false;
    sideItems.push(item("AgentMessage", { seq: 4, createdAt: Date.now(), text: "The import needs a durable queue." }));
    await settled(() => [1, 2].forEach(() => h.visibleConversation().onDelivery(side.threadRef)));
    await ask();
    listed = side;
    answer(Response.json({ status: "queued", runId: "r2" }));
    await until(() => /Working\s*3m/.test(working()));
    await settled(() => h.visibleConversation().catchUp());
    await ask();
    answer(Promise.reject(new TypeError("offline")));
    await until(() => !working());
    assert.match(preview(), /durable queue/, "a question that never reached the server does not keep working");
  } finally {
    releaseRun();
    await h.close();
  }
});
