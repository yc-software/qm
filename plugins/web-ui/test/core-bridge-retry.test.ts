import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import { pollRun, setClock, RUN_IDLE_MS, type Acc } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

function blankAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function freshAcc(t0: number): Acc {
  return { acc: "", lastProgressAt: t0 };
}

function drain(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessage> {
  return stream.result();
}

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  setClock(() => Date.now());
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

function instantSleep(): void {
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void) => {
    queueMicrotask(() => fn());
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

test("a transient fetch failure mid-poll is retried — the turn still completes", async () => {
  let clock = 1_000_000;
  setClock(() => clock);
  instantSleep();

  let i = 0;
  globalThis.fetch = (async () => {
    i++;
    clock += 1_000;
    if (i === 1)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "running", result: null, partial: "he" }),
      } as unknown as Response;
    if (i <= 3) throw new TypeError("network error");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "done", result: { status: "ok", reply: "hello" }, partial: "hello" }),
    } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-r1", freshAcc(clock));
  const final = await drain(stream);

  assert.equal(final.stopReason, "stop", "the transient failures did not fail the turn");
  const block = final.content[0];
  assert.equal(block?.type === "text" ? block.text : "", "hello");
  assert.ok(i >= 4, "polling resumed after the failures");
});

test("a transient 5xx mid-poll is retried — the turn still completes", async () => {
  let clock = 2_000_000;
  setClock(() => clock);
  instantSleep();

  let i = 0;
  globalThis.fetch = (async () => {
    i++;
    clock += 1_000;
    if (i <= 2)
      return {
        ok: false,
        status: 502,
        text: async () => JSON.stringify({ error: "bad_gateway" }),
      } as unknown as Response;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "done", result: { status: "ok", reply: "ok!" }, partial: "ok!" }),
    } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-r2", freshAcc(clock));
  const final = await drain(stream);

  assert.equal(final.stopReason, "stop");
  const block = final.content[0];
  assert.equal(block?.type === "text" ? block.text : "", "ok!");
});

test("a 4xx is definitive — the poll fails immediately without retrying", async () => {
  const clock = 3_000_000;
  setClock(() => clock);
  instantSleep();

  let i = 0;
  globalThis.fetch = (async () => {
    i++;
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: "not_found" }) } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-r3", freshAcc(clock));
  const final = await drain(stream);

  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "not_found");
  assert.equal(i, 1, "no retries after a definitive 4xx");
});

test("persistent transient failures past the idle window fail with a timeout, not a crash", async () => {
  let clock = 4_000_000;
  setClock(() => clock);
  instantSleep();

  globalThis.fetch = (async () => {
    clock += RUN_IDLE_MS / 2;
    throw new TypeError("network down");
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-r4", freshAcc(clock));
  const final = await drain(stream);

  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "Timed out waiting for the agent to respond.");
});

test("poll requests never put bearer credentials in the URL", async () => {
  let clock = 5_000_000;
  setClock(() => clock);
  instantSleep();

  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    clock += 1_000;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "done", result: { status: "ok", reply: "x" }, partial: "x" }),
    } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-r5", freshAcc(clock));
  await drain(stream);

  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.endsWith("/api/runs/run-r5"), urls[0]);
  assert.doesNotMatch(urls[0]!, /[?&](?:rt|token)=/);
});

test("a failed initial submission is retryable with the same client turn id", async () => {
  const { makeCoreStreamFn } = await import("../src/core-bridge.ts");
  const submitted: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input, init) => {
    submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (submitted.length === 1) throw new TypeError("Failed to fetch");
    return Response.json({ status: "ok", reply: "delivered" });
  }) as typeof fetch;
  const userMessage = { role: "user", content: "hello" } as { role: "user"; content: string; sendFailure?: string };
  const agent = {
    state: { model: MODEL, messages: [userMessage], tools: [] },
  } as unknown as import("@earendil-works/pi-agent-core").Agent;
  const streamFn = makeCoreStreamFn("web:alice:one", agent);

  const failedStream = await streamFn(MODEL, {} as import("@earendil-works/pi-ai").Context);
  const failed = await failedStream.result();
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "Message wasn’t sent. Check your connection and try again.");
  assert.equal((failed as { retryableSend?: boolean }).retryableSend, true);
  assert.equal(userMessage.sendFailure, "Message wasn’t sent. Check your connection and try again.");

  const retriedStream = await streamFn(MODEL, {} as import("@earendil-works/pi-ai").Context);
  const retried = await retriedStream.result();
  assert.equal(retried.stopReason, "stop");
  assert.equal(submitted[0]?.clientTurnId, submitted[1]?.clientTurnId);
  assert.match(String(submitted[0]?.clientTurnId), /^[0-9a-f-]{36}$/);
});
