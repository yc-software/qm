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
  return { acc: "", startOffset: 0, lastProgressAt: t0 };
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
    if (i === 1) return Response.json({ status: "running", result: null, partial: "he" });
    if (i <= 3) throw new TypeError("network error");
    return Response.json({ status: "done", result: { status: "ok", reply: "hello" }, partial: "hello" });
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
    if (i <= 2) return Response.json({ error: "bad_gateway" }, { status: 502 });
    return Response.json({ status: "done", result: { status: "ok", reply: "ok!" }, partial: "ok!" });
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
    return Response.json({ error: "not_found" }, { status: 404 });
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
    return Response.json({ status: "done", result: { status: "ok", reply: "x" }, partial: "x" });
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-r5", freshAcc(clock));
  await drain(stream);

  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.endsWith("/api/runs/run-r5"), urls[0]);
  assert.doesNotMatch(urls[0]!, /[?&](?:rt|token)=/);
});
