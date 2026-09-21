import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { contentText, createAssistantMessageEventStream, type StopReason } from "@earendil-works/pi-ai";
import { summarizeHistory } from "../src/harness/history-summary.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { createContextSummaryPayload } from "../src/sessions/session-store.ts";
import { zeroUsage } from "../src/harness/replay.ts";
import type { SessionEntry } from "../src/types.ts";

const model = getRequiredModel("claude-opus-5");
const summary = "## Goal\nInvestigate migration failures.\n## Constraints & Preferences\nDo not change production.";
const entry = (seq: number, type: SessionEntry["type"], payload: unknown): SessionEntry => ({
  sessionId: "test-session",
  seq,
  parentSeq: null,
  type,
  payload,
  scopeLabel: "personal:test-user",
  createdAt: 1_700_000_000_000 + seq,
});

function response(text = summary, stopReason: StopReason = "stop") {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason,
    timestamp: 0,
  });
  return stream;
}

for (const ending of ["Reconstruct the migration hash from the test files.", "what? local recovery what?"]) {
  test(`compaction closes the transcript and requests a summary after: ${ending}`, async () => {
    const result = await summarizeHistory(
      [
        entry(1, "user", { text: "Investigate the migration. Don't change production." }),
        entry(136, "user", { text: ending }),
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
        assert.match(prompt, /user#136/);
        assert.equal(options?.maxTokens, 8000);
        assert.equal(options?.cacheRetention, "none");
        return response();
      },
    );
    assert.equal(result, summary);
  });
}

test("repeated compaction separates the latest summary and only summarizes its uncovered suffix", async () => {
  const history = [
    entry(1, "user", { text: "covered request" }),
    entry(2, "system", createContextSummaryPayload(1, "superseded summary")),
    entry(3, "user", { text: "covered follow-up" }),
    entry(4, "user", { text: "a later unresolved request" }),
    entry(5, "system", createContextSummaryPayload(3, summary)),
    entry(6, "user", { overheard: true, name: "Alice", text: "unverified claim" }),
    entry(7, "tool_call", { tool: "execute", command: "check", callId: "pending" }),
  ];
  await summarizeHistory(history, model, (_model, context) => {
    const prompt = contentText(context.messages[0]!.content);
    assert.ok(prompt.includes(`<previous-summary>\n${summary}\n</previous-summary>`));
    assert.match(prompt, /Update the existing structured summary/);
    assert.doesNotMatch(prompt, /superseded summary|covered request|covered follow-up|system#5/);
    assert.match(prompt, /user#4.*a later unresolved request/);
    assert.match(prompt, /overheard#6.*Alice.*unverified claim/);
    assert.match(prompt, /tool_result for tool_call#7 \(none recorded\)/);
    return response();
  });
});

for (const stopReason of ["length", "aborted", "error", "toolUse"] as const) {
  test(`compaction rejects ${stopReason} even when partial text exists`, async () => {
    await assert.rejects(
      summarizeHistory([], model, () => response("partial summary", stopReason)),
      /did not complete|Summarization failed/,
    );
  });
}

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

for (const errorMessage of [
  "503 service unavailable",
  "connection lost",
  "Anthropic stream ended before message_stop",
]) {
  test(`compaction retries transient result: ${errorMessage}`, async () => {
    let attempts = 0;
    const result = await summarizeHistory(
      [],
      model,
      () => {
        attempts++;
        if (attempts === 3) return response();
        const stream = createAssistantMessageEventStream();
        stream.end({
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: zeroUsage(),
          stopReason: "error",
          errorMessage,
          timestamp: 0,
        });
        return stream;
      },
      { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } },
    );
    assert.equal(result, summary);
    assert.equal(attempts, 3);
  });
}

for (const errorMessage of [
  "request violates Anthropic's usage policy",
  "Provider returned error: request violates Anthropic usage policy",
])
  test(`compaction refusal is terminal and rejects partial text: ${errorMessage}`, async () => {
    let attempts = 0;
    await assert.rejects(
      summarizeHistory(
        [],
        model,
        () => {
          attempts++;
          const stream = createAssistantMessageEventStream();
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: summary }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: zeroUsage(),
            stopReason: "error",
            errorMessage,
            timestamp: 0,
          });
          return stream;
        },
        { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } },
      ),
      { name: "NonRetryableTurnError" },
    );
    assert.equal(attempts, 1);
  });

test("compaction cancellation after a successful response still rejects the summary", async () => {
  const controller = new AbortController();
  await assert.rejects(
    summarizeHistory(
      [],
      model,
      () => {
        controller.abort();
        return response();
      },
      { signal: controller.signal },
    ),
    /aborted/i,
  );
});
