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

test("opening a side chat whose turn is still running never shows the turn as finished", async () => {
  const startedAt = Date.now() - 180_000;
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: startedAt - 60_000,
    title: "Import pipeline",
  };
  const side: CoreSession = {
    ...source,
    id: "side",
    threadRef: "web:tester:side",
    forkedFrom: { sessionId: source.id },
    forkBoundarySeq: 0,
    sideChat: { entrySeq: 0, quote: "durable", occurrence: 0, expanded: false },
    working: true,
    workingSince: startedAt,
  };
  const items = [item("UserMessage", { seq: 0, createdAt: startedAt - 1000, text: "Use a durable queue" })];
  const call = item("ToolCall", {
    seq: 2,
    createdAt: startedAt + 1000,
    tool: "files",
    callId: "c1",
    body: { action: "read", path: "src/import.ts" },
  });
  const result = item("ToolResult", {
    seq: 3,
    createdAt: startedAt + 2000,
    tool: "files",
    callId: "c1",
    body: { action: "read", path: "src/import.ts", bytes: 10 },
  });
  const command = item("ToolCall", {
    seq: 4,
    createdAt: startedAt + 3000,
    tool: "execute",
    callId: "c2",
    body: { command: "npm run import", purpose: "Reproduce the import error" },
  });
  const sideItems = [
    ...items,
    item("UserMessage", { seq: 1, createdAt: startedAt, text: "Why does the import fail?" }),
    call,
    result,
    command,
  ];
  const run = () => ({
    status: "running",
    alive: true,
    startedAt,
    attempt: 1,
    input: { runId: "r1", seq: 1, text: "Why does the import fail?", createdAt: startedAt },
    activity: [{ item: call }, { item: result }, { item: command }],
    result: null,
  });
  let releaseRun!: () => void;
  const runKnown = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source, side],
    items,
    api(path) {
      if (path.startsWith("/api/sessions/side?")) return Response.json({ session: side, items: sideItems });
      if (path.includes("/api/runs/active") && path.includes("side"))
        return runKnown.then(() => Response.json({ runId: "r1", run: run(), queued: [] }));
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1") return Response.json(run());
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => document.querySelector(".side-chat-preview") !== null);
    await until(() => !/Loading/.test(document.querySelector(".side-chat-preview")?.textContent ?? "Loading"));
    document.querySelector<HTMLElement>(".side-chat-preview")!.click();
    const panel = () => document.querySelector<HTMLElement>(".side-chat-panel");
    await until(() => panel()?.textContent?.includes("Why does the import fail?") === true);
    const head = () => panel()?.querySelector("summary.work-head")?.textContent ?? "";
    for (let i = 0; i < 20; i++) {
      assert.doesNotMatch(panel()!.textContent ?? "", /Worked/, "a running turn must not render as finished");
      assert.match(head(), /Reproduce the import error/, "the running step shows while the run is looked up");
      assert.match(head(), /3m/, "the elapsed time counts from when the turn started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseRun();
    await until(() => h.requests.some((path) => path === "/api/runs/r1" || path.startsWith("/api/runs/r1/events")));
    assert.match(head(), /Reproduce the import error/);
    assert.doesNotMatch(panel()!.textContent ?? "", /Worked/);
  } finally {
    releaseRun();
    await h.close();
  }
});
