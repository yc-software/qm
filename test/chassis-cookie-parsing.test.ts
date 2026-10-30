import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { cookie } from "../plugins/chassis/src/http.ts";

function withCookieHeader(header: string | undefined): IncomingMessage {
  return { headers: { cookie: header } } as IncomingMessage;
}

test("cookie() returns null when the cookie header is absent", () => {
  assert.equal(cookie(withCookieHeader(undefined), "session"), null);
});

test("cookie() returns null when the named cookie is missing", () => {
  assert.equal(cookie(withCookieHeader("other=1"), "session"), null);
});

test("cookie() treats an empty value the same as an absent cookie", () => {
  assert.equal(cookie(withCookieHeader("session="), "session"), null);
  assert.equal(cookie(withCookieHeader("session=; other=1"), "session"), null);
});

test("cookie() decodes a valid percent-encoded value round-trip", () => {
  const encoded = encodeURIComponent("alice@example.com has spaces");
  assert.equal(cookie(withCookieHeader(`session=${encoded}`), "session"), "alice@example.com has spaces");
});

test("cookie() does not treat a literal plus sign as an encoded space", () => {
  assert.equal(cookie(withCookieHeader("session=a+b"), "session"), "a+b");
});

test("cookie() tolerates arbitrary whitespace between entries", () => {
  assert.equal(cookie(withCookieHeader("other=1;   session=value"), "session"), "value");
});

test("cookie() returns null instead of throwing on malformed percent-encoding", () => {
  assert.doesNotThrow(() => cookie(withCookieHeader("session=%"), "session"));
  assert.equal(cookie(withCookieHeader("session=%"), "session"), null);
  assert.equal(cookie(withCookieHeader("session=%E0%A4%A"), "session"), null);
});

test("cookie() returns null instead of throwing on malformed bytes even when the value is not the requested cookie", () => {
  assert.doesNotThrow(() => cookie(withCookieHeader("unrelated=%; session=value"), "session"));
  assert.equal(cookie(withCookieHeader("unrelated=%"), "unrelated"), null);
});

test("cookie() skips a malformed duplicate and returns the next usable duplicate", () => {
  assert.equal(cookie(withCookieHeader("session=%; session=valid"), "session"), "valid");
});

test("cookie() prefers the first usable value when every duplicate is valid", () => {
  assert.equal(cookie(withCookieHeader("session=first; session=second"), "session"), "first");
});

test("cookie() returns null when every duplicate is malformed", () => {
  assert.equal(cookie(withCookieHeader("session=%; session=%E0%A4%A"), "session"), null);
});

test("cookie() treats the cookie name literally, not as a regular expression", () => {
  assert.equal(cookie(withCookieHeader("aXb=wrong; a.b=right"), "a.b"), "right");
  assert.equal(cookie(withCookieHeader("aXb=wrong"), "a.b"), null);
});
