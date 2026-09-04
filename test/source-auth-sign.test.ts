import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canonicalPayload, signRequest, signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { signRequest as legacySignRequest } from "../src/auth/source-auth.ts";

test("canonicalPayload binds method + path + body with newlines", () => {
  assert.equal(canonicalPayload("POST", "/v1/turns?x=1", "{}"), "POST\n/v1/turns?x=1\n{}");
});

test("signRequest matches a hand-rolled v0= HMAC over v0:<ts>:<canonical>", () => {
  const canonical = canonicalPayload("POST", "/v1/system/probe", "{}");
  const expected = `v0=${createHmac("sha256", "s").update("v0:1000:POST\n/v1/system/probe\n{}").digest("hex")}`;
  assert.equal(signRequest("s", 1000, canonical), expected);
});

test("source-auth.signRequest delegates to the single-sourced HMAC", () => {
  const body = "v0:slack:body";
  assert.equal(legacySignRequest("k", 42, body), signRequest("k", 42, body));
});

test("signedRequestHeaders: no secret → just the base; secret → x-timestamp + x-signature", () => {
  assert.deepEqual(signedRequestHeaders(undefined, "GET", "/p", "", { "content-type": "application/json" }), {
    "content-type": "application/json",
  });

  const headers = signedRequestHeaders(
    "s",
    "POST",
    "/v1/blobs",
    "deadbeef",
    { "content-type": "application/json" },
    1000,
  );
  assert.equal(headers["x-timestamp"], "1000");
  assert.equal(headers["x-signature"], signRequest("s", 1000, canonicalPayload("POST", "/v1/blobs", "deadbeef")));
  assert.equal(headers["content-type"], "application/json");
});
