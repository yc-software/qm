import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { processRun } from "../src/runs/worker.ts";
import { runResultDelivery } from "../src/delivery/run-result-delivery.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { contentText, createAssistantMessageEventStream, type StopReason } from "@earendil-works/pi-ai";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { COMPACTION_REFUSED_TEXT } from "../plugins/chassis/src/failure-copy.ts";
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

function response(text = summary, stopReason: StopReason = "stop", errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
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
        assert.match(prompt, /Tool results cannot be searched or reopened through history/);
        assert.match(prompt, /Preserve necessary facts from tool results inline/);
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
      /did not complete/,
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

for (const message of [
  "This request was blocked under Anthropic's Usage Policy.",
  "This request would violate Anthropic’s usage policy.",
]) {
  test(`compaction treats explicit provider refusal as terminal: ${message}`, async () => {
    let calls = 0;
    await assert.rejects(
      summarizeHistory([], model, () => {
        calls++;
        return response("partial summary", "error", message);
      }),
      (error: unknown) => {
        assert.ok(error instanceof NonRetryableTurnError);
        assert.equal(error.message, COMPACTION_REFUSED_TEXT);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}

test("transient summary errors remain retryable", async () => {
  await assert.rejects(
    summarizeHistory([], model, () => response("", "error", "Request timed out.")),
    (error: unknown) => error instanceof Error && !(error instanceof NonRetryableTurnError),
  );
});

test("a compaction refusal parks the worker on its first attempt and delivers recovery instructions", async () => {
  const { runs } = createMemoryRunStore();
  const actor = { id: "test-user", type: "internal" as const };
  const orchestrator: Orchestrator = {
    async handleTurn() {
      await summarizeHistory([], model, () => response("", "error", "Blocked under Anthropic's Usage Policy."));
      throw new Error("must not reach the main turn");
    },
    async screenSecuritySteer() {
      return "allow";
    },
    async regenerateTitle() {
      return null;
    },
  };
  await runs.enqueue({
    sessionId: "test-thread",
    maxAttempts: 3,
    request: {
      surface: "slack",
      deliveryTarget: "test-channel",
      actor,
      conversation: { kind: "dm", threadRef: "test-thread", audience: [actor] },
      origin: { kind: "direct" },
      text: "hello",
    },
  });
  const run = await runs.claim("test-worker", 5_000);
  assert.ok(run);
  await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 5_000 }, run), NonRetryableTurnError);
  const failed = await runs.get(run.id);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(await runs.claim("test-worker", 5_000), null);
  assert.ok(runResultDelivery(failed)?.text.includes(COMPACTION_REFUSED_TEXT));
});
