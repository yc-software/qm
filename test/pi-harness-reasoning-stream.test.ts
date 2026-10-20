import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

type Logged = { kind: "reasoning" | "text" | "entry"; type?: string; step?: string; index?: number; value: unknown };

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`;
}

const opening = [
  {
    type: "message_start",
    message: {
      id: "msg",
      type: "message",
      role: "assistant",
      content: [],
      model: "m",
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "**Checking** the " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "cache" } },
];

const closing = [
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Cache is warm." } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

function turnInput(log: Logged[], overrides: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 1;
  return {
    session: { id: "reasoning-stream" } as HarnessTurnInput["session"],
    runId: "run-1",
    input: "is the cache warm?",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (e: NewEntry) => {
      log.push({ kind: "entry", type: e.type, value: JSON.parse(JSON.stringify(e.payload ?? null)) });
      return {
        ...e,
        sessionId: "reasoning-stream",
        seq: seq++,
        parentSeq: null,
        createdAt: Date.now(),
      } as SessionEntry;
    },
    onDelta: (chunk) => log.push({ kind: "text", value: chunk }),
    onReasoningDelta: (step, index, chunk) => log.push({ kind: "reasoning", step, index, value: chunk }),
    recordModelCall: () => {},
    ...overrides,
  };
}

async function withStream<T>(
  body: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  run: () => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
          {
            once: true,
          },
        );
        body(controller);
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const encode = (events: Array<Record<string, unknown>>) => new TextEncoder().encode(events.map(frame).join(""));

test("pi streams thinking deltas before message end under the step id the persisted thinking entry carries", async () => {
  const log: Logged[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const result = await withStream(
    (controller) => {
      controller.enqueue(encode(opening));
      void released.then(() => {
        controller.enqueue(encode(closing));
        controller.close();
      });
    },
    () =>
      createPiHarness({ apiKey: "sk-test" }).turns.runTurn(
        turnInput(log, {
          onReasoningDelta: (step, index, chunk) => {
            log.push({ kind: "reasoning", step, index, value: chunk });
            if (log.filter((l) => l.kind === "reasoning").length === 2) {
              assert.equal(
                log.some((l) => l.type === "thinking"),
                false,
                "reasoning is visible before the block is persisted",
              );
              release();
            }
          },
        }),
      ),
  );
  assert.equal(result.reply, "Cache is warm.");
  const reasoning = log.filter((l) => l.kind === "reasoning");
  assert.equal(reasoning.map((l) => l.value).join(""), "**Checking** the cache");
  assert.equal(
    log
      .filter((l) => l.kind === "text")
      .map((l) => l.value)
      .join(""),
    "Cache is warm.",
    "reasoning never enters reply text",
  );
  const thinking = log.find((l) => l.type === "thinking")!.value as {
    thinking: string;
    thinkingSignature: string;
    step: { id: string; index: number };
  };
  assert.equal(thinking.thinking, "**Checking** the cache");
  assert.equal(thinking.thinkingSignature, "sig", "the durable entry still carries the provider signature");
  assert.deepEqual(
    new Set(reasoning.map((l) => `${l.step}:${l.index}`)),
    new Set([`${thinking.step.id}:${thinking.step.index}`]),
  );
});

test("a cancel mid-reasoning persists the streamed partial under the streamed block id, so the live row hands off", async () => {
  const log: Logged[] = [];
  const cancel = new AbortController();
  const result = await withStream(
    (controller) => controller.enqueue(encode(opening)),
    () =>
      createPiHarness({ apiKey: "sk-test" }).turns.runTurn(
        turnInput(log, {
          cancel: cancel.signal,
          onReasoningDelta: (step, index, chunk) => {
            log.push({ kind: "reasoning", step, index, value: chunk });
            if (chunk === "cache") cancel.abort();
          },
        }),
      ),
  );
  assert.equal(result.stopped, true);
  const streamed = log.filter((l) => l.kind === "reasoning");
  assert.equal(streamed.map((l) => l.value).join(""), "**Checking** the cache");
  const persisted = log.filter((l) => l.type === "thinking");
  assert.equal(persisted.length, 1, "the stopped partial keeps its reasoning, as before");
  for (const entry of persisted) {
    const payload = entry.value as { thinking: string; step: { id: string; index: number } };
    assert.equal(payload.thinking, "**Checking** the cache");
    assert.equal(`${payload.step.id}:${payload.step.index}`, `${streamed[0]!.step}:${streamed[0]!.index}`);
  }
  assert.equal(
    log.some((l) => l.kind === "text"),
    false,
  );
});
