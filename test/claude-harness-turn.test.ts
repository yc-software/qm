import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

type FakeSdkMessage = Record<string, unknown>;
type Script = (prompts: AsyncIterable<{ message: { content: unknown } }>) => AsyncGenerator<FakeSdkMessage>;

const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();

let currentScript: Script = async function* () {};
let queryCalls = 0;

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
      queryCalls++;
      const generator = currentScript(prompt);
      return {
        async initializationResult() {
          return {};
        },
        async interrupt() {
          await generator.return?.(undefined as never);
        },
        close() {
          void generator.return?.(undefined as never);
        },
        [Symbol.asyncIterator]() {
          return generator;
        },
      };
    },
    tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => {
      toolHandlers.set(name, handler);
      return { name, description, schema, handler };
    },
    createSdkMcpServer: (config: unknown) => config,
  },
});

const { createClaudeHarness } = await import("../src/harness/claude-harness.ts");

function assistantMessage(id: string, text: string, usage: Record<string, number>, model?: string): FakeSdkMessage {
  return {
    type: "assistant",
    message: { id, role: "assistant", content: [{ type: "text", text }], usage, ...(model ? { model } : {}) },
    parent_tool_use_id: null,
  };
}

function resultMessage(text: string, overrides: Record<string, unknown> = {}): FakeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    num_turns: 1,
    duration_ms: 100,
    duration_api_ms: 90,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    permission_denials: [],
    ...overrides,
  };
}

function backgroundTasks(...taskIds: string[]): FakeSdkMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: taskIds.map((task_id) => ({ task_id, task_type: "agent", description: task_id })),
  };
}

function taskStarted(taskId: string): FakeSdkMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `call-${taskId}`,
    description: taskId,
    subagent_type: "code",
  };
}

function taskUpdated(taskId: string, status: string): FakeSdkMessage {
  return { type: "system", subtype: "task_updated", task_id: taskId, patch: { status } };
}

function taskNotification(taskId: string, status: string): FakeSdkMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: "",
    summary: `${taskId} ${status}`,
  };
}

async function queueClosed(iterator: AsyncIterator<unknown>): Promise<boolean> {
  return await Promise.race([
    iterator.next().then((next) => next.done === true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

function harnessTurn(overrides: Partial<HarnessTurnInput> = {}): {
  turn: HarnessTurnInput;
  entries: SessionEntry[];
  modelCalls: Array<{ model: string; inputTokens: number; entryCount: number }>;
  llmRequests: HarnessLlmRequestRecord[];
} {
  const entries: SessionEntry[] = [];
  const modelCalls: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const llmRequests: HarnessLlmRequestRecord[] = [];
  const scope = "org:test" as unknown as ScopeId;
  const turn: HarnessTurnInput = {
    session: { id: "session-1" } as HarnessTurnInput["session"],
    input: "what is the capital of france?",
    systemPrompt: "be brief",
    history: [],
    tools: {} as unknown as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    readOnly: true,
    emit: async (entry: NewEntry) => {
      const saved = {
        ...entry,
        sessionId: "session-1",
        seq: entries.length + 1,
        createdAt: Date.now(),
      } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: (rec) => {
      modelCalls.push(rec);
    },
    recordLlmRequest: (rec) => {
      llmRequests.push(rec);
    },
    ...overrides,
  };
  return { turn, entries, modelCalls, llmRequests };
}

function budgetMeterCapture(): {
  usageMeter: NonNullable<HarnessTurnInput["usageMeter"]>;
  checkpoints: number[];
  settlement(): number | undefined;
} {
  const checkpoints: number[] = [];
  let settled: number | undefined;
  return {
    usageMeter: {
      async reserve() {
        return "claude-late-child:0";
      },
      async checkpoint(_operationId, _model, _usage, cost) {
        if (cost !== undefined) checkpoints.push(cost);
      },
      async settle(_operationId, _model, _usage, cost) {
        settled = cost;
      },
    },
    checkpoints,
    settlement: () => settled,
  };
}

function rootUsageMessage(): FakeSdkMessage {
  return assistantMessage(
    "msg_root",
    "parent",
    { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    "claude-sonnet-4-5",
  );
}

function lateChildUsageMessage(): FakeSdkMessage {
  return assistantMessage(
    "msg_late_child",
    "child",
    { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    "claude-haiku-4-5",
  );
}

test("a steered turn persists every reply, not only the last result's", async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-steer";
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    await signals.send(runId, { kind: "steer", text: "now do the other three", ts: "123.456" });
    await iterator.next();
    yield assistantMessage("msg_A", "The capital of France is Paris.", {
      input_tokens: 3,
      output_tokens: 8,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 0,
    });
    yield resultMessage("The capital of France is Paris.");
    yield assistantMessage("msg_B", "All four done.", {
      input_tokens: 4,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 0,
    });
    yield resultMessage("All four done.", { num_turns: 2 });
  };

  const harness = createClaudeHarness({ signals });
  const { turn, entries } = harnessTurn({ runId });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "All four done.");
  const assistantTexts = entries
    .filter((entry) => entry.type === "assistant")
    .map((entry) => (entry.payload as { text: string }).text);
  assert.deepEqual(assistantTexts, ["The capital of France is Paris.", "All four done."]);
  const userTexts = entries
    .filter((entry) => entry.type === "user")
    .map((entry) => (entry.payload as { text: string }).text);
  assert.deepEqual(userTexts, ["what is the capital of france?", "now do the other three"]);
});

test("background children retain the MCP bridge until the authoritative task level is empty", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("completed", "failed", "killed");
    yield taskStarted("completed");
    yield taskStarted("failed");
    yield taskStarted("killed");
    yield resultMessage("parent result");
    assert.equal(await queueClosed(iterator), false);
    const childRead = await toolHandlers.get("read")!({ path: "child.txt" });
    assert.match(JSON.stringify(childRead), /bridge alive/);

    yield taskUpdated("completed", "completed");
    yield taskNotification("completed", "completed");
    yield backgroundTasks("failed", "killed");
    yield taskUpdated("failed", "failed");
    yield taskNotification("failed", "failed");
    yield backgroundTasks("killed");
    yield taskUpdated("killed", "killed");
    yield taskNotification("killed", "stopped");
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({
    readOnly: false,
    tools: {
      read: async () => ({ content: "bridge alive", sourceScopeId: "org:test" as ScopeId, shared: false }),
    } as unknown as HarnessTurnInput["tools"],
  });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
  const agentResults = entries
    .filter((entry) => entry.type === "tool_result")
    .map((entry) => entry.payload as { tool: string; isError?: boolean })
    .filter((payload) => payload.tool === "Agent");
  assert.deepEqual(
    agentResults.map((payload) => payload.isError),
    [false, true, true],
  );
});

test("an empty task level closes even when the terminal notification is missing", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield resultMessage("parent result", { total_cost_usd: 0.1 });
    assert.equal(await queueClosed(iterator), false);
    yield lateChildUsageMessage();
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const meter = budgetMeterCapture();
  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({ readOnly: false, usageMeter: meter.usageMeter });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
  assert.equal(meter.checkpoints.at(-1), 1.1);
  assert.equal(meter.settlement(), 1.1);
  assert.equal(
    entries.some((entry) => entry.type === "tool_result"),
    false,
  );
});

test("the task level remains sufficient when both edge messages are missing", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield rootUsageMessage();
    yield resultMessage("parent result", { total_cost_usd: 0.1 });
    yield lateChildUsageMessage();
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const meter = budgetMeterCapture();
  const harness = createClaudeHarness({});
  const { turn } = harnessTurn({ readOnly: false, usageMeter: meter.usageMeter });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
  assert.equal(meter.settlement(), 1.1);
});

test("a terminal notification then an empty task level closes without another root result", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield rootUsageMessage();
    yield resultMessage("parent result", { total_cost_usd: 0.1 });
    yield lateChildUsageMessage();
    yield taskNotification("child", "completed");
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const meter = budgetMeterCapture();
  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({ readOnly: false, usageMeter: meter.usageMeter });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
  assert.equal(meter.settlement(), 1.1);
  assert.equal(entries.filter((entry) => entry.type === "tool_result").length, 1);
});

test("an empty task level may precede its terminal notification", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield rootUsageMessage();
    yield resultMessage("parent result", { total_cost_usd: 0.1 });
    yield lateChildUsageMessage();
    yield backgroundTasks();
    yield taskNotification("child", "completed");
    assert.equal((await iterator.next()).done, true);
  };

  const meter = budgetMeterCapture();
  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({ readOnly: false, usageMeter: meter.usageMeter });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
  assert.equal(meter.settlement(), 1.1);
  assert.equal(entries.filter((entry) => entry.type === "tool_result").length, 1);
});

test("task edges remain a fallback when the SDK omits the background task level", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield taskStarted("child");
    yield resultMessage("parent result");
    assert.equal(await queueClosed(iterator), false);
    yield taskNotification("child", "completed");
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({});
  const { turn } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
});

test("a folded steer and a background child share the same guarded lifetime", { timeout: 5_000 }, async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-folded-steer-child";
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    await signals.send(runId, { kind: "steer", text: "fold this into the parent" });
    assert.equal((await iterator.next()).done, false);
    yield resultMessage("parent handled both prompts");
    assert.equal(await queueClosed(iterator), false);
    yield backgroundTasks();
    yield taskNotification("child", "completed");
    yield resultMessage("child joined");
  };

  const harness = createClaudeHarness({ signals });
  const { turn } = harnessTurn({ runId, readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "child joined");
});

test("an active background child remains bounded by cancellation and the wall clock", { timeout: 5_000 }, async (t) => {
  await t.test("cancel", async () => {
    const cancel = new AbortController();
    let waiting: (() => void) | undefined;
    const childWaiting = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    currentScript = async function* (prompts) {
      const iterator = prompts[Symbol.asyncIterator]();
      await iterator.next();
      yield backgroundTasks("child");
      yield taskStarted("child");
      yield resultMessage("parent result");
      waiting?.();
      await iterator.next();
    };

    const harness = createClaudeHarness({});
    const { turn } = harnessTurn({ cancel: cancel.signal, readOnly: false });
    const running = harness.turns.runTurn(turn);
    await childWaiting;
    cancel.abort();
    await running;
  });

  await t.test("wall clock", async () => {
    currentScript = async function* (prompts) {
      const iterator = prompts[Symbol.asyncIterator]();
      await iterator.next();
      yield backgroundTasks("child");
      yield taskStarted("child");
      yield resultMessage("parent result");
      await iterator.next();
    };

    const harness = createClaudeHarness({ turnWallClockMs: 20 });
    const { turn } = harnessTurn({ readOnly: false });
    await assert.rejects(() => harness.turns.runTurn(turn), /Claude turn exceeded/);
  });
});

test("a turn without background work closes after its normal result", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield resultMessage("done");
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({});
  const { turn } = harnessTurn();
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "done");
});

test("a user stop that surfaces as a non-success SDK result is a clean stop, and the stop stays pending", async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-stop-error";
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield assistantMessage("msg_partial", "partial", {
      input_tokens: 4,
      output_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 1,
    });
    await signals.send(runId, { kind: "abort" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield resultMessage("", {
      subtype: "error_during_execution",
      errors: ["turn interrupted"],
      is_error: true,
      total_cost_usd: 0.01,
    });
  };

  let settledCost: number | undefined;
  const usageMeter: NonNullable<HarnessTurnInput["usageMeter"]> = {
    async reserve() {
      return "cancelled:0";
    },
    async checkpoint() {},
    async settle(_operationId, _model, _usage, cost) {
      settledCost = cost;
    },
  };
  const harness = createClaudeHarness({ signals });
  const { turn } = harnessTurn({ runId, usageMeter });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.stopped, true, "an interrupted turn the SDK calls an error is still a user stop");
  assert.equal(result.reply, "");
  assert.equal(settledCost, 0.01);
  assert.deepEqual(
    (await signals.takePending(runId)).map((s) => s.kind),
    ["abort"],
    "the stop stays pending for the terminal drain",
  );
});

test("model calls are counted per API response and charged their real input tokens", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    const usage = {
      input_tokens: 2,
      output_tokens: 40,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 500,
    };
    yield assistantMessage("msg_shared", "thinking rendered as its own message", usage);
    yield assistantMessage("msg_shared", "and the text block again", usage);
    yield assistantMessage("msg_other", "second real call", {
      input_tokens: 1,
      output_tokens: 10,
      cache_read_input_tokens: 28_750,
      cache_creation_input_tokens: 0,
    });
    yield resultMessage("done", {
      num_turns: 2,
      usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 128_750, cache_creation_input_tokens: 500 },
    });
  };

  const harness = createClaudeHarness({});
  const { turn, modelCalls } = harnessTurn();
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.modelCalls, 2);
  assert.deepEqual(
    modelCalls.map((call) => call.inputTokens),
    [100_502, 28_751],
  );
  assert.deepEqual(result.cacheUsage, { cacheRead: 128_750, cacheWrite: 500, uncachedInput: 3 });
});

test("recorded LLM requests carry real timing and usage instead of a hardcoded truncation flag", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield assistantMessage("msg_A", "hello", {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 20,
    });
    yield resultMessage("hello", { ttft_ms: 1234, duration_ms: 5678, total_cost_usd: 0.42 });
  };

  const harness = createClaudeHarness({});
  const { turn, llmRequests } = harnessTurn();
  await harness.turns.runTurn(turn);

  assert.equal(llmRequests.length, 1);
  const record = llmRequests[0]!;
  assert.equal(record.step, 0);
  assert.equal(record.truncated, false);
  assert.equal(record.ttftMs, 1234);
  assert.equal(record.durationMs, 5678);
  assert.deepEqual(record.usage, {
    input: 12,
    output: 7,
    cacheRead: 300,
    cacheWrite: 20,
    totalTokens: 339,
    costUsd: 0.42,
  });
});

test("Claude meters one native query across parent and background child messages without double charging", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield backgroundTasks("child-metered");
    yield taskStarted("child-metered");
    yield assistantMessage(
      "msg_parent",
      "parent",
      {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 1,
      },
      "claude-sonnet-4-5",
    );
    yield assistantMessage(
      "msg_parent",
      "parent complete",
      {
        input_tokens: 5,
        output_tokens: 4,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 1,
      },
      "claude-sonnet-4-5",
    );
    yield resultMessage("parent", { total_cost_usd: 0.1 });
    yield assistantMessage(
      "msg_child",
      "child",
      {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 2,
      },
      "claude-haiku-4-5",
    );
    yield backgroundTasks();
    yield taskNotification("child-metered", "completed");
    yield resultMessage("done", { total_cost_usd: 0.3 });
  };

  const events: Array<{
    kind: "reserve" | "checkpoint" | "settle";
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    reported?: number;
  }> = [];
  const usageMeter: NonNullable<HarnessTurnInput["usageMeter"]> = {
    async reserve() {
      events.push({ kind: "reserve" });
      return "claude-query:0";
    },
    async checkpoint(_operationId, _model, usage, reported) {
      events.push({ kind: "checkpoint", usage, reported });
    },
    async settle(_operationId, _model, usage, reported) {
      events.push({ kind: "settle", usage, reported });
    },
  };

  const harness = createClaudeHarness({});
  const { turn } = harnessTurn({ usageMeter });
  await harness.turns.runTurn(turn);

  assert.equal(events[0]!.kind, "reserve");
  const reported = events.filter((event) => event.kind === "checkpoint" && event.reported !== undefined);
  assert.deepEqual(
    reported.map((event) => event.reported).filter((cost) => cost === 0.1 || cost === 0.3),
    [0.1, 0.3],
  );
  const settled = events.at(-1)!;
  assert.deepEqual(settled, {
    kind: "settle",
    usage: { input: 12, output: 7, cacheRead: 30, cacheWrite: 3 },
    reported: 0.3,
  });
});

test("Claude refuses an unpriceable query before constructing the SDK request", async () => {
  const callsBefore = queryCalls;
  const usageMeter: NonNullable<HarnessTurnInput["usageMeter"]> = {
    async reserve() {
      throw new Error("budget refused unpriced model request");
    },
    async checkpoint() {},
    async settle() {},
  };
  const harness = createClaudeHarness({});
  const { turn } = harnessTurn({ usageMeter });
  await assert.rejects(harness.turns.runTurn(turn), /unpriced model request/);
  assert.equal(queryCalls, callsBefore);
});

test("each steered prompt gets its own LLM request record", async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-steps";
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    await signals.send(runId, { kind: "steer", text: "and another thing" });
    await iterator.next();
    yield assistantMessage("msg_A", "first", {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    yield resultMessage("first", { ttft_ms: 10, duration_ms: 20, total_cost_usd: 0.1 });
    yield assistantMessage("msg_B", "second", {
      input_tokens: 9,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    yield resultMessage("second", { ttft_ms: 30, duration_ms: 40, total_cost_usd: 0.3 });
  };

  const harness = createClaudeHarness({ signals });
  const { turn, llmRequests } = harnessTurn({ runId });
  await harness.turns.runTurn(turn);

  assert.deepEqual(
    llmRequests.map((record) => record.step),
    [0, 1],
  );
  assert.equal(llmRequests[1]!.truncated, false);
  assert.equal(
    (llmRequests[1]!.promptEnvelope as { system: string }).system,
    "be brief",
    "steer steps reuse the turn's envelope — the steer text itself lives on the tape",
  );
  assert.equal(llmRequests[0]!.usage?.costUsd, 0.1);
  assert.ok(Math.abs((llmRequests[1]!.usage?.costUsd ?? 0) - 0.2) < 1e-9);
});

test("a turn that dies before its first result still records exactly one request row", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield assistantMessage("msg_A", "partial work before the crash", {
      input_tokens: 4,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    throw new Error("binary crashed");
  };

  const harness = createClaudeHarness({});
  const { turn, llmRequests } = harnessTurn();
  await assert.rejects(() => harness.turns.runTurn(turn), /binary crashed/);

  assert.equal(llmRequests.length, 1);
  assert.equal(llmRequests[0]!.step, 0);
  assert.equal(llmRequests[0]!.truncated, false);
  assert.equal((llmRequests[0]!.promptEnvelope as { system: string }).system, "be brief");
});

test("the claude harness offers metered compaction and detection so a utility role cannot silently disable them", async () => {
  const harness = createClaudeHarness({});
  assert.equal(typeof harness.models.compactHistory, "function");
  assert.equal(typeof harness.models.shouldRespond, "function");
  let reservations = 0;
  let settlements = 0;
  const usageMeter: NonNullable<HarnessTurnInput["usageMeter"]> = {
    async reserve() {
      return `utility:${reservations++}`;
    },
    async checkpoint() {},
    async settle() {
      settlements++;
    },
  };

  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield resultMessage("a compact summary of the thread");
  };
  const summary = await harness.models.compactHistory!({
    session: { id: "session-1" } as HarnessTurnInput["session"],
    history: [],
    recordModelCall: () => {},
    usageMeter,
  });
  assert.equal(summary, "a compact summary of the thread");

  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield resultMessage("YES — they asked the assistant directly");
  };
  const verdict = await harness.models.shouldRespond!({
    session: { id: "session-1" } as HarnessTurnInput["session"],
    message: "hey bot, can you check this?",
    recentContext: "",
    systemPrompt: "be brief",
    history: [],
    recordModelCall: () => {},
    usageMeter,
  });
  assert.equal(verdict.respond, true);
  assert.equal(reservations, 2);
  assert.equal(settlements, 2);
});

test("Claude one-shot, judge, security, title, and approval utilities all use native metering", async () => {
  const harness = createClaudeHarness({});
  let reservations = 0;
  let settlements = 0;
  const usageMeter: NonNullable<HarnessTurnInput["usageMeter"]> = {
    async reserve() {
      return `auxiliary:${reservations++}`;
    },
    async checkpoint() {},
    async settle() {
      settlements++;
    },
  };
  const output = (text: string) => {
    currentScript = async function* (prompts) {
      await prompts[Symbol.asyncIterator]().next();
      yield resultMessage(text);
    };
  };

  output("one-shot");
  assert.equal(await harness.models.oneShot!("system", "prompt", usageMeter), "one-shot");
  output("judge");
  assert.equal(await harness.models.judge!("system", "prompt", usageMeter), "judge");
  output('{"decision":"auto"}');
  assert.deepEqual(
    await harness.models.screenSecurity!({
      payload: "payload",
      signal: new AbortController().signal,
      recordModelCall: () => {},
      usageMeter,
    }),
    { decision: "auto" },
  );
  output("Meter every model call");
  assert.equal(await harness.models.generateTitle!("User: meter this", usageMeter), "Meter every model call");
  output("Runs the selected command.");
  assert.equal(
    await harness.models.summarizeApproval!("echo done", "approval needed", undefined, usageMeter),
    "Runs the selected command.",
  );
  assert.equal(reservations, 5);
  assert.equal(settlements, 5);
});

test("Claude preserves a committed runtime handoff when SDK interruption returns an error", async () => {
  const choice = { harnessId: "codex" as const, modelId: "gpt-6-astra" };
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    await toolHandlers.get("runtime")!({ action: "set", model: "Astra" });
    yield resultMessage("", { subtype: "error_during_execution", errors: ["turn interrupted"], is_error: true });
  };
  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({
    readOnly: false,
    tools: {
      runtime: async () => ({ ok: true, handoff: { choice, lifetime: "task" } }),
    } as unknown as HarnessTurnInput["tools"],
  });
  const result = await harness.turns.runTurn(turn);
  assert.deepEqual(result.runtimeHandoff, { choice, lifetime: "task" });
  assert.equal(result.stopped, undefined);
  assert.equal(entries.filter((entry) => entry.type === "assistant").length, 0);
  assert.ok(entries.some((entry) => entry.type === "tool_result"));
});
