import { test } from "node:test";
import assert from "node:assert/strict";
import { errMessage } from "../src/util/errors.ts";

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
