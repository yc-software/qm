import { readFile } from "node:fs/promises";
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
let initialize: () => Promise<unknown> = async () => ({});

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
      const generator = currentScript(prompt);
      return {
        initializationResult: () => initialize(),
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

test("a user stop that surfaces as a non-success SDK result is a clean stop, and the stop stays pending", async () => {
  const signals = createMemoryRunSignalStore();
  const runId = "run-stop-error";
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    await signals.send(runId, { kind: "abort" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield resultMessage("", { subtype: "error_during_execution", errors: ["turn interrupted"], is_error: true });
  };

  const harness = createClaudeHarness({ signals });
  const { turn } = harnessTurn({ runId });
  const result = await harness.turns.runTurn(turn);

  assert.equal(result.stopped, true, "an interrupted turn the SDK calls an error is still a user stop");
  assert.equal(result.reply, "");
  assert.deepEqual(
    (await signals.takePending(runId)).map((s) => s.kind),
    ["abort"],
    "the stop stays pending for the terminal drain",
  );
});

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
    assert.equal(result.reply, "Visible partial");
    assert.deepEqual(
      entries.filter((entry) => entry.type === "assistant").map((entry) => entry.payload),
      [{ text: "Visible partial", stopped: true }],
    );
  });
}

for (const persistence of ["final entry", "reply checkpoint"]) {
  for (const ending of ["close", "throw"]) {
    test(`Claude completes a committed reply when cancelled during ${persistence} persistence and the SDK will ${ending}`, async () => {
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
      if (persistence === "final entry") {
        const emit = turn.emit;
        turn.emit = async (entry) => {
          if (entry.type === "assistant") await pause();
          return emit(entry);
        };
      } else {
        turn.tape = async (entry) => {
          if (entry.kind === "annotation") await pause();
        };
      }
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
}

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
    injected = (await iterator.next()).value?.message.content;
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

test("Claude sends documents without persisting their contents in the tape", async () => {
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
  const tape: unknown[] = [];
  const { turn } = harnessTurn({
    documents: [
      { name: "a.pdf", mimeType: "application/pdf", dataBase64: pdf },
      { name: "a.txt", mimeType: "text/plain", dataBase64: Buffer.from(secret).toString("base64") },
    ],
    tape: async (entry) => {
      tape.push(entry);
    },
  });
  await createClaudeHarness({}).turns.runTurn(turn);
  assert.ok(sent.includes(pdf));
  assert.ok(sent.includes(secret));
  assert.ok(!JSON.stringify(tape).includes(pdf));
  assert.ok(!JSON.stringify(tape).includes(secret));
});

test("Claude includes steered native and fallback documents without capturing their echoed contents", async () => {
  const signals = createMemoryRunSignalStore();
  const pdf = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  const docx = (await readFile(new URL("./fixtures/documents/sample.docx", import.meta.url))).toString("base64");
  const tape: unknown[] = [];
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
  const { turn } = harnessTurn({
    runId: "steer-documents",
    tape: async (row) => {
      tape.push(row);
    },
  });
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
  assert.ok(!JSON.stringify(tape).includes(pdf));
  assert.ok(!JSON.stringify(tape).includes("DOCX-QUARTZ-731"));
});

test("Claude deadline hands off even when the SDK interrupt never settles", { timeout: 3_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  currentScript = async function* (prompts) {
    await prompts[Symbol.asyncIterator]().next();
    entered.resolve();
    await release.promise;
    yield resultMessage("late completion");
  };
  const deadline = new AbortController();
  const harness = createClaudeHarness({ turnWallClockMs: 0 });
  const { turn, entries } = harnessTurn({ handoff: AbortSignal.abort(), handoffDeadline: deadline.signal });
  const pending = harness.turns.runTurn(turn);
  await entered.promise;
  deadline.abort();
  try {
    const result = await pending;
    assert.equal(result.handedOff, true);
    assert.equal(result.stopped, undefined);
    assert.equal(
      entries.some((entry) => entry.type === "assistant"),
      false,
    );
  } finally {
    release.resolve();
    await harness.turns.close?.();
  }
});

test("Claude deadline bounds SDK initialization", { timeout: 3000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  initialize = async () => {
    entered.resolve();
    await release.promise;
    return {};
  };
  const deadline = new AbortController();
  const harness = createClaudeHarness({ turnWallClockMs: 0 });
  const { turn } = harnessTurn({ handoff: AbortSignal.abort(), handoffDeadline: deadline.signal });
  try {
    const pending = harness.turns.runTurn(turn);
    await entered.promise;
    deadline.abort();
    assert.equal((await pending).handedOff, true);
  } finally {
    initialize = async () => ({});
    release.resolve();
    await harness.turns.close?.();
  }
});
