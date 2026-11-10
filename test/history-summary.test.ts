import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { contentText, createAssistantMessageEventStream, type StopReason } from "@earendil-works/pi-ai";
import { summarizeHistory } from "../src/agent/history-summary.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { type NewItem, storedItem } from "../src/sessions/items.ts";
import { ProviderTurnError } from "../src/core/turn-error.ts";
import { buildModelRuntime, zeroUsage } from "../src/model/model-runtime.ts";

const model = getRequiredModel("claude-opus-5");
const summary = "## Goal\nInvestigate migration failures.\n## Constraints & Preferences\nDo not change production.";
const item = (seq: number, fields: NewItem) =>
  storedItem(fields, { sessionId: "test-session", seq, createdAt: 1_700_000_000_000 + seq });

function response(text = summary, stopReason: StopReason = "stop", usage = zeroUsage()) {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: 0,
  });
  return stream;
}

for (const ending of ["Reconstruct the migration hash from the test files.", "what? local recovery what?"]) {
  test(`compaction closes the transcript and requests a summary after: ${ending}`, async () => {
    const result = await summarizeHistory(
      [
        item(1, { kind: "UserMessage", text: "Investigate the migration. Don't change production." }),
        item(136, { kind: "UserMessage", text: ending }),
      ],
      model,
      (_model, context, options) => {
        assert.match(context.systemPrompt ?? "", /Do NOT continue the conversation/);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]!.role, "user");
        const prompt = contentText(context.messages[0]!.content);
        assert.match(prompt, /^<conversation>\n/);
        const end = prompt.lastIndexOf("</conversation>");
        assert.ok(end > prompt.indexOf(ending));
        assert.match(prompt.slice(end), /Create a structured context checkpoint summary/);
        assert.match(prompt.slice(end), /## Constraints & Preferences/);
        assert.match(prompt, /UserMessage#136/);
        assert.match(prompt, /Tool results cannot be searched or reopened through history/);
        assert.match(prompt, /Preserve necessary facts from tool results inline/);
        assert.equal(options?.maxTokens, model.maxTokens);
        assert.equal(options?.cacheRetention, "none");
        return response();
      },
    );
    assert.equal(result, summary);
  });
}

test("repeated compaction separates the latest summary and only summarizes its uncovered suffix", async () => {
  const history = [
    item(1, { kind: "UserMessage", text: "covered request" }),
    item(2, { kind: "ContextCompaction", throughSeq: 1, text: "superseded summary" }),
    item(3, { kind: "UserMessage", text: "covered follow-up" }),
    item(4, { kind: "UserMessage", text: "a later unresolved request" }),
    item(5, { kind: "ContextCompaction", throughSeq: 3, text: summary }),
    item(6, { kind: "UserMessage", text: "unverified claim", body: { overheard: true, name: "Alice" } }),
    item(7, { kind: "ToolCall", callId: "pending", tool: "execute", body: { command: "check" } }),
  ];
  await summarizeHistory(history, model, (_model, context) => {
    const prompt = contentText(context.messages[0]!.content);
    assert.ok(prompt.includes(`<previous-summary>\n${summary}\n</previous-summary>`));
    assert.match(prompt, /Update the existing structured summary/);
    assert.doesNotMatch(prompt, /superseded summary|covered request|covered follow-up|ContextCompaction#5/);
    assert.match(prompt, /UserMessage#4.*a later unresolved request/);
    assert.match(prompt, /overheard#6.*Alice.*unverified claim/);
    assert.match(prompt, /ToolResult for ToolCall#7 \(none recorded\)/);
    return response();
  });
});

test("compaction rejects a provider error as a typed ProviderTurnError", async () => {
  await assert.rejects(
    summarizeHistory([], model, () => response("partial summary", "error")),
    (err: unknown) => err instanceof ProviderTurnError,
  );
});

for (const stopReason of ["length", "aborted", "toolUse"] as const) {
  test(`compaction rejects ${stopReason} even when partial text exists`, async () => {
    await assert.rejects(
      summarizeHistory([], model, () => response("partial summary", stopReason)),
      /did not complete/,
    );
  });
}

test("compaction length errors report the output limit and token usage", async () => {
  await assert.rejects(
    summarizeHistory([], model, (_model, _context, options) =>
      response("partial summary", "length", { ...zeroUsage(), output: options!.maxTokens!, reasoning: 30500 }),
    ),
    {
      message: `Compaction did not complete (length): the summary hit the ${model.maxTokens}-token output limit (output tokens ${model.maxTokens}, reasoning tokens 30500)`,
    },
  );
  await assert.rejects(
    summarizeHistory([], model, () => response("partial summary", "length", { ...zeroUsage(), output: 9 })),
    /output tokens 9, reasoning tokens not reported\)$/,
  );
});

test("compaction length errors report the output cap the provider payload carried", async () => {
  await assert.rejects(
    summarizeHistory([], model, async (_model, _context, options) => {
      await options!.onPayload!({ max_tokens: 32000 }, model);
      return response("partial summary", "length", { ...zeroUsage(), output: 32000 });
    }),
    /hit the 32000-token output limit \(output tokens 32000, reasoning tokens not reported\)$/,
  );
});

test("compaction propagates transport failures and rejects empty output", async () => {
  await assert.rejects(
    summarizeHistory([], model, () => {
      throw new Error("connection lost");
    }),
    /connection lost/,
  );
  await assert.rejects(
    summarizeHistory([], model, () => response("")),
    /empty summary/,
  );
});

for (const modelId of ["gpt-6-astra", "claude-opus-5", "gpt-4.1"]) {
  test(`compaction enables low reasoning only when supported by ${modelId}`, async () => {
    const summaryModel = getRequiredModel(modelId);
    await summarizeHistory([], summaryModel, (_model, _context, options) => {
      assert.equal(options?.reasoning, summaryModel.reasoning ? "low" : undefined);
      return response();
    });
  });
}

test("Astra compaction serializes a supported reasoning effort through the provider adapter", async (t) => {
  const runtime = await buildModelRuntime({ openai: "sk-offline-test-key" });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: { model?: string; reasoning?: { effort?: string } } | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
    const text = encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body);
    request = JSON.parse(text);
    if (request?.reasoning?.effort !== "low") {
      return new Response(JSON.stringify({ error: { message: "unsupported reasoning effort" } }), { status: 400 });
    }
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_summary" } },
      { type: "response.output_text.delta", output_index: 0, delta: summary },
      { type: "response.completed", response: { id: "resp_summary", status: "completed", output: [] } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const result = await summarizeHistory([], getRequiredModel("gpt-6-astra"), (model, context, options) =>
    runtime.streamSimple(model, context, { ...options, transport: "sse", maxRetries: 0 }),
  );
  assert.equal(result, summary);
  assert.ok(request, "compaction must reach the provider's HTTP transport");
  assert.equal(request.model, "gpt-6-astra");
  assert.equal(request.reasoning?.effort, "low");
});
