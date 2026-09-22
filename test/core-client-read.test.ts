import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchCoreText } from "../plugins/chassis/src/core-client.ts";

for (const retrySafeRead of [true, false]) {
  test(`body interruption retries only opted-in reads: ${retrySafeRead}`, async (t) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      if (paths.length === 1) {
        res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
        res.write("partial");
        setTimeout(() => res.destroy(), 10);
      } else res.end("complete");
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = fetchCoreText({
      origin: `http://127.0.0.1:${address.port}`,
      secret: "test-secret",
      method: "GET",
      path: "/v1/sessions/test?sinceSeq=825",
      retrySafeRead,
    });
    if (retrySafeRead) {
      assert.deepEqual(await result, { status: 200, text: "complete" });
      assert.equal(paths.length, 2);
      assert.notEqual(
        new URL(paths[0]!, "http://core").searchParams.get("_sourceAuthNonce"),
        new URL(paths[1]!, "http://core").searchParams.get("_sourceAuthNonce"),
      );
    } else {
      await assert.rejects(result);
      assert.equal(paths.length, 1);
    }
  });
}

test("safe read budget stops after two transport failures", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  });
  await assert.rejects(fetchCoreText({ origin: "http://core", method: "GET", path: "/test", retrySafeRead: true }));
  assert.equal(attempts, 2);
});

test("cancellation prevents replay", async (t) => {
  const cancel = new AbortController();
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    cancel.abort();
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  });
  await assert.rejects(
    fetchCoreText({ origin: "http://core", method: "GET", path: "/test", retrySafeRead: true, signal: cancel.signal }),
  );
  assert.equal(attempts, 1);
});

test("application errors do not replay and writes cannot opt in", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    return new Response("denied", { status: 403 });
  });
  assert.equal(
    (await fetchCoreText({ origin: "http://core", method: "GET", path: "/test", retrySafeRead: true })).status,
    403,
  );
  await assert.rejects(
    fetchCoreText({ origin: "http://core", method: "POST", path: "/test", retrySafeRead: true }),
    /bodyless GET/,
  );
  assert.equal(attempts, 1);
});

test("an interrupted error response does not replay", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(
            new TypeError("terminated", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
          );
        },
      }),
      { status: 403 },
    );
  });
  await assert.rejects(fetchCoreText({ origin: "http://core", method: "GET", path: "/test", retrySafeRead: true }));
  assert.equal(attempts, 1);
});

test("the original deadline aborts body collection on the second attempt", async (t) => {
  let attempts = 0;
  const signal = AbortSignal.timeout(50);
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    attempts++;
    assert.equal(options.signal, signal);
    if (attempts === 1)
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
    );
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(
      fetchCoreText({ origin: "http://core", method: "GET", path: "/test", retrySafeRead: true, signal }),
      /timeout/i,
    );
    assert.equal(attempts, 2);
  } finally {
    clearTimeout(keepAlive);
  }
});
