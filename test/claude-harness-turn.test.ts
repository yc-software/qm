import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

type FakeSdkMessage = Record<string, unknown>;
type Script = (prompts: AsyncIterable<{ message: { content: unknown } }>) => AsyncGenerator<FakeSdkMessage>;

let currentScript: Script = async function* () {};

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
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
    tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
      name,
      description,
      schema,
      handler,
    }),
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
    tools: {} as HarnessTurnInput["tools"],
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
    yield resultMessage("YES — they asked the assistant directly");
  };
  const verdict = await harness.models.shouldRespond!({
    session: { id: "session-1" } as HarnessTurnInput["session"],
    message: "hey bot, can you check this?",
    recentContext: "",
    systemPrompt: "be brief",
    history: [],
    recordModelCall: () => {},
  });
  assert.equal(verdict.respond, true);
});
