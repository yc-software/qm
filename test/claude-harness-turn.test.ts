import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";
import { findTrailingPartialTurn, resumeStrategy, turnAtSeq } from "../src/core/turn-resume.ts";
import { createGoalRecord } from "../src/harness/goal.ts";

type FakeSdkMessage = Record<string, unknown>;
type Script = (prompts: AsyncIterable<{ message: { content: unknown } }>) => AsyncGenerator<FakeSdkMessage>;

const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();

let capturedOptions: Record<string, unknown> = {};

let currentScript: Script = async function* () {};

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<{ message: { content: unknown } }>;
      options: Record<string, unknown>;
    }) => {
      capturedOptions = options;
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

function assistantMessage(id: string, text: string, usage: Record<string, number>): FakeSdkMessage {
  return {
    type: "assistant",
    message: { id, role: "assistant", content: [{ type: "text", text }], usage },
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

function sessionState(state: "idle" | "running" | "requires_action"): FakeSdkMessage {
  return { type: "system", subtype: "session_state_changed", state };
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

test("Claude notices use each turn's timezone without leaking it into later turns", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield resultMessage("done");
  };
  const harness = createClaudeHarness({});
  for (const [timezone, summer, winter] of [
    ["America/Los_Angeles", 14, 13],
    ["america/los_angeles", 14, 13],
    ["Asia/Kolkata", 2, 2],
  ] as const) {
    await harness.turns.runTurn(harnessTurn({ timezone }).turn);
    const env = capturedOptions.env as NodeJS.ProcessEnv;
    const actual = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          'process.stdout.write(JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hours: ["2026-10-09T21:00:00Z", "2026-12-09T21:00:00Z"].map(value => new Date(value).getHours()) }))',
        ],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(env.TZ, new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone);
    assert.deepEqual(actual.hours, [summer, winter]);
  }
  await harness.turns.runTurn(harnessTurn().turn);
  assert.equal((capturedOptions.env as NodeJS.ProcessEnv).TZ, undefined);
});

test("a steered turn persists every reply, not only the last result's", async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-steer";
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    yield (await iterator.next()).value as unknown as FakeSdkMessage;
    await signals.send(runId, { kind: "steer", text: "now do the other three", ts: "123.456" });
    yield (await iterator.next()).value as unknown as FakeSdkMessage;
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

for (const shutdown of [false, true]) {
  test(`a user stop stays explicit when shutdown=${shutdown}`, async () => {
    const cancel = new AbortController();
    const signals = createMemoryRunSignalStore();
    const runId = "run-stop-error";
    currentScript = async function* (prompts) {
      await prompts[Symbol.asyncIterator]().next();
      await signals.send(runId, { kind: "abort" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (shutdown) cancel.abort();
      yield resultMessage("", { subtype: "error_during_execution", errors: ["turn interrupted"], is_error: true });
    };

    const harness = createClaudeHarness({ signals });
    const { turn } = harnessTurn({ runId, cancel: cancel.signal });
    const result = await harness.turns.runTurn(turn);

    assert.equal(result.stopped, true, "an interrupted turn the SDK calls an error is still a user stop");
    assert.equal(result.stoppedByUser, true);
    assert.equal(result.reply, "");
    assert.deepEqual(
      (await signals.takePending(runId)).map((s) => s.kind),
      ["abort"],
      "the stop stays pending for the terminal drain",
    );
  });
}

for (const late of [
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " late" } } },
  resultMessage("replacement after stop"),
]) {
  test(`Claude freezes partial output when cancellation races with ${late.type}`, async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const deltas: string[] = [];
    currentScript = async function* (prompts) {
      await prompts[Symbol.asyncIterator]().next();
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Visible partial" } },
      };
      waiting.resolve();
      await release.promise;
      yield late;
    };
    const harness = createClaudeHarness({});
    const { turn, entries } = harnessTurn({ cancel: cancel.signal, onDelta: (text) => deltas.push(text) });
    const running = harness.turns.runTurn(turn);
    await waiting.promise;
    cancel.abort();
    release.resolve();
    const result = await running;
    assert.equal(result.stopped, true);
    assert.equal(result.stoppedByUser, undefined);
    assert.equal(result.reply, "Visible partial");
    assert.deepEqual(deltas, ["Visible partial"]);
    assert.deepEqual(
      entries.filter((entry) => entry.type === "assistant").map((entry) => entry.payload),
      [{ text: "Visible partial", stopped: true }],
    );
  });
}

for (const bookkeeping of ["request recording", "thinking persistence"]) {
  test(`Claude preserves its partial reply when stopped during ${bookkeeping}`, async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancel = new AbortController();
    currentScript = async function* (prompts) {
      await prompts[Symbol.asyncIterator]().next();
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Visible partial" } },
      };
      yield {
        type: "assistant",
        message: { id: "thinking", content: [{ type: "thinking", thinking: "Checking the answer." }] },
      };
      yield resultMessage("replacement after stop");
    };
    const harness = createClaudeHarness({});
    const { turn, entries } = harnessTurn({ cancel: cancel.signal });
    const pause = async () => {
      waiting.resolve();
      await release.promise;
    };
    if (bookkeeping === "request recording") turn.recordLlmRequest = pause;
    else {
      const emit = turn.emit;
      turn.emit = async (entry) => {
        if (entry.type === "thinking") await pause();
        return emit(entry);
      };
    }
    const running = harness.turns.runTurn(turn);
    await waiting.promise;
    cancel.abort();
    release.resolve();
    const result = await running;
    assert.equal(result.stopped, true);
    assert.equal(result.stoppedByUser, undefined);
    assert.equal(result.reply, "Visible partial");
    assert.deepEqual(
      entries.filter((entry) => entry.type === "assistant").map((entry) => entry.payload),
      [{ text: "Visible partial", stopped: true }],
    );
  });
}

for (const ending of ["close", "throw"]) {
  test(`Claude completes a committed reply when cancelled during final entry persistence and the SDK will ${ending}`, async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancel = new AbortController();
    currentScript = (prompts) => {
      const generator = (async function* () {
        await prompts[Symbol.asyncIterator]().next();
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Visible partial" } },
        };
        yield resultMessage("Final full answer");
        if (ending === "throw") throw new Error("query interrupted");
      })();
      if (ending === "throw") generator.return = async () => ({ done: true, value: undefined });
      return generator;
    };
    const harness = createClaudeHarness({});
    const { turn, entries } = harnessTurn({ cancel: cancel.signal });
    const pause = async () => {
      waiting.resolve();
      await release.promise;
    };
    const emit = turn.emit;
    turn.emit = async (entry) => {
      if (entry.type === "assistant") await pause();
      return emit(entry);
    };
    const running = harness.turns.runTurn(turn);
    await waiting.promise;
    cancel.abort();
    release.resolve();
    const result = await running;
    assert.equal(result.stopped, undefined);
    assert.equal(result.reply, "Final full answer");
    assert.deepEqual(
      entries.filter((entry) => entry.type === "assistant").map((entry) => entry.payload),
      [{ text: "Final full answer" }],
    );
  });
}

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
    const childRead = await toolHandlers.get("memory")!({ action: "read" });
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

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn, entries } = harnessTurn({
    readOnly: false,
    tools: {
      memoryRead: async () => "bridge alive",
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
    yield resultMessage("parent result");
    assert.equal(await queueClosed(iterator), false);
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn, entries } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
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
    yield resultMessage("parent result");
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
});

test("a terminal notification then an empty task level closes without another root result", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield resultMessage("parent result");
    yield taskNotification("child", "completed");
    yield backgroundTasks();
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn, entries } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
  assert.equal(entries.filter((entry) => entry.type === "tool_result").length, 1);
});

test("an empty task level may precede its terminal notification", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield resultMessage("parent result");
    yield backgroundTasks();
    yield taskNotification("child", "completed");
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn, entries } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
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

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
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

    const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
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

test("ambient background tasks never hold the turn open", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "watcher", task_type: "monitor", description: "watcher", ambient: true }],
    };
    yield resultMessage("parent result");
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
});

test("a terminal task_updated releases the fallback edge tracking", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield taskStarted("child");
    yield resultMessage("parent result");
    assert.equal(await queueClosed(iterator), false);
    yield taskUpdated("child", "killed");
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({ backgroundSettleGraceMs: 5 });
  const { turn } = harnessTurn({ readOnly: false });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.reply, "parent result");
});

test("the CLI is asked to report session state so the harness can see the real end of a turn", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield resultMessage("done");
  };
  const harness = createClaudeHarness({});
  await harness.turns.runTurn(harnessTurn().turn);
  assert.equal((capturedOptions.env as Record<string, string>).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
});

test("the parent keeps its bridge after the last child settles until the CLI reports idle", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield sessionState("running");
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield resultMessage("parent result");
    assert.equal(await queueClosed(iterator), false);
    // The last child finishes: the CLI wakes the parent to read its result.
    yield taskUpdated("child", "completed");
    yield taskNotification("child", "completed");
    yield backgroundTasks();
    assert.equal(await queueClosed(iterator), false);
    // The parent's follow-up work still goes through the same bridge.
    yield assistantMessage("msg_followup", "filing the child result", { input_tokens: 1, output_tokens: 1 });
    const parentRead = await toolHandlers.get("memory")!({ action: "read" });
    assert.match(JSON.stringify(parentRead), /bridge alive/);
    yield resultMessage("parent follow-up done");
    assert.equal(await queueClosed(iterator), false);
    yield sessionState("idle");
    assert.equal((await iterator.next()).done, true);
  };

  const harness = createClaudeHarness({});
  const { turn } = harnessTurn({
    readOnly: false,
    tools: { memoryRead: async () => "bridge alive" } as unknown as HarnessTurnInput["tools"],
  });
  const result = await harness.turns.runTurn(turn);
  assert.equal(result.reply, "parent follow-up done");
});

test("idle does not close while a steer is still waiting for its result", { timeout: 5_000 }, async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-idle-steer";
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield sessionState("running");
    await signals.send(runId, { kind: "steer", text: "one more thing" });
    assert.equal((await iterator.next()).done, false);
    yield resultMessage("first");
    yield sessionState("idle");
    assert.equal(await queueClosed(iterator), false);
    yield sessionState("running");
    yield resultMessage("second");
    yield sessionState("idle");
    assert.equal((await iterator.next()).done, true);
  };
  const harness = createClaudeHarness({ signals });
  const { turn } = harnessTurn({ runId, readOnly: false });
  const result = await harness.turns.runTurn(turn);
  assert.equal(result.reply, "second");
});

test("without session state, a settled child waits for the parent's follow-up result", async () => {
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    yield backgroundTasks("child");
    yield taskStarted("child");
    yield resultMessage("parent result");
    yield taskNotification("child", "completed");
    yield backgroundTasks();
    assert.equal(await queueClosed(iterator), false);
    yield assistantMessage("msg_followup", "reading child", { input_tokens: 1, output_tokens: 1 });
    // Longer than the grace: the parent resumed, so the bridge must not drop mid-follow-up.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const parentRead = await toolHandlers.get("memory")!({ action: "read" });
    assert.match(JSON.stringify(parentRead), /bridge alive/);
    assert.equal(await queueClosed(iterator), false);
    yield resultMessage("parent follow-up done");
    assert.equal((await iterator.next()).done, true);
  };
  const harness = createClaudeHarness({ backgroundSettleGraceMs: 10 });
  const { turn } = harnessTurn({
    readOnly: false,
    tools: { memoryRead: async () => "bridge alive" } as unknown as HarnessTurnInput["tools"],
  });
  const result = await harness.turns.runTurn(turn);
  assert.equal(result.reply, "parent follow-up done");
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

test("recorded LLM requests carry real usage instead of a hardcoded truncation flag", async () => {
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
  assert.deepEqual(record.usage, {
    input: 12,
    output: 7,
    cacheRead: 300,
    cacheWrite: 20,
    totalTokens: 339,
    costUsd: 0.42,
  });
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
    "steer steps reuse the turn's envelope",
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

test("the claude harness offers compaction and detection so a utility role cannot silently disable them", async () => {
  const harness = createClaudeHarness({});
  assert.equal(typeof harness.models.compactHistory, "function");
  assert.equal(typeof harness.models.shouldRespond, "function");

  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield resultMessage("a compact summary of the thread");
  };
  const summary = await harness.models.compactHistory!({
    session: { id: "session-1" } as HarnessTurnInput["session"],
    history: [],
    recordModelCall: () => {},
  });
  assert.equal(summary, "a compact summary of the thread");

  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    const verdict = "YES — they asked the assistant directly";
    yield assistantMessage("msg_detect", verdict, {
      input_tokens: 900,
      output_tokens: 6,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    yield resultMessage(verdict, { total_cost_usd: 0.004 });
  };
  const detectRows: HarnessLlmRequestRecord[] = [];
  const verdict = await harness.models.shouldRespond!({
    session: { id: "session-1" } as HarnessTurnInput["session"],
    message: "hey bot, can you check this?",
    recentContext: "",
    systemPrompt: "be brief",
    history: [],
    recordModelCall: () => {},
    recordLlmRequest: (rec) => {
      detectRows.push(rec);
    },
  });
  assert.equal(verdict.respond, true);
  assert.deepEqual(
    detectRows.map((row) => [row.turnSeq, row.usage?.costUsd]),
    [[null, 0.004]],
  );
});

test("Claude preserves a committed runtime handoff when SDK interruption returns an error", async () => {
  const choice = { harnessId: "pi" as const, modelId: "gpt-6-astra" };
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

for (const terminal of [{ stop_reason: "max_tokens" }, { is_error: true }]) {
  test(`Claude compaction rejects incomplete SDK success: ${JSON.stringify(terminal)}`, async () => {
    currentScript = async function* (prompts) {
      await prompts[Symbol.asyncIterator]().next();
      yield resultMessage("partial summary", terminal);
    };
    const harness = createClaudeHarness({});
    await assert.rejects(
      harness.models.compactHistory!({
        session: { id: "summary-session" } as HarnessTurnInput["session"],
        history: [],
        recordModelCall: () => {},
      }),
      /did not complete/,
    );
  });
}

test("steering forwards prepared images and file paths while retaining the original caption in history", async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-steer-files";
  const request = {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "files" },
    text: "check this",
    attachments: [{ name: "photo.png", mimetype: "image/png", sizeBytes: 3, blobId: "b1" }],
  };
  let injected: unknown;
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    await iterator.next();
    await signals.send(runId, { kind: "steer", text: "check this", ts: "files.1", request });
    const next = (await iterator.next()).value!;
    injected = next.message.content;
    yield next as unknown as FakeSdkMessage;
    yield resultMessage("saw the image");
    yield resultMessage("done");
  };
  const harness = createClaudeHarness({ signals });
  const { turn, entries } = harnessTurn({ runId });
  turn.prepareSteer = async (text, received) => {
    assert.equal(text, "check this");
    assert.deepEqual(received, request);
    return {
      text: "check this\nThe file is in inbox/steer/photo.png",
      attachments: [{ name: "photo.png", mimetype: "image/png", sizeBytes: 3, direction: "in", artifactId: "f1" }],
      images: [{ mimeType: "image/png", dataBase64: "YWJj", artifactId: "f1" }],
    };
  };
  await harness.turns.runTurn(turn);
  assert.deepEqual(injected, [
    { type: "text", text: "check this\nThe file is in inbox/steer/photo.png" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
  ]);
  const entry = entries.find((e) => (e.payload as { steered?: boolean }).steered);
  assert.ok(entry);
  assert.equal((entry.payload as { text: string }).text, "check this");
  assert.equal((entry.payload as { attachments: Array<{ artifactId: string }> }).attachments[0]?.artifactId, "f1");
});

test("Claude sends documents without persisting their contents in session entries", async () => {
  const pdf = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  const secret = "private-document-text";
  let sent = "";
  currentScript = async function* (prompts) {
    for await (const prompt of prompts) {
      sent = JSON.stringify(prompt);
      yield resultMessage("Read both");
      return;
    }
  };
  const { turn, entries } = harnessTurn({
    documents: [
      { name: "a.pdf", mimeType: "application/pdf", dataBase64: pdf },
      { name: "a.txt", mimeType: "text/plain", dataBase64: Buffer.from(secret).toString("base64") },
    ],
  });
  await createClaudeHarness({}).turns.runTurn(turn);
  assert.ok(sent.includes(pdf));
  assert.ok(sent.includes(secret));
  assert.ok(!JSON.stringify(entries).includes(pdf));
  assert.ok(!JSON.stringify(entries).includes(secret));
});

test("Claude includes steered native and fallback documents without capturing their echoed contents", async () => {
  const signals = createMemoryRunSignalStore();
  const pdf = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  const docx = (await readFile(new URL("./fixtures/documents/sample.docx", import.meta.url))).toString("base64");
  let sent = "";
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    const initial = (await iterator.next()).value;
    yield initial!;
    await signals.send("steer-documents", { kind: "steer", text: "read the documents", ts: "files.2" });
    const steered = (await iterator.next()).value!;
    sent = JSON.stringify(steered);
    yield steered;
    yield resultMessage("read both");
    yield resultMessage("done");
  };
  const { turn, entries } = harnessTurn({ runId: "steer-documents" });
  turn.documents = [
    { name: "initial.txt", mimeType: "text/plain", dataBase64: Buffer.from("A".repeat(80_000)).toString("base64") },
  ];
  turn.prepareSteer = async (text) => ({
    text,
    documents: [
      { name: "steered.pdf", mimeType: "application/pdf", dataBase64: pdf },
      {
        name: "steered.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        dataBase64: docx,
      },
      {
        name: "overflow.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("Z".repeat(30_000) + "OUTSIDE-BUDGET-492").toString("base64"),
      },
    ],
  });
  await createClaudeHarness({ signals }).turns.runTurn(turn);
  assert.ok(sent.includes(pdf));
  assert.ok(!sent.includes("OUTSIDE-BUDGET-492"));
  assert.match(sent, /truncated to fit/);
  assert.ok(sent.includes("DOCX-QUARTZ-731"));
  assert.ok(!JSON.stringify(entries).includes(pdf));
  assert.ok(!JSON.stringify(entries).includes("DOCX-QUARTZ-731"));
});

test("Claude coordinators expose neither command tools nor native subagents", async () => {
  currentScript = async function* () {
    yield resultMessage("ready");
  };
  const harness = createClaudeHarness({});
  const { turn } = harnessTurn({ readOnly: false, delegateWork: true });
  await harness.turns.runTurn(turn);
  assert.deepEqual(capturedOptions.tools, []);
  assert.equal(capturedOptions.agents, undefined);
  const allowed = capturedOptions.allowedTools as string[];
  for (const name of ["Agent", "mcp__qm__execute", "mcp__qm__background"]) assert.ok(!allowed.includes(name));
  await harness.turns.close?.();
});

for (const surfaceTools of [false, true]) {
  test(`Claude finish_silently suppresses provider closing text (surface=${surfaceTools})`, async () => {
    currentScript = async function* () {
      await toolHandlers.get("finish_silently")!({ reason: "nothing new" });
      yield assistantMessage("quiet", "Nothing to add", {});
      yield resultMessage("Nothing to add");
    };
    const harness = createClaudeHarness();
    const { turn, entries } = harnessTurn({ pollFire: !surfaceTools, surfaceTools });
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.silent, true);
    assert.equal(result.reply, "");
    assert.equal(
      entries.some((entry) => entry.type === "assistant"),
      false,
    );
    assert.ok(entries.some((entry) => entry.type === "tool_result" && (entry.payload as { silent?: boolean }).silent));
  });
}

test("Claude ends a finish_silently turn quietly when the SDK reports the interrupt as an error", async () => {
  currentScript = async function* () {
    await toolHandlers.get("finish_silently")!({ reason: "nothing new" });
    yield resultMessage("", { subtype: "error_during_execution", errors: ["turn interrupted"], is_error: true });
  };
  const harness = createClaudeHarness();
  const { turn, entries } = harnessTurn({ pollFire: true });
  const result = await harness.turns.runTurn(turn);
  assert.equal(result.silent, true);
  assert.equal(result.reply, "");
  assert.equal(
    entries.some((entry) => entry.type === "assistant"),
    false,
  );
});

test("a Claude worker the swarm holds ends its goal turn quietly instead of as a stopped turn", async () => {
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    yield assistantMessage("held", "Starting step 3.", {});
    await toolHandlers.get("goal")!({ action: "get" });
    yield resultMessage("", { subtype: "error_during_execution", errors: ["turn interrupted"], is_error: true });
  };
  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({
    readOnly: false,
    goal: createGoalRecord({ objective: "lane A" }),
    goalInbox: { receive: async () => [], acknowledge: async () => {}, held: async () => true },
    saveGoal: async () => {},
  });
  const result = await harness.turns.runTurn(turn);
  assert.equal(result.stopped, undefined);
  assert.equal(result.reply, "");
  assert.equal(
    entries.some((entry) => entry.type === "assistant"),
    false,
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.type === "tool_result" && JSON.stringify(entry.payload).includes("The swarm paused or stopped you"),
    ),
  );
});

test("Claude emits repeated-text steers only at distinct native user echoes", async () => {
  const signals = createMemoryRunSignalStore();
  const { turn, entries } = harnessTurn({ runId: "echo-intake", input: "same text" });
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    yield (await iterator.next()).value as unknown as FakeSdkMessage;
    await signals.send("echo-intake", { kind: "steer", text: "same text", ts: "one" });
    const first = (await iterator.next()).value as unknown as FakeSdkMessage;
    await signals.send("echo-intake", { kind: "steer", text: "same text", ts: "two" });
    const second = (await iterator.next()).value as unknown as FakeSdkMessage;
    assert.equal(entries.filter((entry) => entry.type === "user").length, 1);
    assert.equal((await signals.pending("echo-intake")).length, 2);
    yield first;
    yield first;
    assert.equal(entries.filter((entry) => entry.type === "user").length, 2);
    yield {
      ...second,
      message: {
        role: "user",
        content: [
          ...(first.message as { content: unknown[] }).content,
          ...(second.message as { content: unknown[] }).content,
        ],
      },
    };
    yield resultMessage("first");
    yield resultMessage("second");
    yield resultMessage("third");
  };
  await createClaudeHarness({ signals }).turns.runTurn(turn);
  assert.deepEqual(capturedOptions.extraArgs, { "replay-user-messages": null });
  const users = entries.filter((entry) => entry.type === "user");
  assert.deepEqual(
    users.map((entry) => (entry.payload as { ts?: string }).ts),
    [undefined, "one", "two"],
  );
  assert.equal((await signals.pending("echo-intake")).length, 0);
});

test("Claude retains a queued message which the SDK never consumes", async () => {
  const signals = createMemoryRunSignalStore();
  const { turn, entries } = harnessTurn({ runId: "no-echo" });
  currentScript = async function* (prompts) {
    const iterator = prompts[Symbol.asyncIterator]();
    yield (await iterator.next()).value as unknown as FakeSdkMessage;
    await signals.send("no-echo", { kind: "steer", text: "not yet", ts: "pending" });
    await iterator.next();
    yield resultMessage("original reply");
  };
  await createClaudeHarness({ signals }).turns.runTurn(turn);
  assert.equal(entries.filter((entry) => entry.type === "user").length, 1);
  assert.equal((await signals.pending("no-echo"))[0]?.signal.ts, "pending");
});

test("Claude continues a resumed turn with its recorded request live and no new prompt or user entry", async () => {
  const prompted: string[] = [];
  currentScript = async function* (prompts) {
    for await (const prompt of prompts) {
      prompted.push(JSON.stringify(prompt.message.content));
      break;
    }
    yield assistantMessage("msg_A", "picking up", { input_tokens: 3, output_tokens: 2 });
    yield resultMessage("picking up");
  };
  const ask = "list the files";
  const history = [
    {
      sessionId: "session-1",
      seq: 1,
      parentSeq: null,
      type: "user",
      payload: { text: ask, runId: "run-resume" },
      scopeLabel: "org:test",
      createdAt: 1,
    },
    {
      sessionId: "session-1",
      seq: 2,
      parentSeq: null,
      type: "tool_call",
      payload: { tool: "execute", callId: "c1", command: "ls" },
      scopeLabel: "org:test",
      createdAt: 2,
    },
    {
      sessionId: "session-1",
      seq: 3,
      parentSeq: null,
      type: "tool_result",
      payload: { tool: "execute", callId: "c1", result: "a.txt" },
      scopeLabel: "org:test",
      createdAt: 3,
    },
  ] as SessionEntry[];
  const { turn, entries, llmRequests } = harnessTurn({
    input: "fallback input",
    history,
    continueTurn: true,
    resumeUserSeq: 1,
    runId: "run-resume",
    environment: "ENV-NOTE",
  });
  const result = await createClaudeHarness({}).turns.runTurn(turn);
  assert.equal(result.reply, "picking up");
  assert.deepEqual(
    entries.map((entry) => entry.type).filter((type) => type !== "thinking"),
    ["assistant"],
  );
  assert.equal(prompted.length, 1);
  const prompt = JSON.parse(prompted[0]!) as Array<{ text: string }>;
  const text = prompt[0]!.text;
  assert.equal(text.match(/list the files/g)?.length, 1, "the request appears once");
  assert.ok(text.indexOf(ask) < text.indexOf("Tool result"), "the request precedes the work already done");
  assert.ok(!text.slice(0, text.indexOf(ask)).includes("BEGIN TRANSCRIPT"), "the request is not quoted history");
  assert.match(text, /Tool result \(execute, call c1\): a\.txt/);
  assert.doesNotMatch(text, /fallback input|ENV-NOTE/);
  assert.equal(llmRequests[0]?.turnSeq, 1);
});

for (const shutdown of [false, true]) {
  test(`Claude ${shutdown ? "skips" : "records"} the stopped partial when cancelled mid-turn ${shutdown ? "by shutdown" : "by the worker"}`, async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const shutdownSignal = new AbortController();
    currentScript = async function* (prompts) {
      await prompts[Symbol.asyncIterator]().next();
      await toolHandlers.get("memory")!({ action: "read" });
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Visible partial" } },
      };
      waiting.resolve();
      await release.promise;
      yield resultMessage("replacement after stop");
    };
    const harness = createClaudeHarness({});
    const { turn, entries } = harnessTurn({
      cancel: cancel.signal,
      shutdown: shutdownSignal.signal,
      readOnly: false,
      tools: { memoryRead: async () => "remembered facts" } as unknown as HarnessTurnInput["tools"],
    });
    const running = harness.turns.runTurn(turn);
    await waiting.promise;
    if (shutdown) shutdownSignal.abort();
    cancel.abort();
    release.resolve();
    const result = await running;
    assert.equal(result.stopped, true);
    assert.equal(result.stoppedByUser, undefined);
    assert.deepEqual(
      entries.map((entry) => entry.type).filter((type) => type !== "thinking"),
      shutdown ? ["user", "tool_call", "tool_result"] : ["user", "tool_call", "tool_result", "assistant", "system"],
    );
    const partial = findTrailingPartialTurn(
      entries.map((entry) => (entry.type === "user" ? { ...entry, payload: { runId: "run-1" } } : entry)),
      "run-1",
    );
    if (shutdown) {
      assert.ok(partial);
      assert.notEqual(resumeStrategy(entries, partial).kind, "restart");
      assert.equal(turnAtSeq(entries, partial.userSeq)?.answer, undefined);
    } else {
      assert.deepEqual(entries.at(-2)!.payload, { text: "Visible partial", stopped: true });
      assert.deepEqual(entries.at(-1)!.payload, {
        kind: "turn_stopped",
        reason: "because the run was cancelled",
      });
      assert.equal(partial, null);
    }
  });
}

test("Claude records the stop when the worker cancels a turn before any output", async () => {
  const waiting = Promise.withResolvers<void>();
  const cancel = new AbortController();
  currentScript = async function* () {
    waiting.resolve();
    await new Promise((resolve) => cancel.signal.addEventListener("abort", resolve, { once: true }));
    yield* [];
  };
  const harness = createClaudeHarness({});
  const { turn, entries } = harnessTurn({ input: "go", cancel: cancel.signal });
  const running = harness.turns.runTurn(turn);
  await waiting.promise;
  cancel.abort();
  const result = await running;
  assert.equal(result.stopped, true);
  assert.equal(result.reply, "");
  assert.deepEqual(
    entries.filter((e) => e.type !== "user").map((e) => e.payload),
    [{ kind: "turn_stopped", reason: "because the run was cancelled" }],
  );
});
