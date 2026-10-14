import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { foldTape } from "../src/harness/tape-fold.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry, NewTapeRecord, TapeRecord } from "../src/sessions/session-store.ts";
import type { DocumentInput } from "../src/core/document-inputs.ts";
import type { SessionEntry } from "../src/types.ts";

type Body = Record<string, unknown>;

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function anthropicReply(text: string, toolCall?: string): Response {
  const block = toolCall ? { type: "tool_use", id: toolCall, name: "attach", input: {} } : { type: "text", text: "" };
  const delta = toolCall
    ? { type: "input_json_delta", partial_json: JSON.stringify({ files: ["a.txt"] }) }
    : { type: "text_delta", text };
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}

function responsesReply(text: string): Response {
  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

const withoutCacheMarkers = (value: unknown): string =>
  JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v));

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

function conversation(sessionId: string, seed: "tape" | "entries" = "tape") {
  const tape: TapeRecord[] = [];
  const entries: SessionEntry[] = [];
  const turn = (input: string, documents: DocumentInput[], historyDocuments: DocumentInput[]): HarnessTurnInput => {
    const rows = seed === "tape" ? [...tape] : [];
    const history = [...entries];
    return {
      session: { id: sessionId } as HarnessTurnInput["session"],
      input,
      systemPrompt: "BASE",
      history,
      tools: { attach: async () => ({ ok: true, files: [], staged: 0 }) } as unknown as HarnessTurnInput["tools"],
      scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
      emit: async (entry: NewEntry) => {
        const stored = { ...entry, sessionId, seq: entries.length, createdAt: Date.now() } as unknown as SessionEntry;
        entries.push(stored);
        return stored;
      },
      tape: async (rec: NewTapeRecord) => {
        tape.push({ ...rec, sessionId, seq: tape.length, createdAt: Date.now() });
      },
      recordModelCall: () => {},
      ...(rows.length ? { tapeRows: rows, tapeMode: "serve" as const, tapeFold: foldTape(rows) } : {}),
      documents,
      historyDocuments,
      cancel: AbortSignal.timeout(10_000),
    };
  };
  return { tape, entries, turn };
}

async function captureFetch<T>(reply: (body: Body) => Response, run: (bodies: Body[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const bodies: Body[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return reply(body);
  }) as typeof fetch;
  try {
    return await run(bodies);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("Anthropic wire keeps each document at its original message across steps and turns", async () => {
  const pdf = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  const report: DocumentInput = { name: "report.pdf", mimeType: "application/pdf", dataBase64: pdf, artifactId: "a1" };
  const notes: DocumentInput = {
    name: "notes.txt",
    mimeType: "text/plain",
    dataBase64: Buffer.from("NOTES-CONTENT-9137").toString("base64"),
    artifactId: "a2",
  };
  const harness = createPiHarness({ apiKey: "sk-test" });
  const { tape, turn } = conversation("anthropic-doc-replay");
  let toolStep = true;
  await captureFetch(
    () => {
      const reply = toolStep ? anthropicReply("", "toolu_1") : anthropicReply("done");
      toolStep = false;
      return reply;
    },
    async (bodies) => {
      await harness.turns.runTurn(turn("read the report", [report], []));
      assert.equal(bodies.length, 2, "tool step plus final answer");
      await harness.turns.runTurn(turn("what next?", [], [report]));
      await harness.turns.runTurn(turn("compare with notes", [notes], [report]));
      const messages = bodies.map((body) => body.messages as unknown[]);
      for (let i = 1; i < messages.length; i++) {
        const previous = messages[i - 1]!;
        assert.equal(
          withoutCacheMarkers(messages[i]!.slice(0, previous.length)),
          withoutCacheMarkers(previous),
          `request ${i} extends request ${i - 1} without rewriting earlier messages`,
        );
      }
      for (const body of messages) assert.equal(occurrences(JSON.stringify(body), pdf), 1);
      assert.ok(JSON.stringify(messages[0]![0]).includes(pdf), "the report stays on the message it came with");
      const last = messages.at(-1)!;
      assert.ok(JSON.stringify(last.at(-1)).includes("NOTES-CONTENT-9137"));
      assert.ok(!JSON.stringify(last.at(-1)).includes(pdf));
      assert.ok(!JSON.stringify(bodies).includes("qm-document-anchor"));
    },
  );
  assert.ok(!JSON.stringify(tape).includes(pdf), "tape keeps references, not bytes");
  assert.deepEqual(
    (tape.find((row) => (row.payload as { role?: string }).role === "user")!.payload as { documents?: unknown })
      .documents,
    [{ artifactId: "a1", name: "report.pdf", mimeType: "application/pdf" }],
  );
});

test("Responses wire keeps documents in place and drops unreadable ones without leaking anchors", async () => {
  const pdf = (await readFile(new URL("./fixtures/documents/sample.pdf", import.meta.url))).toString("base64");
  const report: DocumentInput = { name: "report.pdf", mimeType: "application/pdf", dataBase64: pdf, artifactId: "r1" };
  const harness = createPiHarness({ openaiApiKey: "sk-test", modelId: "gpt-5.6-sol" });
  const { turn } = conversation("responses-doc-replay");
  await captureFetch(
    () => responsesReply("ok"),
    async (bodies) => {
      await harness.turns.runTurn(turn("read the report", [report], []));
      await harness.turns.runTurn(turn("again", [], [report]));
      await harness.turns.runTurn(turn("and again", [], [report]));
      const inputs = bodies.map((body) => body.input as unknown[]);
      for (let i = 1; i < inputs.length; i++) {
        const previous = inputs[i - 1]!;
        assert.equal(JSON.stringify(inputs[i]!.slice(0, previous.length)), JSON.stringify(previous));
      }
      for (const input of inputs) assert.equal(occurrences(JSON.stringify(input), pdf), 1);
      await harness.turns.runTurn(turn("without access", [], []));
      const denied = JSON.stringify(bodies.at(-1)!.input);
      assert.ok(!denied.includes(pdf), "documents the audience can no longer read are not sent");
      assert.ok(!JSON.stringify(bodies).includes("qm-document-anchor"));
    },
  );
});

test("reconstructed history keeps refs, avoids re-stamping resumed documents and marks unavailable ones in place", async () => {
  const report: DocumentInput = {
    name: "report.txt",
    mimeType: "text/plain",
    dataBase64: Buffer.from("REPORT-CONTENT-5521").toString("base64"),
    artifactId: "t1",
  };
  for (const seed of ["tape", "entries"] as const) {
    const harness = createPiHarness({ apiKey: "sk-test" });
    const { entries, turn } = conversation(`reconstructed-${seed}`, seed);
    await captureFetch(
      () => anthropicReply("ok"),
      async (bodies) => {
        await harness.turns.runTurn(turn("read the report", [report], []));
        assert.deepEqual((entries[0]!.payload as { documents?: unknown }).documents, [
          { artifactId: "t1", name: "report.txt", mimeType: "text/plain" },
        ]);
        await harness.turns.runTurn(turn("resume where you left off", [report], [report]));
        await harness.turns.runTurn(turn("and now?", [], [report]));
        const messages = bodies.map((body) => body.messages as unknown[]);
        for (const [i, body] of messages.entries())
          assert.equal(occurrences(JSON.stringify(body), "REPORT-CONTENT-5521"), 1, `${seed} request ${i}`);
        for (const i of [1, 2])
          assert.equal(
            withoutCacheMarkers(messages[i]!.slice(0, messages[i - 1]!.length)),
            withoutCacheMarkers(messages[i - 1]),
            `${seed} request ${i} extends request ${i - 1}`,
          );
        await harness.turns.runTurn(turn("still there?", [], []));
        const revoked = JSON.stringify(bodies.at(-1)!.messages);
        assert.ok(!revoked.includes("REPORT-CONTENT-5521"));
        assert.ok(revoked.includes("An attached document is no longer available."));
        assert.ok(!JSON.stringify(bodies).includes("qm-document-anchor"));
      },
    );
  }
});
