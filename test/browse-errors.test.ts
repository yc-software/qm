import assert from "node:assert/strict";
import { test } from "node:test";
const { formatBrowserError } = await import(
  new URL("../skills-seed/browse/scripts/browser-errors.mjs", import.meta.url).href
);

test("browser errors retain nested causes, aggregate failures and status evidence", () => {
  const socket = Object.assign(new Error("connection failed"), { code: "ECONNREFUSED" });
  const handshake = Object.assign(new Error("handshake failed", { cause: socket }), { status: 502 });
  const result = formatBrowserError(new AggregateError([handshake, new Error("cleanup failed")], "startup failed"));
  for (const evidence of ["startup failed", "handshake failed", "ECONNREFUSED", "502", "cleanup failed"])
    assert.ok(result.includes(evidence), evidence);
});

test("browser errors redact known endpoints, keys and proxy credentials throughout causes", () => {
  const endpoint = "wss://session-secret.example.test/path-secret?token=query-secret";
  const proxy = "https://user:password-secret@proxy.example.test:8443/";
  const key = "api-key-secret";
  const inner = new Error(
    `${endpoint} session-secret.example.test ${key} ${Buffer.from("user:password-secret").toString("base64")}`,
  );
  const result = formatBrowserError(new Error(`EAI_AGAIN ${proxy} password-secret`, { cause: inner }), [
    endpoint,
    proxy,
    key,
  ]);
  for (const secret of [
    "session-secret",
    "path-secret",
    "query-secret",
    key,
    "password-secret",
    Buffer.from("user:password-secret").toString("base64"),
  ])
    assert.ok(!result.includes(secret), secret);
  assert.ok(result.includes("EAI_AGAIN"));
});

test("browser error formatting preserves thrown primitives and does not invoke inspection hooks", () => {
  assert.equal(formatBrowserError(null), "null");
  assert.equal(formatBrowserError(undefined), "undefined");
  assert.ok(
    formatBrowserError({
      message: "detail",
      [Symbol.for("nodejs.util.inspect.custom")]() {
        throw new Error("must not execute");
      },
    }).includes("detail"),
  );
});

test("browser cleanup preserves the primary failure and attempts every release", async () => {
  const { withBrowserCleanup } = await import(
    new URL("../skills-seed/browse/scripts/browser-errors.mjs", import.meta.url).href
  );
  const primary = new Error("transfer failed");
  const release = new Error("release failed");
  let closed = false;
  await assert.rejects(
    withBrowserCleanup(
      async () => {
        throw primary;
      },
      async () => {
        throw release;
      },
      async () => {
        closed = true;
      },
    ),
    (error: AggregateError) => {
      assert.deepEqual(error.errors, [primary, release]);
      return true;
    },
  );
  assert.equal(closed, true);
  await assert.rejects(
    withBrowserCleanup(
      async () => 42,
      async () => {
        throw release;
      },
    ),
    (error: Error) => error === release,
  );
  assert.equal(
    await withBrowserCleanup(
      async () => 42,
      async () => {},
    ),
    42,
  );
});
