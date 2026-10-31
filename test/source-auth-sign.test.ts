import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canonicalPayload, signRequest, signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { tenantStore, withTenant as withChassisTenant } from "../plugins/chassis/src/tenant.ts";
import { signRequest as legacySignRequest } from "../src/auth/source-auth.ts";
import { OTHER_TENANT, TENANT_HEADERS, TEST_TENANT } from "./support/tenant.ts";

test("canonicalPayload binds method + path + tenant + body with newlines", () => {
  assert.equal(canonicalPayload("POST", "/v1/turns?x=1", "{}", TEST_TENANT), `POST\n/v1/turns?x=1\n${TEST_TENANT}\n{}`);
  assert.equal(canonicalPayload("POST", "/v1/turns?x=1", "{}"), "POST\n/v1/turns?x=1\n\n{}");
});

test("signRequest matches a hand-rolled v0= HMAC over v0:<ts>:<canonical>", () => {
  const canonical = canonicalPayload("POST", "/v1/system/probe", "{}", TEST_TENANT);
  const expected = `v0=${createHmac("sha256", "s").update(`v0:1000:POST\n/v1/system/probe\n${TEST_TENANT}\n{}`).digest("hex")}`;
  assert.equal(signRequest("s", 1000, canonical), expected);
});

test("source-auth.signRequest delegates to the single-sourced HMAC", () => {
  const body = "v0:slack:body";
  assert.equal(legacySignRequest("k", 42, body), signRequest("k", 42, body));
});

test("signedRequestHeaders: no secret → just the base; secret → x-timestamp + x-signature", () =>
  tenantStore.exit(() => {
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
    assert.equal(headers["x-qm-tenant"], undefined);
  }));

test("signedRequestHeaders signs and sends the tenant from the base headers or the bound chassis tenant", () => {
  const fromBase = signedRequestHeaders("s", "GET", "/p", "", { ...TENANT_HEADERS }, 1000);
  assert.equal(fromBase["x-qm-tenant"], TEST_TENANT);
  assert.equal(fromBase["x-signature"], signRequest("s", 1000, canonicalPayload("GET", "/p", "", TEST_TENANT)));

  const fromBound = withChassisTenant(OTHER_TENANT, () => signedRequestHeaders("s", "GET", "/p", "", {}, 1000));
  assert.equal(fromBound["x-qm-tenant"], OTHER_TENANT);
  assert.equal(fromBound["x-signature"], signRequest("s", 1000, canonicalPayload("GET", "/p", "", OTHER_TENANT)));
  assert.notEqual(fromBase["x-signature"], fromBound["x-signature"], "a signature does not transfer between tenants");

  const unsignedBound = withChassisTenant(OTHER_TENANT, () => signedRequestHeaders(undefined, "GET", "/p"));
  assert.deepEqual(unsignedBound, { "x-qm-tenant": OTHER_TENANT });
});
