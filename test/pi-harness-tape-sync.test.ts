import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { promptEnvelopeBody, type NewEntry, type NewTapeRecord } from "../src/sessions/session-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

type Sink = {
  entries: Array<{ seq: number; type: string; payload: unknown }>;
  tape: NewTapeRecord[];
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
    emit: async (entry: NewEntry) => {
      const appended = { ...entry, seq: seq++, createdAt: Date.now() };
      sink.entries.push({ seq: appended.seq, type: entry.type, payload: entry.payload });
      return appended as unknown as SessionEntry;
    },
    tape: async (rec: NewTapeRecord) => {
      sink.tape.push(rec);
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

const frame = (event: Record<string, unknown>) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`;
const SSE = { status: 200, headers: { "content-type": "text/event-stream" } };

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(frame).join(""), SSE);
}

function mockFetch(t: TestContext, impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const real = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
}

function toolUseEvents(id: string, name: string, input: unknown): Array<Record<string, unknown>> {
  const events = textReplyEvents("");
  events[1] = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } };
  events[2] = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  };
  events[4] = { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
  return events;
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
      for (const event of events.slice(0, -1)) controller.enqueue(encoder.encode(frame(event)));
      await gate;
      controller.enqueue(encoder.encode(frame(events.at(-1)!)));
      controller.close();
    },
  });
  return new Response(stream, SSE);
}

for (const variant of ["text", "images", "documents", "finished during preparation"]) {
  const withImages = variant !== "text";
  const finishDuringPreparation = variant === "finished during preparation";
  test(`tape rows land in consumption order, including steered ${variant}`, async (t) => {
    const signals = createMemoryRunSignalStore();
    const harness = createPiHarness({ apiKey: "sk-test", signals });
    const sink: Sink = { entries: [], tape: [] };
    const documentBase64 = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString(
      "base64",
    );
    let releaseFirstStep = () => {};
    const steerQueued = new Promise<void>((resolve) => {
      releaseFirstStep = () => setTimeout(resolve, 50);
    });
    const tapeRowsAtDispatch: number[] = [];
    const requestMessages: Array<Array<{ role: string }>> = [];
    let calls = 0;
    mockFetch(t, async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      tapeRowsAtDispatch.push(sink.tape.filter((rec) => rec.kind === "message").length);
      requestMessages.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: [] }).messages ?? []);
      if (calls === 1) {
        setTimeout(() => {
          void signals.send("run-order", { kind: "steer", text: "actually, do it differently", ts: "1712.001" });
          if (!finishDuringPreparation)
            setTimeout(() => {
              assert.equal(
                sink.entries.filter((entry) => entry.type === "user").length,
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
    });
    const turn = turnInput("tape-order", sink, { runId: "run-order" });
    const emit = turn.emit;
    turn.emit = async (entry) => {
      if (entry.type === "thinking") await new Promise((resolve) => setTimeout(resolve, 100));
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

    const messageRows = sink.tape.filter((rec) => rec.kind === "message");
    assert.deepEqual(
      messageRows.map((rec) => (rec.payload as { role: string }).role),
      ["user", "assistant", "user", "assistant"],
      "the tape holds exactly the consumed messages, in consumption order",
    );
    assert.equal(messageRows[0]!.meta?.bareText, "do the thing");
    assert.equal(messageRows[2]!.meta?.bareText, "actually, do it differently");
    assert.equal(messageRows[2]!.meta?.ts, "1712.001", "the steer row is stamped with its arrival ts");
    if (withImages) {
      const content = (messageRows[2]!.payload as { content: Array<Record<string, unknown>> }).content;
      assert.deepEqual(
        content.find((block) => block.type === "image"),
        {
          type: "image",
          mimeType: "image/png",
          artifactRef: "steered-photo",
        },
      );
    }
    if (variant === "documents") {
      assert.ok(!JSON.stringify(requestMessages[0]).includes(documentBase64));
      assert.ok(JSON.stringify(requestMessages[1]).includes(documentBase64));
      assert.ok(!JSON.stringify(sink.tape).includes(documentBase64));
    }
    const steeredEntry = sink.entries.find(
      (entry) => entry.type === "user" && (entry.payload as { steered?: boolean }).steered,
    );
    assert.ok(steeredEntry);
    if (variant === "text")
      assert.ok(
        steeredEntry.seq > sink.entries.find((entry) => entry.type === "thinking")!.seq,
        "slow persistence of prior thinking must not cross the intake event",
      );
    assert.equal(messageRows[2]!.entrySeq, steeredEntry.seq);
    assert.deepEqual(await signals.takePending("run-order"), [], "consumed steer is acknowledged");
    assert.equal(calls, 2);
    assert.equal(tapeRowsAtDispatch[0], 1, "the trigger user row is committed before the first dispatch");
    assert.equal(
      tapeRowsAtDispatch[1],
      3,
      "step 2 is not dispatched until the trigger, first reply, and injected steer are all on the tape",
    );
    assert.deepEqual(
      requestMessages[1]!.map((message) => message.role),
      ["user", "assistant", "user"],
      "the steer was injected into the model context exactly where the tape says",
    );
  });
}

test("a failed tape append fails the turn loudly with the append error, no checkpoint", async (t) => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  mockFetch(t, async () => sse(textReplyEvents("a reply that must not survive")));
  const turn = turnInput("tape-fatal", sink, {
    tape: async (rec: NewTapeRecord) => {
      if (rec.kind === "message" && (rec.payload as { role?: string }).role === "assistant")
        throw new Error("tape insert refused");
      sink.tape.push(rec);
    },
  });
  await assert.rejects(harness.turns.runTurn(turn), /tape insert refused/);
  assert.equal(
    sink.tape.some((rec) => rec.kind === "annotation" && (rec.payload as { subturnEnd?: unknown }).subturnEnd),
    false,
    "no completeness checkpoint is stamped over the failure",
  );
});

test("a lease lost mid-turn fails the turn instead of degrading silently", async (t) => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:lease-lost", "dm", "personal:tester" as ScopeId);
  const attempt = await store.acquireLease(session.id, "turn");
  const lease = attempt.lease!;
  assert.ok(lease);
  mockFetch(t, async () => {
    await store.releaseLease(lease);
    const thief = await store.acquireLease(session.id, "turn");
    assert.ok(thief.lease);
    return sse(textReplyEvents("reply after the lease was stolen"));
  });
  const turn = turnInput(session.id, sink, {
    tape: (rec: NewTapeRecord) => store.appendTape(lease, rec),
  });
  await assert.rejects(harness.turns.runTurn(turn), /without a valid session lease/);
  assert.equal(await store.tapeCoverage(session.id), -1, "nothing on the stolen-lease tape claims coverage");
});

test("completed Pi attach results retain openable files in viewer history", async (t) => {
  const { createTranscriptSource } = await import("../src/harness/tape-projection.ts");
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
  let calls = 0;
  mockFetch(t, async () => {
    if (calls++ > 0) return sse(textReplyEvents("Here are the previews."));
    return sse(toolUseEvents("attach-preview", "attach", { files: files.map((f) => f.name) }));
  });
  t.after(async () => {
    await store.releaseLease(lease);
  });
  const result = await harness.turns.runTurn(
    turnInput(
      session.id,
      { entries: [], tape: [] },
      {
        session,
        tools: {
          attach: async () => ({ ok: true, files, staged: files.length }),
        } as unknown as HarnessTurnInput["tools"],
        emit: (entry) => store.append(lease, entry),
        tape: async (rec) => {
          await store.appendTape(lease, rec);
        },
      },
    ),
  );
  assert.equal(result.reply, "Here are the previews.");
  assert.equal(calls, 2);
  const original = (await store.getEntries(session.id)).find((e) => e.type === "tool_result");
  assert.ok(original);
  assert.deepEqual((original.payload as { files?: unknown[] }).files, files);
  const source = createTranscriptSource(store);
  for (const read of [await source.forRender(session.id), await source.forViewer(session.id, "tester")]) {
    const restored = read.entries.find((e) => e.type === "tool_result");
    assert.ok(restored);
    assert.deepEqual((restored.payload as { files?: unknown[] }).files, files);
    assert.deepEqual(restored, original);
  }
});

test("native document bytes reach the provider on every step without entering the transcript tape", async (t) => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  const requests: Array<Record<string, unknown>> = [];
  const dataBase64 = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  mockFetch(t, async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return sse(textReplyEvents("read the document"));
  });
  await harness.turns.runTurn(
    turnInput("native-documents", sink, {
      documents: [{ name: "report.pdf", mimeType: "application/pdf", dataBase64, artifactId: "doc1" }],
    }),
  );
  assert.match(JSON.stringify(requests), /"type":"document"/);
  assert.ok(JSON.stringify(requests).includes(dataBase64));
  assert.ok(!JSON.stringify(sink.tape).includes(dataBase64));
  await harness.turns.runTurn(turnInput("native-documents", sink));
  assert.ok(
    !JSON.stringify(requests.at(-1)).includes(dataBase64),
    "reused sessions must clear documents when the audience no longer supplies them",
  );
});

test("Pi Responses captures exclude history and document text without changing requests or tape", async (t) => {
  const harness = createPiHarness({ openaiApiKey: "sk-test", modelId: "gpt-5.6-sol" });
  const sink: Sink = { entries: [], tape: [] };
  const captures: HarnessLlmRequestRecord[] = [];
  const requests: unknown[] = [];
  mockFetch(t, async (_url: unknown, init?: RequestInit) => {
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
  });
  await harness.turns.runTurn(
    turnInput("capture-document-fallback", sink, {
      documents: [
        {
          name: "sample.rtf",
          mimeType: "application/rtf",
          dataBase64: (await readFile(new URL("./fixtures/documents/sample.rtf", import.meta.url))).toString("base64"),
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
  assert.match(JSON.stringify(sink.tape), /do the thing/);
  const firstEnvelope = promptEnvelopeBody(captures[0]!.promptEnvelope)!;
  assert.match(firstEnvelope.body, /BASE/);
  for (const capture of captures) {
    assert.equal(promptEnvelopeBody(capture.promptEnvelope)!.hash, firstEnvelope.hash);
    assert.doesNotMatch(JSON.stringify(capture.promptEnvelope), /do the thing|The turn ended with an empty message/);
  }
  assert.ok(JSON.stringify(requests).includes("RTF-QUARTZ-731"));
  assert.ok(captures.length > 0);
  assert.ok(!JSON.stringify(captures).includes("RTF-QUARTZ-731"));
  assert.ok(!JSON.stringify(sink.tape).includes("RTF-QUARTZ-731"));
});

for (const stopBeforeIntake of [false, true]) {
  test(`steering during a tool ${stopBeforeIntake ? "survives Stop without fabricated intake" : "lands after its result in live and replay order"}`, async (t) => {
    const signals = createMemoryRunSignalStore();
    const harness = createPiHarness({ apiKey: "sk-test", signals });
    const store = createMemorySessionStore();
    const session = await store.getOrCreateByThread("web:steer-tool", "dm", "personal:tester" as ScopeId);
    const lease = (await store.acquireLease(session.id, "turn")).lease!;
    let calls = 0;
    mockFetch(t, async () => {
      if (++calls > 1) return sse(textReplyEvents("done"));
      return sse(toolUseEvents("read-memory", "memory", { action: "read" }));
    });
    const entries: SessionEntry[] = [];
    t.after(async () => {
      await store.releaseLease(lease);
      await harness.turns.close?.();
    });
    await harness.turns.runTurn(
      turnInput(
        session.id,
        { entries: [], tape: [] },
        {
          session,
          runId: "tool-steer",
          tools: {
            memoryRead: async () => {
              await signals.send("tool-steer", { kind: "steer", text: "use the other file", ts: "tool.1" });
              await new Promise((resolve) => setTimeout(resolve, 30));
              assert.equal(entries.filter((entry) => entry.type === "user").length, 1);
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
          tape: (row) => store.appendTape(lease, row),
        },
      ),
    );
    const tape = await store.getTape(session.id);
    const steerRows = tape.filter((row) => row.meta?.ts === "tool.1");
    const users = entries.filter((entry) => entry.type === "user");
    if (stopBeforeIntake) {
      assert.equal(users.length, 1);
      assert.equal(steerRows.length, 0);
      assert.equal((await signals.pending("tool-steer")).filter((row) => row.signal.kind === "steer").length, 1);
      const before = calls;
      await harness.turns.runTurn(turnInput(session.id, { entries: [], tape: [] }));
      assert.equal(calls, before + 1, "cached Pi session must not redeliver the queued steer on its own");
    } else {
      assert.deepEqual(
        entries.map((entry) => entry.type),
        ["user", "tool_call", "tool_result", "user", "assistant"],
      );
      assert.equal(steerRows[0]?.entrySeq, users[1]?.seq);
      assert.equal(steerRows[0]?.meta?.entryCreatedAt, users[1]?.createdAt);
      const { projectTapeEntries } = await import("../src/harness/tape-projection.ts");
      const replay = projectTapeEntries(session.id, tape);
      assert.ok(replay);
      assert.deepEqual(
        replay.entries.map((entry) => [entry.seq, entry.type]),
        entries.map((entry) => [entry.seq, entry.type]),
      );
      assert.equal((await signals.pending("tool-steer")).length, 0);
    }
  });
}

for (const failure of ["acknowledge", "tape"] as const) {
  test(`a consumed steer is recorded when ${failure === "acknowledge" ? "its acknowledgement fails" : "an earlier tape append failed"}`, async (t) => {
    const signals = createMemoryRunSignalStore();
    if (failure === "acknowledge")
      signals.acknowledge = async () => {
        throw new Error("signal store unavailable");
      };
    const harness = createPiHarness({ apiKey: "sk-test", signals });
    const sink: Sink = { entries: [], tape: [] };
    let calls = 0;
    mockFetch(t, async () => {
      if (++calls > 1) return sse(textReplyEvents("done"));
      return sse(toolUseEvents("read-memory", "memory", { action: "read" }));
    });
    t.after(async () => {
      await harness.turns.close?.();
    });
    const turn = turnInput("steer-failure", sink, {
      runId: "steer-failure",
      tools: {
        memoryRead: async () => {
          await signals.send("steer-failure", { kind: "steer", text: "use the other file", ts: "fail.1" });
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "saved facts";
        },
      } as HarnessTurnInput["tools"],
      tape: async (rec: NewTapeRecord) => {
        if (failure === "tape" && rec.kind === "message" && (rec.payload as { role?: string }).role === "toolResult")
          throw new Error("tape insert refused");
        sink.tape.push(rec);
      },
    });
    const steered = () =>
      sink.entries.filter((entry) => entry.type === "user" && (entry.payload as { steered?: boolean }).steered);
    if (failure === "tape") {
      await assert.rejects(harness.turns.runTurn(turn), /tape insert refused/);
      assert.equal(steered().length, 1, "the consumed steer keeps its canonical intake entry");
      assert.equal((await signals.pending("steer-failure")).length, 0, "the recorded steer is acknowledged");
      assert.equal(
        sink.tape.some((rec) => rec.meta?.ts === "fail.1"),
        false,
        "no tape row is written after the tape failed",
      );
    } else {
      const result = await harness.turns.runTurn(turn);
      assert.equal(result.reply, "done", "an acknowledgement failure does not tear down the live turn");
      assert.equal(steered().length, 1);
      assert.equal(sink.tape.find((rec) => rec.meta?.ts === "fail.1")?.entrySeq, steered()[0]!.seq);
      assert.equal(
        (await signals.pending("steer-failure")).filter((row) => row.signal.kind === "steer").length,
        1,
        "an unacknowledged steer stays pending for replay",
      );
    }
  });
}
