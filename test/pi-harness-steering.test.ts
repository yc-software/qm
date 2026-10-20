import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { promptEnvelopeBody } from "../src/sessions/session-store.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { ScopeId } from "../src/types.ts";

type Sink = {
  entries: Item[];
};

function turnInput(sessionId: string, sink: Sink, overrides: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "do the thing",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (item: NewItem) => {
      const appended = storedItem(item, { sessionId, seq: seq++, createdAt: Date.now() });
      sink.entries.push(appended);
      return appended;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textReplyEvents(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

function gatedSse(events: Array<Record<string, unknown>>, gate: Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events.slice(0, -1)) {
        controller.enqueue(encoder.encode(`event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      await gate;
      const last = events.at(-1)!;
      controller.enqueue(encoder.encode(`event: ${last.type as string}\ndata: ${JSON.stringify(last)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

for (const variant of ["text", "images", "documents", "finished during preparation"]) {
  const withImages = variant !== "text";
  const finishDuringPreparation = variant === "finished during preparation";
  test(`steered input lands in consumption order, including steered ${variant}`, async () => {
    const signals = createMemoryRunSignalStore();
    const harness = createPiHarness({ apiKey: "sk-test", signals });
    const sink: Sink = { entries: [] };
    const documentBase64 = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString(
      "base64",
    );
    let releaseFirstStep = () => {};
    const steerQueued = new Promise<void>((resolve) => {
      releaseFirstStep = () => setTimeout(resolve, 50);
    });
    const requestMessages: Array<Array<{ role: string }>> = [];
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      requestMessages.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: [] }).messages ?? []);
      if (calls === 1) {
        setTimeout(() => {
          void signals.send("run-order", { kind: "steer", text: "actually, do it differently", ts: "1712.001" });
          if (!finishDuringPreparation)
            setTimeout(() => {
              assert.equal(
                sink.entries.filter((entry) => entry.kind === "UserMessage").length,
                1,
                "enqueue is not model intake",
              );
              releaseFirstStep();
            }, 100);
        }, 30);
        const events = textReplyEvents("first step");
        if (variant === "text") {
          for (const event of events) if (typeof event.index === "number") event.index = 1;
          events.splice(
            1,
            0,
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "before the steer" } },
            { type: "content_block_stop", index: 0 },
          );
        }
        return gatedSse(events, steerQueued);
      }
      return sse(textReplyEvents("final reply"));
    }) as typeof globalThis.fetch;
    try {
      const turn = turnInput("steer-order", sink, { runId: "run-order" });
      const emit = turn.emit;
      turn.emit = async (entry) => {
        if (entry.kind === "Reasoning") await new Promise((resolve) => setTimeout(resolve, 100));
        return emit(entry);
      };
      if (withImages)
        turn.prepareSteer = async (text) => {
          if (finishDuringPreparation) {
            releaseFirstStep();
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return {
            text: `${text}\nFile available in inbox/photo.png`,
            images: [{ mimeType: "image/png", dataBase64: "YWJj", artifactId: "steered-photo" }],
            ...(variant === "documents"
              ? { documents: [{ name: "steered.pdf", mimeType: "application/pdf", dataBase64: documentBase64 }] }
              : {}),
          };
        };
      const result = await harness.turns.runTurn(turn);
      if (finishDuringPreparation) {
        assert.equal(result.reply, "first step");
        const pending = await signals.takePending("run-order");
        assert.equal(pending.length, 1);
        assert.equal(pending[0]?.text, "actually, do it differently");
        return;
      }
      assert.equal(result.reply, "final reply");

      if (withImages) assert.ok(JSON.stringify(requestMessages[1]).includes("YWJj"));
      if (variant === "documents") {
        assert.ok(!JSON.stringify(requestMessages[0]).includes(documentBase64));
        assert.ok(JSON.stringify(requestMessages[1]).includes(documentBase64));
        assert.ok(!JSON.stringify(sink.entries).includes(documentBase64));
      }
      const steeredEntry = sink.entries.find((entry) => entry.kind === "SteeringMessage");
      assert.ok(steeredEntry);
      if (variant === "text")
        assert.ok(
          steeredEntry.seq > sink.entries.find((entry) => entry.kind === "Reasoning")!.seq,
          "slow persistence of prior thinking must not cross the intake event",
        );
      assert.equal(steeredEntry.body.ts, "1712.001", "the steer entry is stamped with its arrival ts");
      assert.match(steeredEntry.text ?? "", /actually, do it differently/);
      assert.deepEqual(await signals.takePending("run-order"), [], "consumed steer is acknowledged");
      assert.equal(calls, 2);
      assert.deepEqual(
        requestMessages[1]!.map((message) => message.role),
        ["user", "assistant", "user"],
        "the steer was injected into the model context after the first reply",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("a lease lost mid-turn fails the turn instead of degrading silently", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:lease-lost", "dm", "personal:tester" as ScopeId);
  const attempt = await store.acquireLease(session.id, "turn");
  const lease = attempt.lease!;
  assert.ok(lease);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    await store.releaseLease(lease);
    const thief = await store.acquireLease(session.id, "turn");
    assert.ok(thief.lease);
    return sse(textReplyEvents("reply after the lease was stolen"));
  }) as typeof globalThis.fetch;
  try {
    const turn = turnInput(session.id, sink, {
      emit: (entry) => store.append(lease, entry),
    });
    await assert.rejects(harness.turns.runTurn(turn), /without a valid session lease/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("completed Pi attach results retain openable files in viewer history", async () => {
  const { createTranscriptSource } = await import("../src/sessions/transcript-source.ts");
  const store = createMemorySessionStore();
  const scopeLabel = "personal:tester" as ScopeId;
  const session = await store.getOrCreateByThread("web:tester:attach-history", "dm", scopeLabel);
  await store.addParticipant(session.id, "tester", undefined, { includeHistory: true });
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  const files = [
    { name: "desktop.png", mimetype: "image/png", sizeBytes: 123, artifactId: "desktop" },
    { name: "phone.png", mimetype: "image/png", sizeBytes: 456, artifactId: "phone" },
    { name: "preview.html", mimetype: "text/html", sizeBytes: 789, artifactId: "preview" },
  ];
  const harness = createPiHarness({ apiKey: "sk-test" });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    if (calls++ > 0) return sse(textReplyEvents("Here are the previews."));
    const events = textReplyEvents("");
    events[1] = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "attach-preview", name: "attach", input: {} },
    };
    events[2] = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ files: files.map((f) => f.name) }) },
    };
    events[4] = { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
    return sse(events);
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn(
      turnInput(
        session.id,
        { entries: [] },
        {
          session,
          tools: {
            attach: async () => ({ ok: true, files, staged: files.length }),
          } as unknown as HarnessTurnInput["tools"],
          emit: (entry) => store.append(lease, entry),
        },
      ),
    );
    assert.equal(result.reply, "Here are the previews.");
    assert.equal(calls, 2);
    const original = (await store.getItems(session.id)).find((e) => e.kind === "ToolResult");
    assert.ok(original);
    assert.deepEqual(original.body.files, files);
    const source = createTranscriptSource(store);
    for (const read of [await source.forRender(session.id), await source.forViewer(session.id, "tester")]) {
      const restored = read.items.find((e) => e.kind === "ToolResult");
      assert.ok(restored);
      assert.deepEqual(restored.body.files, files);
      assert.deepEqual(restored, original);
    }
  } finally {
    globalThis.fetch = realFetch;
    await store.releaseLease(lease);
  }
});

for (const route of ["gateway", "direct", "personal"] as const) {
  test(`native document byte budget respects ${route} routing`, async () => {
    const modelId = "claude-opus-5";
    const harness = createPiHarness({
      apiKey: "sk-test",
      modelId,
      ...(route !== "direct"
        ? {
            modelGateway: {
              url: "https://gateway.test",
              apiKey: "gateway-test",
              apiKeyHeader: "api-key",
              models: { [modelId]: "router/opus" },
            },
          }
        : {}),
    });
    const sink: Sink = { entries: [] };
    const pdf = await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url));
    const dataBase64 = Buffer.concat([pdf, Buffer.alloc(4_000_000 - pdf.length, 32)]).toString("base64");
    const realFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return sse(textReplyEvents("read the document"));
    }) as typeof fetch;
    try {
      await harness.turns.runTurn(
        turnInput(`document-budget-${route}`, sink, {
          ...(route === "personal" ? { providerKeys: { anthropic: "personal-test" } } : {}),
          documents: [
            { name: "first.pdf", mimeType: "application/pdf", dataBase64, artifactId: "doc1" },
            { name: "latest.pdf", mimeType: "application/pdf", dataBase64, artifactId: "doc2" },
          ],
        }),
      );
      const blocks = JSON.parse(body).messages.at(-1).content;
      assert.equal(
        blocks.filter((block: { type: string }) => block.type === "document").length,
        route === "gateway" ? 1 : 2,
      );
      assert.equal(Buffer.byteLength(body) < 10 * 1024 * 1024, route === "gateway");
      assert.ok(body.includes(dataBase64));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("native document bytes reach the provider on every step without entering session entries", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const realFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  const dataBase64 = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return sse(textReplyEvents("read the document"));
  }) as typeof fetch;
  try {
    await harness.turns.runTurn(
      turnInput("native-documents", sink, {
        documents: [{ name: "report.pdf", mimeType: "application/pdf", dataBase64, artifactId: "doc1" }],
      }),
    );
    assert.match(JSON.stringify(requests), /"type":"document"/);
    assert.ok(JSON.stringify(requests).includes(dataBase64));
    assert.ok(!JSON.stringify(sink.entries).includes(dataBase64));
    await harness.turns.runTurn(turnInput("native-documents", sink));
    assert.ok(
      !JSON.stringify(requests.at(-1)).includes(dataBase64),
      "reused sessions must clear documents when the audience no longer supplies them",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Pi Responses captures exclude history and document text without changing requests or entries", async () => {
  const harness = createPiHarness({ openaiApiKey: "sk-test", modelId: "gpt-5.6-sol" });
  const sink: Sink = { entries: [] };
  const captures: HarnessLlmRequestRecord[] = [];
  const realFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return sse([
      { type: "response.created", response: { id: "resp_qa", status: "in_progress" } },
      {
        type: "response.completed",
        response: {
          id: "resp_qa",
          status: "completed",
          output: [],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        },
      },
    ]);
  }) as typeof fetch;
  try {
    await harness.turns.runTurn(
      turnInput("capture-document-fallback", sink, {
        documents: [
          {
            name: "sample.rtf",
            mimeType: "application/rtf",
            dataBase64: (await readFile(new URL("./fixtures/documents/sample.rtf", import.meta.url))).toString(
              "base64",
            ),
          },
        ],
        recordLlmRequest: async (capture) => {
          captures.push(capture);
        },
      }),
    );
    assert.ok(requests.length > 1);
    assert.match(JSON.stringify(requests[0]), /do the thing/);
    assert.match(JSON.stringify(requests.at(-1)), /do the thing/);
    assert.match(JSON.stringify(requests.at(-1)), /The turn ended with an empty message/);
    assert.match(JSON.stringify(sink.entries), /do the thing/);
    const firstEnvelope = promptEnvelopeBody(captures[0]!.promptEnvelope)!;
    assert.match(firstEnvelope.body, /BASE/);
    for (const capture of captures) {
      assert.equal(promptEnvelopeBody(capture.promptEnvelope)!.hash, firstEnvelope.hash);
      assert.doesNotMatch(JSON.stringify(capture.promptEnvelope), /do the thing|The turn ended with an empty message/);
    }
    assert.ok(JSON.stringify(requests).includes("RTF-QUARTZ-731"));
    assert.ok(captures.length > 0);
    assert.ok(!JSON.stringify(captures).includes("RTF-QUARTZ-731"));
    assert.ok(!JSON.stringify(sink.entries).includes("RTF-QUARTZ-731"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const stopBeforeIntake of [false, true]) {
  test(`steering during a tool ${stopBeforeIntake ? "survives Stop without fabricated intake" : "lands after its result in live and stored order"}`, async () => {
    const signals = createMemoryRunSignalStore();
    const harness = createPiHarness({ apiKey: "sk-test", signals });
    const store = createMemorySessionStore();
    const session = await store.getOrCreateByThread("web:steer-tool", "dm", "personal:tester" as ScopeId);
    const lease = (await store.acquireLease(session.id, "turn")).lease!;
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls > 1) return sse(textReplyEvents("done"));
      const events = textReplyEvents("");
      events[1] = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "read-memory", name: "memory", input: {} },
      };
      events[2] = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "read" }) },
      };
      events[4] = { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
      return sse(events);
    }) as typeof fetch;
    const entries: Item[] = [];
    try {
      await harness.turns.runTurn(
        turnInput(
          session.id,
          { entries: [] },
          {
            session,
            runId: "tool-steer",
            tools: {
              memoryRead: async () => {
                await signals.send("tool-steer", { kind: "steer", text: "use the other file", ts: "tool.1" });
                await new Promise((resolve) => setTimeout(resolve, 30));
                assert.equal(entries.filter((entry) => entry.kind === "UserMessage").length, 1);
                assert.equal((await signals.pending("tool-steer")).length, 1);
                if (stopBeforeIntake) {
                  await signals.send("tool-steer", { kind: "abort" });
                  await new Promise((resolve) => setTimeout(resolve, 30));
                }
                return "saved facts";
              },
            } as HarnessTurnInput["tools"],
            emit: async (entry) => {
              const saved = await store.append(lease, entry);
              entries.push(saved);
              return saved;
            },
          },
        ),
      );
      const users = entries.filter((entry) => entry.kind === "UserMessage" || entry.kind === "SteeringMessage");
      if (stopBeforeIntake) {
        assert.equal(users.length, 1);
        assert.equal((await signals.pending("tool-steer")).filter((row) => row.signal.kind === "steer").length, 1);
        const before = calls;
        await harness.turns.runTurn(turnInput(session.id, { entries: [] }));
        assert.equal(calls, before + 1, "cached Pi session must not redeliver the queued steer on its own");
      } else {
        assert.deepEqual(
          entries.map((entry) => entry.kind),
          ["UserMessage", "ToolCall", "ToolResult", "SteeringMessage", "AgentMessage"],
        );
        assert.equal(users[1]!.body.ts, "tool.1");
        assert.deepEqual(
          (await store.getItems(session.id)).map((entry) => [entry.seq, entry.kind]),
          entries.map((entry) => [entry.seq, entry.kind]),
        );
        assert.equal((await signals.pending("tool-steer")).length, 0);
      }
    } finally {
      globalThis.fetch = realFetch;
      await store.releaseLease(lease);
      await harness.turns.close?.();
    }
  });
}

test("a consumed steer is recorded when its acknowledgement fails", async () => {
  const signals = createMemoryRunSignalStore();
  signals.acknowledge = async () => {
    throw new Error("signal store unavailable");
  };
  const harness = createPiHarness({ apiKey: "sk-test", signals });
  const sink: Sink = { entries: [] };
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    if (++calls > 1) return sse(textReplyEvents("done"));
    const events = textReplyEvents("");
    events[1] = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "read-memory", name: "memory", input: {} },
    };
    events[2] = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "read" }) },
    };
    events[4] = { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
    return sse(events);
  }) as typeof fetch;
  try {
    const turn = turnInput("steer-failure", sink, {
      runId: "steer-failure",
      tools: {
        memoryRead: async () => {
          await signals.send("steer-failure", { kind: "steer", text: "use the other file", ts: "fail.1" });
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "saved facts";
        },
      } as HarnessTurnInput["tools"],
    });
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.reply, "done", "an acknowledgement failure does not tear down the live turn");
    const steered = sink.entries.filter((entry) => entry.kind === "SteeringMessage");
    assert.equal(steered.length, 1);
    assert.equal(steered[0]!.body.ts, "fail.1");
    assert.equal(
      (await signals.pending("steer-failure")).filter((row) => row.signal.kind === "steer").length,
      1,
      "an unacknowledged steer stays pending for replay",
    );
  } finally {
    globalThis.fetch = realFetch;
    await harness.turns.close?.();
  }
});

for (const abort of ["shutdown", "stop"] as const) {
  test(`a Pi tool result recorded after ${abort === "shutdown" ? "shutdown is marked interrupted and leaves its call open" : "a user Stop stays a real answer"}`, async () => {
    const harness = createPiHarness({ apiKey: "sk-test" });
    const store = createMemorySessionStore();
    const session = await store.getOrCreateByThread(`web:${abort}-tool`, "dm", "personal:tester" as ScopeId);
    const lease = (await store.acquireLease(session.id, "turn")).lease!;
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls > 1) return sse(textReplyEvents("done"));
      const events = textReplyEvents("");
      events[1] = {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "read-memory", name: "memory", input: {} },
      };
      events[2] = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "read", retrySafe: true }) },
      };
      events[4] = { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
      return sse(events);
    }) as typeof fetch;
    const shutdown = new AbortController();
    const cancel = new AbortController();
    const entries: Item[] = [];
    try {
      await harness.turns.runTurn(
        turnInput(
          session.id,
          { entries: [] },
          {
            session,
            runId: `${abort}-tool`,
            cancel: cancel.signal,
            shutdown: shutdown.signal,
            tools: {
              memoryRead: async () => {
                if (abort === "shutdown") shutdown.abort();
                cancel.abort();
                await new Promise((resolve) => setTimeout(resolve, 10));
                return "[exit 143]";
              },
            } as HarnessTurnInput["tools"],
            emit: async (entry) => {
              const saved = await store.append(lease, entry);
              entries.push(saved);
              return saved;
            },
          },
        ),
      );
      const result = entries.find((entry) => entry.kind === "ToolResult");
      assert.ok(result);
      assert.deepEqual(
        { interrupted: result.body.interrupted, result: result.text },
        abort === "shutdown"
          ? { interrupted: true, result: "[exit 143]" }
          : { interrupted: undefined, result: "[exit 143]" },
      );
      const { resumeStrategy } = await import("../src/core/turn-resume.ts");
      const userSeq = entries.find((entry) => entry.kind === "UserMessage")!.seq;
      assert.equal(
        resumeStrategy(entries, { userSeq, workEntries: entries.filter((e) => e.seq > userSeq).length }).kind,
        abort === "shutdown" ? "retry" : "continue",
      );
    } finally {
      globalThis.fetch = realFetch;
      await store.releaseLease(lease);
      await harness.turns.close?.();
    }
  });
}
