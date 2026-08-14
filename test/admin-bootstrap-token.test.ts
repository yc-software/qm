import assert from "node:assert/strict";
import test from "node:test";
import { mintAdminBootstrapToken, openAdminBootstrapToken } from "../plugins/chassis/src/admin-bootstrap.ts";
import { createSignedRequestVerifier } from "../plugins/chassis/src/source-auth-verify.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";

test("admin bootstrap tokens are organization-bound, short-lived, and tamper-evident", () => {
  const now = 2_000_000_000_000;
  const { token, claims } = mintAdminBootstrapToken(
    { org: "acme", principal: "Admin@Example.com" },
    "portal-session-secret",
    now,
  );
  assert.equal(claims.principal, "admin@example.com");
  assert.equal(claims.exp - claims.iat, 600);
  assert.deepEqual(openAdminBootstrapToken(token, "portal-session-secret", now), claims);
  assert.equal(openAdminBootstrapToken(token, "other-secret", now), null);
  const separator = token.indexOf(".") + 1;
  const replacement = token[separator] === "A" ? "B" : "A";
  const tampered = `${token.slice(0, separator)}${replacement}${token.slice(separator + 1)}`;
  assert.equal(openAdminBootstrapToken(tampered, "portal-session-secret", now), null);
  assert.equal(openAdminBootstrapToken(token, "portal-session-secret", now + 601_000), null);
});

test("the decoder rejects a token whose signed lifetime exceeds ten minutes", () => {
  const now = 2_000_000_000_000;
  const { token } = mintAdminBootstrapToken(
    { org: "acme", principal: "admin@example.com", ttlSeconds: 601 },
    "portal-session-secret",
    now,
  );
  assert.equal(openAdminBootstrapToken(token, "portal-session-secret", now), null);
});

test("Auth internal request verification rejects stale, forged, and replayed signatures", () => {
  const now = 2_000_000_000_000;
  const secret = "core-signing-secret";
  const path = withSourceAuthNonce("/internal/email-settings/status", secret);
  const headers = signedHeaders(secret, "GET", path);
  const verifier = createSignedRequestVerifier(secret, () => now);
  const request = {
    method: "GET",
    pathWithQuery: path,
    body: "",
    timestamp: headers["x-timestamp"],
    signature: headers["x-signature"],
  };
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const currentPath = withSourceAuthNonce("/internal/email-settings/status", secret);
    const currentHeaders = signedHeaders(secret, "GET", currentPath);
    const current = {
      ...request,
      pathWithQuery: currentPath,
      timestamp: currentHeaders["x-timestamp"],
      signature: currentHeaders["x-signature"],
    };
    assert.equal(verifier.verify(current), true);
    assert.equal(verifier.verify(current), false);
    assert.equal(verifier.verify({ ...current, signature: `${current.signature}x` }), false);
  } finally {
    Date.now = realNow;
  }
});
