import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { item } from "./item-fixture.ts";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

const MODEL = {
  id: "m",
  name: "Model",
  label: "Model",
  buttonLabel: "Model",
  provider: "openai",
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

const lane = (id: string): CoreSession => ({
  id,
  threadRef: `agent:main:subagent:${id}`,
  scopeId: "personal:tester",
  type: "dm",
  title: id,
  createdAt: Date.now() - 60_000,
  parentSessionId: SESSION.id,
  working: true,
});

test("Stop ends only the conversation's turn and offers to stop its working subagents too", async () => {
  const startedAt = Date.now() - 12_000;
  let ended = false;
  const signals: unknown[] = [];
  const run = () =>
    ended
      ? {
          status: "done",
          alive: false,
          startedAt,
          finishedAt: Date.now(),
          attempt: 1,
          activity: [],
          result: { status: "ok", reply: "(stopped)", stopped: true },
        }
      : { status: "running", alive: true, startedAt, attempt: 1, activity: [], result: null };
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION, lane("lane-a"), lane("lane-b")],
    items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "fan out the work" })],
    api: (path, init) => {
      if (path.startsWith("/api/runtime-config"))
        return Response.json({
          scopeId: "personal:tester",
          models: ["m"],
          modelCatalog: { m: MODEL },
          orgDefault: { modelId: "m", revision: 1 },
          scopeOverride: null,
          effective: { modelId: "m" },
          upgradeAvailable: false,
        });
      if (path.includes("/api/runs/active"))
        return Response.json(ended ? { runId: null, run: null, queued: [] } : { runId: "r1", run: run(), queued: [] });
      if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
      if (path === "/api/runs/r1/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { tree?: boolean };
        signals.push(body);
        if (!body.tree) ended = true;
        return Response.json({ accepted: true });
      }
      if (path === "/api/runs/r1") return Response.json(run());
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const main = () => document.querySelector<HTMLElement>(".main")!;
    const stopButton = () => document.querySelector<HTMLButtonElement>(".stop-btn");
    const stopAll = () => main().querySelector<HTMLButtonElement>(".subagent-stop-all");
    await until(() => stopButton() !== null && /2 subagents running/.test(main().textContent ?? ""));
    assert.equal(stopAll(), null, "no offer before the person stops anything");

    stopButton()!.click();
    await until(() => signals.length === 1);
    assert.deepEqual(signals[0], { kind: "abort" });
    await until(() => stopAll() !== null);
    assert.equal(stopAll()!.textContent?.trim(), "Stop 2 subagents too");

    stopAll()!.click();
    await until(() => signals.length === 2);
    assert.deepEqual(signals[1], { kind: "abort", tree: true });
    await until(() => stopAll() === null);
  } finally {
    await h.close();
  }
});
