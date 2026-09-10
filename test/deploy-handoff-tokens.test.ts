import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mintAppSession, verifyAppSession, safeAppPath } from "../src/deploy/app-session.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";

const secret = "synthetic-hardening-key";
const audience = { orgId: "acme", deploymentId: "immutable", origin: "https://immutable.apps.test" };
const now = 100_000;
const common = { ...audience, iat: now, exp: now + 60_000 };
const request = { ...common, type: "request" as const, sourceOrigin: "https://qm.test", path: "/deep?owner=app&x=%20" };
const challenge = { ...request, type: "challenge" as const, nonce: "a".repeat(43) };
const launch = { ...challenge, type: "launch" as const, sub: "viewer", jti: "b".repeat(43) };
const session = { ...common, type: "session" as const, sub: "viewer" };

test("handoff tokens have separate purposes/keys and bind org, immutable app, exact origin and finite bounded lifetime", async () => {
  for (const claims of [request, challenge, launch, session]) {
    const token = await mintAppSession(secret, claims);
    assert.ok(await verifyAppSession(secret, token, claims.type, audience, now));
    for (const other of [request, challenge, launch, session]) {
      if (other.type !== claims.type)
        assert.equal(await verifyAppSession(secret, token, other.type, audience, now), null);
    }
    for (const wrong of [
      { ...audience, orgId: "other" },
      { ...audience, deploymentId: "reused" },
      { ...audience, origin: "http://immutable.apps.test" },
      { ...audience, origin: audience.origin + ":444" },
    ]) {
      assert.equal(await verifyAppSession(secret, token, claims.type, wrong, now), null);
    }
    assert.equal(await verifyAppSession("other-key", token, claims.type, audience, now), null);
    for (const overrides of [
      { iat: now + 1 },
      { iat: undefined },
      { iat: Infinity },
      { exp: Infinity },
      { exp: "200000" },
      { exp: now },
      { exp: now + 8 * 3600_000 + 1 },
    ]) {
      const bad = await mintAppSession(secret, { ...claims, ...overrides } as typeof claims);
      assert.equal(await verifyAppSession(secret, bad, claims.type, audience, now), null);
    }
  }
});

test("pending requests cannot carry actor authority; challenge/callback require random nonce and callback replay id", async () => {
  for (const claims of [
    { ...request, sub: "issuer" },
    { ...challenge, nonce: "" },
    { ...launch, jti: "" },
    { ...launch, nonce: "short" },
    { ...launch, sub: " " },
    { ...request, sourceOrigin: "https://qm.test/path" },
    { ...request, path: "//evil.test" },
    { ...request, exp: now + 60_001 },
  ]) {
    const token = await mintAppSession(secret, claims);
    assert.equal(await verifyAppSession(secret, token, claims.type, audience, now), null);
  }
  const wrongKey = createHmac("sha256", secret).update("qm.deployment.session.v1").digest("base64url");
  const bad = await mintSignedPayload({ ...launch, version: 1 }, wrongKey);
  assert.equal(await verifyAppSession(secret, bad, "launch", audience, now), null);
});

test("return paths reject multi-encoded traversal, protocol-relative, backslash, controls and gateway namespace", () => {
  for (const path of ["//evil", "/%2fhost", "/%255chost", "/a/../b", "/%252e%252e/b", "/a/./b", "/a\n", "/a#hash"])
    assert.equal(safeAppPath(path), false, path);
  for (const path of ["/", "/deep?owner=x&access=a%20b&dpl_signin=1", "/path?q=https://example.test/a/../b"])
    assert.equal(safeAppPath(path), true, path);
});
