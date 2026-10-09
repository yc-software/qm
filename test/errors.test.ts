import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asError,
  errMessage,
  errorAlreadyReported,
  failureCode,
  reportFailure,
  swallow,
  swallowAs,
  httpFailure,
  withRequestId,
} from "../src/util/errors.ts";
import { WorkAdmissionClosed } from "../src/util/admitted-work.ts";
import { errDetail, errMessage as pluginErrMessage } from "../plugins/chassis/src/errors.ts";
import { runInNewContext } from "node:vm";

test("errMessage keeps the cause chain that fetch failures hide behind their generic message", () => {
  const socket = Object.assign(new Error(""), { name: "Error", code: "ETIMEDOUT" });
  const connect = Object.assign(new Error("Connect Timeout Error (attempted addresses: 1.2.3.4:443)"), {
    name: "ConnectTimeoutError",
    code: "UND_ERR_CONNECT_TIMEOUT",
    cause: socket,
  });
  const fetchFailed = new TypeError("fetch failed", { cause: connect });
  assert.equal(
    errMessage(fetchFailed),
    "fetch failed <- ConnectTimeoutError UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted addresses: 1.2.3.4:443) <- Error ETIMEDOUT",
  );
});

test("errMessage is unchanged for plain errors and non-errors", () => {
  assert.equal(errMessage(new Error("plain")), "plain");
  assert.equal(errMessage("text"), "text");
  assert.equal(errMessage(42), "42");
});

test("errMessage tolerates non-error and cyclic causes", () => {
  assert.equal(errMessage(new Error("outer", { cause: "inner string" })), "outer <- inner string");
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  assert.equal(errMessage(a), "a <- Error: b");
});

test("errMessage does not echo a cause whose message the wrapper already carries", () => {
  const raw = new Error("git clone failed: exit 128");
  assert.equal(errMessage(new Error(raw.message, { cause: raw })), "git clone failed: exit 128");
  assert.equal(
    errMessage(new Error("outer", { cause: new Error("git clone failed: exit 128", { cause: raw }) })),
    "outer <- Error: git clone failed: exit 128",
  );
});

test("a short cause message is not mistaken for an echo", () => {
  const cause = Object.assign(new Error("fetch"), { code: "ECONNRESET" });
  assert.equal(errMessage(new Error("fetch failed", { cause })), "fetch failed <- Error ECONNRESET: fetch");
});

for (const [name, message] of [
  ["core", errMessage],
  ["plugin", pluginErrMessage],
] as const) {
  test(`${name} errors preserve useful messages without stringifying thrown objects`, () => {
    const exposed = {
      toString: () => {
        assert.fail("object stringification must not run");
      },
    };
    assert.equal(message(exposed), "Unknown error");
    assert.equal(message({ ...exposed, message: "actionable validation error" }), "actionable validation error");
    assert.equal(message(runInNewContext('new Error("cross-realm validation error")')), "cross-realm validation error");
    assert.equal(message(new Error("normal validation error")), "normal validation error");
    assert.equal(message("plain thrown string"), "plain thrown string");
    assert.equal(message(42), "42");
  });
}

test("error causes cannot expose a custom object stack through stringification", () => {
  const cause = { toString: () => "Error: internal failure\n    at /private/server.ts:123:4" };
  assert.equal(errMessage(new Error("operation failed", { cause })), "operation failed <- Unknown error");
});

test("asError preserves cross-realm messages without invoking custom stringifiers", () => {
  const original = new Error("original");
  assert.equal(asError(original), original);
  assert.equal(asError(runInNewContext('new Error("cross-realm")')).message, "cross-realm");
  assert.equal(
    asError({ toString: () => assert.fail("object stringification must not run") }).message,
    "Unknown error",
  );
});

test("failureCode turns a static context into a Sentry-safe grouping code", () => {
  assert.equal(failureCode("scheduler: fire"), "scheduler:fire");
  assert.equal(
    failureCode("web delivery: transcript write gave up (delivering as a nudge only)"),
    "web_delivery:transcript_write_gave_up_delivering_as_a_nudge_only",
  );
  assert.equal(failureCode("x".repeat(200)).length, 120);
  assert.match(failureCode("Ünïcode / spaces"), /^[a-z0-9_.:-]+$/);
});

test("reportFailure logs every failure but marks only reportable ones as reported", (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const cancelled = new DOMException("stopped", "AbortError");
  reportFailure("scheduler: fire", cancelled);
  assert.equal(errorAlreadyReported(cancelled), false, "cancellations are logged, never reported");
  const closed = new WorkAdmissionClosed();
  reportFailure("scheduler: tick", closed);
  assert.equal(errorAlreadyReported(closed), false, "admission closed during handoff is logged, never reported");
  const boom = new Error("boom");
  reportFailure("scheduler: fire", boom);
  assert.equal(errorAlreadyReported(boom), true);
  reportFailure("worker: retry", "a string throw", "run=r1");
  assert.deepEqual(
    logged.map((line) => line.replace(/ \{stack: .*\}$/, "")),
    [
      "[failed] scheduler: fire: stopped",
      "[failed] scheduler: tick: This deployment is not accepting synchronous work",
      "[failed] scheduler: fire: boom",
      "[failed] worker: retry (run=r1): a string throw",
    ],
  );
  assert.match(logged[2]!, /\{stack: at .*errors\.test\.ts/);
});

test("swallow logs the cause chain, structured error fields and stack instead of only the message", (t) => {
  const logged: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const slack = Object.assign(
    new Error("An API error occurred: not_in_channel", { cause: new Error("socket hang up") }),
    {
      code: "slack_webapi_platform_error",
      data: { error: "not_in_channel" },
    },
  );
  swallow("slack: post", slack);
  swallow("http", Object.assign(new Error("upstream failed"), { statusCode: 503 }));
  assert.ok(logged[0]!.includes("code=slack_webapi_platform_error"));
  assert.ok(logged[0]!.includes('data={"error":"not_in_channel"}'));
  assert.ok(logged[0]!.includes("{stack: at "));
  assert.ok(logged[1]!.includes("[statusCode=503]"));
  assert.equal(swallowAs("lookup", false)(new Error("db down")), false);
  assert.match(logged[2]!, /^\[swallowed\] lookup: db down \{stack: /);
});

test("httpFailure names the status, a clipped body, and the provider request id", async () => {
  const res = new Response("x".repeat(300), { status: 502, headers: { "x-request-id": "req-7" } });
  const text = await httpFailure(res);
  assert.match(text, /^http 502 x{200} \[request id req-7\]$/);
  assert.equal(await httpFailure(new Response("plain", { status: 429 })), "http 429 plain");
  assert.equal(
    withRequestId("lambda -> 429: throttled", new Headers({ "x-amzn-requestid": "aws-1" })),
    "lambda -> 429: throttled [request id aws-1]",
  );
  assert.equal(withRequestId("fine", new Headers()), "fine");
});

test("errDetail preserves browser frames, nested stacks and aggregate errors without cycles", () => {
  const provision = new Error("provision");
  provision.stack = "Error: provision\ninitialize@https://example.com/app.js:1:2";
  const cleanup = new Error("cleanup", { cause: provision });
  const error = new AggregateError([provision, cleanup], "both", { cause: cleanup });
  provision.cause = error;
  const detail = errDetail(error);
  assert.ok(detail.includes("initialize@https://example.com/app.js:1:2"));
  assert.ok(detail.includes("cleanup"));
  assert.equal(detail.split("initialize@").length, 2);
});

test("error fields tolerate circular data, bigint, failing serializers and malformed aggregate errors", () => {
  const body: Record<string, unknown> = { count: 1n };
  body.self = body;
  const error = Object.assign(new AggregateError([], "failure"), {
    stderr: "failed",
    body,
    broken: {
      toJSON() {
        throw new Error("serializer failed");
      },
    },
  });
  Reflect.set(error, "errors", null);
  const detail = errDetail(error);
  assert.ok(detail.includes("stderr=failed"));
  assert.ok(detail.includes('"count":"1"'));
  assert.ok(detail.includes("[Circular]"));
  assert.ok(detail.includes("broken=[Unserializable]"));
  assert.equal(asError(body).cause, body);
});

test("field enumeration failures preserve the message and stack", () => {
  const error = Object.assign(new Error("failure"), { cause: new Error("root") });
  assert.ok(!errDetail(error).includes("cause="));
  Object.defineProperty(error, "stack", { value: "Error: failure\n    at test.ts:1:1" });
  const hostile = new Proxy(error, {
    ownKeys() {
      throw new Error("enumeration failed");
    },
  });
  assert.equal(errDetail(hostile), errDetail(error));
});
