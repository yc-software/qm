import assert from "node:assert/strict";
import test from "node:test";
import { createSecurityScreenProxy, runShadowScreen } from "../src/security/security-screener.ts";

test("the security screen proxy sends the neutral classifier contract and maps its scores", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const results = [
    { score: 0.04, threshold: 0.7, primary_outcome: "benign" },
    { score: 0.96, threshold: 0.7, primary_outcome: "system_compromise" },
  ];
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: true,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return new Response(JSON.stringify(results.shift()), { status: 200 });
    },
  });

  const benign = await screener.classify({
    payload: "ordinary issue text",
    hook: "user_input",
    metadata: { origin: "automation", surface: "webhook" },
    requestId: "request-1",
  });
  assert.deepEqual(benign.verdict, { decision: "auto" });

  const malicious = await screener.classify({ payload: "hostile tool output", hook: "tool_response" });
  assert.deepEqual(malicious.verdict, { decision: "strict", reason: "example-screen:system_compromise" });
  assert.equal(malicious.score, 0.96);
  assert.equal(screener.provider, "example-screen");
  assert.equal(screener.shadow, true);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://screen.example.test/classify", "https://screen.example.test/classify"],
  );
  assert.equal(new Headers(calls[0]!.init.headers).get("x-api-key"), "test-token");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    text: "ordinary issue text",
    hook: "user_input",
    metadata: {
      origin: "automation",
      surface: "webhook",
      qm: { request_id: "request-1", input_index: 0, chunk_index: 0, chunk_count: 1 },
      "example-screen": { request_id: "request-1", input_index: 0, chunk_index: 0, chunk_count: 1 },
    },
  });
});

test("the security screen proxy classifies long input in overlapping bounded windows", async () => {
  const bodies: Array<{
    text: string;
    metadata: { qm: { request_id: string; input_index: number; chunk_index: number; chunk_count: number } };
  }> = [];
  let active = 0;
  let maxActive = 0;
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 500,
    shadow: false,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const malicious = body.text.includes("tail-attack");
      return new Response(
        JSON.stringify({
          score: malicious ? 0.8 : 0.9,
          threshold: malicious ? 0.7 : 0.95,
          primary_outcome: malicious ? "prompt_injection" : "benign",
        }),
      );
    },
  });

  const result = await screener.classify({
    payload: `${"a".repeat(15_950)}tail-attack`,
    hook: "tool_response",
  });

  assert.deepEqual(result.verdict, { decision: "strict", reason: "example-screen:prompt_injection" });
  assert.equal(result.score, 0.8);
  assert.equal(bodies.length, 12);
  assert.equal(maxActive, 2);
  assert.ok(bodies.every((body) => body.text.length <= 1_600));
  const ordered = bodies.toSorted((a, b) => a.metadata.qm.chunk_index - b.metadata.qm.chunk_index);
  assert.equal(ordered[0]!.text.slice(-256), ordered[1]!.text.slice(0, 256));
  assert.ok(
    ordered.every(
      (body, index) =>
        body.metadata.qm.request_id === ordered[0]!.metadata.qm.request_id &&
        body.metadata.qm.input_index === 0 &&
        body.metadata.qm.chunk_index === index &&
        body.metadata.qm.chunk_count === 12,
    ),
  );
  assert.ok(
    ordered.every(
      (body) =>
        JSON.stringify((body.metadata as Record<string, unknown>)["example-screen"]) ===
        JSON.stringify(body.metadata.qm),
    ),
  );
});

test("the security screen proxy keeps Unicode chunk boundaries well formed", async () => {
  const chunks: string[] = [];
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: false,
    fetch: async (_input, init) => {
      chunks.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response(JSON.stringify({ score: 0.1, threshold: 0.7 }));
    },
  });

  await screener.classify({
    payload: `${"a".repeat(1_599)}😀${"b".repeat(100)}\ud800`,
    hook: "tool_response",
  });

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.isWellFormed() && chunk.length <= 1_600));
  assert.equal(chunks[0]!.slice(-256), chunks[1]!.slice(0, 256));
  assert.equal(chunks[1]!.at(-1), "\ufffd");
});

test("shadow observation never delays the authoritative classifier", async () => {
  const never = new Promise<never>(() => {});
  const verdict = await Promise.race([
    runShadowScreen(
      async () => ({ decision: "auto" as const }),
      () => never,
      () => assert.fail("an unfinished shadow call must not report a comparison"),
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shadow delayed authority")), 50)),
  ]);
  assert.deepEqual(verdict, { decision: "auto" });
});

test("the security screen proxy rejects malformed responses and HTTP failures", async () => {
  for (const response of [
    new Response("not json"),
    new Response(JSON.stringify({ score: Number.NaN, threshold: 0.7 })),
    new Response(JSON.stringify({ score: 0.8, threshold: 1.1 })),
    new Response(JSON.stringify({ score: 0.8, threshold: 0.7, primary_outcome: "bad\noutcome" })),
    new Response("unavailable", { status: 503 }),
  ]) {
    const screener = createSecurityScreenProxy({
      provider: "example-screen",
      endpoint: "https://screen.example.test/classify",
      token: "test-token",
      timeoutMs: 50,
      shadow: false,
      fetch: async () => response,
    });
    await assert.rejects(
      screener.classify({ payload: "hostile content", hook: "user_input" }),
      /security screen proxy/i,
    );
  }
});

test("the security screen proxy retries throttled requests within its deadline", async () => {
  let calls = 0;
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: false,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ score: 0.1, threshold: 0.7 }));
    },
  });
  const result = await screener.classify({ payload: "ordinary content", hook: "user_input" });
  assert.deepEqual(result.verdict, { decision: "auto" });
  assert.equal(calls, 2);

  let bareCalls = 0;
  const backingOff = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 10,
    shadow: false,
    fetch: async () => {
      bareCalls += 1;
      return new Response("", { status: 429 });
    },
  });
  await assert.rejects(
    backingOff.classify({ payload: "ordinary content", hook: "user_input" }),
    (error: unknown) => error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name),
  );
  assert.equal(bareCalls, 1);
});

test("the security screen proxy aborts sibling chunks after a terminal failure", async () => {
  const started: number[] = [];
  let ready!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 100,
    shadow: false,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { metadata: { qm: { chunk_index: number } } };
      const index = body.metadata.qm.chunk_index;
      started.push(index);
      if (started.length === 2) ready();
      await bothStarted;
      if (index === 0) return new Response("unavailable", { status: 503 });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  await assert.rejects(screener.classify({ payload: "x".repeat(16_000), hook: "tool_response" }), /HTTP 503/);
  assert.deepEqual(
    started.toSorted((a, b) => a - b),
    [0, 1],
  );
});

test("the security screen proxy bounds response size and request time", async () => {
  let cancelled = 0;
  const declaredOversized = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: false,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled += 1;
          },
        }),
        { headers: { "content-length": String(64 * 1024 + 1) } },
      ),
  });
  await assert.rejects(
    declaredOversized.classify({ payload: "ordinary content", hook: "user_input" }),
    /response exceeds the supported limit/,
  );

  const failed = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: false,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled += 1;
          },
        }),
        { status: 503 },
      ),
  });
  await assert.rejects(failed.classify({ payload: "ordinary content", hook: "user_input" }), /HTTP 503/);
  assert.equal(cancelled, 2);

  const oversized = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: false,
    fetch: async () => new Response("x".repeat(64 * 1024 + 1)),
  });
  await assert.rejects(
    oversized.classify({ payload: "ordinary content", hook: "user_input" }),
    /response exceeds the supported limit/,
  );

  const timedOut = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 5,
    shadow: false,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  });
  await assert.rejects(
    timedOut.classify({ payload: "ordinary content", hook: "user_input" }),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
});

test("the security screen proxy accepts concurrent classifications and rejects oversized work", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: false,
    fetch: async () => {
      calls += 1;
      await pending;
      return new Response(JSON.stringify({ score: 0.1, threshold: 0.7, primary_outcome: "benign" }));
    },
  });
  const first = screener.classify({ payload: "one", hook: "tool_response" });
  const second = screener.classify({ payload: "two", hook: "tool_response" });
  const third = screener.classify({ payload: "three", hook: "tool_response" });
  await assert.rejects(
    screener.classify({ payload: "x".repeat(16_001), hook: "tool_response" }),
    /exceeds the supported limit/,
  );
  assert.equal(calls, 3);
  release();
  await Promise.all([first, second, third]);
});

test("the security screen proxy drops excess detached shadow work", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const screener = createSecurityScreenProxy({
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    token: "test-token",
    timeoutMs: 50,
    shadow: true,
    fetch: async () => {
      await pending;
      return new Response(JSON.stringify({ score: 0.1, threshold: 0.7 }));
    },
  });
  const first = screener.classify({ payload: "one", hook: "user_input" });
  const second = screener.classify({ payload: "two", hook: "user_input" });
  await assert.rejects(screener.classify({ payload: "three", hook: "user_input" }), /shadow capacity reached/);
  release();
  await Promise.all([first, second]);
});
