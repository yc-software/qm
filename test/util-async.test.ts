import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep, createKeyedQueue, fetchWithRetry, jitteredBackoffMs, retryAfterMs } from "../src/util/async.ts";

test("sleep resolves after roughly the given delay", async () => {
  const t0 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t0 >= 15, "waited at least most of the delay");
});

test("createKeyedQueue runs ops on one key strictly in submission order", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  const op = (name: string, ms: number) =>
    run("k", async () => {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
      return name;
    });
  const results = await Promise.all([op("a", 25), op("b", 5), op("c", 0)]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  assert.deepEqual(results, ["a", "b", "c"], "each caller gets its own op's result");
});

test("createKeyedQueue lets independent keys interleave", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow = run("a", async () => {
    order.push("a:start");
    await gate;
    order.push("a:end");
  });
  await run("b", async () => {
    order.push("b");
  });
  assert.deepEqual(order, ["a:start", "b"], "b completed while a was still in flight");
  release();
  await slow;
});

test("createKeyedQueue delivers a rejection to its caller without breaking the chain", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  const first = run("k", async () => {
    order.push("first");
  });
  const middle = run("k", async () => {
    order.push("middle");
    throw new Error("boom");
  });
  const last = run("k", async () => {
    order.push("last");
    return "ok";
  });
  await first;
  await assert.rejects(middle, /boom/);
  assert.equal(await last, "ok", "the op after a failure still runs and resolves");
  assert.deepEqual(order, ["first", "middle", "last"]);
});

test("createKeyedQueue keeps working on a key after it drains", async () => {
  const run = createKeyedQueue<string>();
  const order: string[] = [];
  await run("k", async () => {
    order.push("a");
  });
  await sleep(5);
  const b = run("k", async () => {
    order.push("b");
    await sleep(10);
  });
  const c = run("k", async () => {
    order.push("c");
  });
  await Promise.all([b, c]);
  assert.deepEqual(order, ["a", "b", "c"], "a fresh chain on the same key still serializes");
});

test("createKeyedQueue ops queued at drain time are not lost to the cleanup race", async () => {
  const run = createKeyedQueue<string>();
  const order: string[] = [];
  const first = run("k", async () => {
    order.push("first");
  });
  const second = first.then(() =>
    run("k", async () => {
      order.push("second");
      return "ok";
    }),
  );
  assert.equal(await second, "ok");
  assert.deepEqual(order, ["first", "second"]);
});

test("withAbort cleans listeners after resolution, rejection, and cancellation", async () => {
  const { withAbort } = await import("../src/util/async.ts");
  const { default: EventEmitter } = await import("node:events");
  const controller = new AbortController();
  assert.equal(await withAbort(async () => "ok", controller.signal), "ok");
  assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(
    withAbort(async () => {
      throw new Error("read failed");
    }, controller.signal),
    /read failed/,
  );
  assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 0);
  const pending = Promise.withResolvers<string>();
  const result = withAbort(() => pending.promise, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 0);
  pending.reject(new Error("late IO failure"));
  await sleep(0);
});

test("withAbort skips an already cancelled operation and preserves the reason", async () => {
  const { withAbort } = await import("../src/util/async.ts");
  const reason = new Error("cancelled");
  let called = false;
  await assert.rejects(
    withAbort(async () => {
      called = true;
    }, AbortSignal.abort(reason)),
    (error) => error === reason,
  );
  assert.equal(called, false);
  assert.equal(await withAbort(async () => 42), 42);
});

test("retryAfterMs reads seconds or an HTTP date and caps the wait", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" })), 2_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "0" })), 0);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "900" })), 30_000);
  const now = Date.parse("2026-09-18T12:00:00Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Fri, 18 Sep 2026 12:00:05 GMT" }), now), 5_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Fri, 18 Sep 2026 11:00:00 GMT" }), now), 0);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" })), undefined);
  assert.equal(retryAfterMs(new Headers()), undefined);
});

test("jitteredBackoffMs grows exponentially, jitters within half its ceiling, and stays bounded", () => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ceiling = Math.min(8_000, 500 * 2 ** (attempt - 1));
    for (let i = 0; i < 20; i++) {
      const d = jitteredBackoffMs(attempt);
      assert.ok(d >= ceiling / 2 && d <= ceiling, `attempt ${attempt}: ${d} within [${ceiling / 2}, ${ceiling}]`);
    }
  }
  assert.ok(jitteredBackoffMs(3, { baseDelayMs: 10, maxDelayMs: 25 }) <= 25);
});

const fast = { baseDelayMs: 1, maxDelayMs: 2 };
const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response(`status ${status}`, { status, headers });

test("fetchWithRetry retries 429 and 5xx on idempotent requests, honoring Retry-After", async () => {
  const statuses = [429, 503, 502, 200];
  let calls = 0;
  const t0 = Date.now();
  const res = await fetchWithRetry(
    async () => reply(statuses[calls++]!, calls === 1 ? { "retry-after": "0" } : {}),
    "idempotent",
    fast,
  );
  assert.equal(res.status, 200);
  assert.equal(calls, 4);
  assert.ok(Date.now() - t0 < 1_000);
});

test("fetchWithRetry returns the last transient response once attempts are exhausted", async () => {
  let calls = 0;
  const res = await fetchWithRetry(
    async () => {
      calls++;
      return reply(429, { "retry-after": "0", "x-request-id": `req-${calls}` });
    },
    "idempotent",
    { ...fast, attempts: 3 },
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-request-id"), "req-3");
  assert.equal(calls, 3);
});

test("fetchWithRetry never retries client errors or successes", async () => {
  for (const status of [200, 400, 404, 409, 422]) {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls++;
        return reply(status);
      },
      "idempotent",
      fast,
    );
    assert.equal(res.status, status);
    assert.equal(calls, 1, `status ${status} is returned to the caller untouched`);
  }
});

test("fetchWithRetry retries connection failures only for idempotent requests, never aborts", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return reply(200);
  };
  assert.equal((await fetchWithRetry(flaky, "idempotent", fast)).status, 200);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(fetchWithRetry(flaky, "refused", fast), /fetch failed/);
  assert.equal(calls, 1);

  calls = 0;
  const aborted = async () => {
    calls++;
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  await assert.rejects(fetchWithRetry(aborted, "idempotent", fast), { name: "TimeoutError" });
  assert.equal(calls, 1);
});

test("fetchWithRetry retries throttling but never infers refusal from a server error", async () => {
  for (const [status, expectedCalls] of [
    [429, 2],
    [503, 1],
    [500, 1],
    [502, 1],
    [504, 1],
  ] as const) {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls++;
        return reply(calls === 1 ? status : 201, { "retry-after": "0" });
      },
      "refused",
      fast,
    );
    assert.equal(calls, expectedCalls, `status ${status}`);
    assert.equal(res.status, expectedCalls === 2 ? 201 : status);
  }
});

test("fetchWithRetry cancellation interrupts Retry-After without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchWithRetry(
    async () => {
      calls++;
      return reply(429, { "retry-after": "30" });
    },
    "idempotent",
    { signal: controller.signal },
  );
  const timeout = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(calls, 1);
  } finally {
    clearTimeout(timeout);
  }
});

test("fetchWithRetry shares a deadline across attempts and backoff", async () => {
  const signals: AbortSignal[] = [];
  await assert.rejects(
    fetchWithRetry(
      async (signal) => {
        signals.push(signal);
        if (signals.length === 1) return reply(503, { "retry-after": "0" });
        return new Promise<Response>((resolve) => setTimeout(() => resolve(reply(200)), 100));
      },
      "idempotent",
      { timeoutMs: 30 },
    ),
    { name: "TimeoutError" },
  );
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, true);
});
