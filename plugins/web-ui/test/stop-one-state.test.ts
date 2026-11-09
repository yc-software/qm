import type { RunActivityEntry } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
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

const toolSteps = (startedAt: number): RunActivityEntry[] => [
  {
    item: item("ToolCall", {
      seq: 2,
      createdAt: startedAt,
      tool: "files",
      callId: "c1",
      body: { action: "read", path: "docs/plan.md" },
    }),
  },
  {
    item: item("ToolResult", {
      seq: 3,
      createdAt: startedAt + 1000,
      tool: "files",
      callId: "c1",
      body: { action: "read", path: "docs/plan.md", bytes: 10 },
    }),
  },
];
const midTool = (startedAt: number): RunActivityEntry[] => [
  ...toolSteps(startedAt),
  {
    item: item("ToolCall", {
      seq: 4,
      createdAt: startedAt + 2000,
      tool: "execute",
      callId: "c2",
      body: { command: "npm test", purpose: "Run the test suite" },
    }),
  },
];
const finalAnswer = (startedAt: number): RunActivityEntry[] => [
  ...toolSteps(startedAt),
  {
    item: item("AgentMessage", {
      seq: 4,
      createdAt: startedAt + 2000,
      text: "Reading the plan first.",
      variant: "narration",
      body: { phase: "commentary" },
    }),
  },
  { marker: "text_start", seq: 5, createdAt: startedAt + 3000, phase: "final_answer", streamOffset: 0 },
];
const scenarios = [
  { name: "mid-tool with the fold closed", opened: false, activity: midTool, live: /Run the test suite/ },
  { name: "mid-tool with the fold opened", opened: true, activity: midTool, live: /Run the test suite/ },
  { name: "during the final answer after mid-turn text", opened: false, activity: finalAnswer, live: /plan\.md/ },
];

for (const scenario of scenarios)
  test(`pressing Stop ${scenario.name} shows one Stopping… head until the turn ends`, async () => {
    const startedAt = Date.now() - 12_000;
    const activity: RunActivityEntry[] = scenario.activity(startedAt);
    let signals = 0;
    let ended = false;
    const run = () =>
      ended
        ? {
            status: "done",
            alive: false,
            startedAt,
            finishedAt: Date.now(),
            attempt: 1,
            activity,
            result: { status: "ok", reply: "", stopped: true },
          }
        : { status: "running", alive: true, startedAt, attempt: 1, activity, result: null };
    const h = await harness({
      path: `/s/${SESSION.id}`,
      listSessions: [SESSION],
      items: [item("UserMessage", { seq: 1, createdAt: startedAt - 1000, text: "run the tests" })],
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
          return Response.json(
            ended ? { runId: null, run: null, queued: [] } : { runId: "r1", run: run(), queued: [] },
          );
        if (path.startsWith("/api/runs/r1/events")) throw new TypeError("no sse");
        if (path === "/api/runs/r1/signal" && init?.method === "POST") {
          signals++;
          return Response.json({ ok: true });
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
      const fold = () => main().querySelector<HTMLDetailsElement>("details.work, details.stopped-work");
      const polls = () => h.requests.filter((path) => path === "/api/runs/r1").length;
      await until(() => stopButton() !== null && polls() >= 2 && scenario.live.test(main().textContent ?? ""));
      if (scenario.opened) {
        fold()!.open = true;
        fold()!.dispatchEvent(new Event("toggle"));
        h.visibleConversation().drawActiveChat();
      }

      stopButton()!.click();
      await until(() => signals === 1);
      h.visibleConversation().drawActiveChat();

      const stopHeads = () =>
        [...main().querySelectorAll(".stopped-head, .work-head, .live-work-status")]
          .map((el) => el.textContent?.trim() ?? "")
          .filter((text) => /Stop/.test(text));
      assert.deepEqual(stopHeads(), ["Stopping…"], "one stop head, not a fold label plus a separate status line");
      if (scenario.opened) assert.equal(fold()!.open, true, "pressing Stop keeps a fold the person opened open");
      else assert.notEqual(fold()?.open, true, "pressing Stop does not force the fold open");

      activity.push({
        item: item("ToolResult", {
          seq: 9,
          createdAt: Date.now(),
          tool: "execute",
          callId: "c2",
          text: "interrupted",
          body: { code: 130 },
        }),
      });
      const seen = polls();
      await until(() => polls() >= seen + 2);
      h.visibleConversation().drawActiveChat();
      assert.deepEqual(stopHeads(), ["Stopping…"], "late activity does not change the stop head");

      ended = true;
      await until(() => /You stopped after/.test(main().textContent ?? ""));
      assert.equal(stopButton(), null);
      assert.doesNotMatch(main().textContent ?? "", /Stopping…|Stop requested/);
    } finally {
      await h.close();
    }
  });
