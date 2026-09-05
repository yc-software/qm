import assert from "node:assert/strict";
import test from "node:test";
import { adminLoginUrl } from "../cli/src/commands/admin-login.ts";
import { openAdminLogin } from "../plugins/portal/src/admin-login.ts";
import { deriveKey, seal } from "../plugins/portal/src/session.ts";

const secret = "admin-login-contract-test-secret-32-characters";
const publicUrl = "https://qm.example.com";

function cliToken() {
  const url = new URL(adminLoginUrl({ publicUrl, secret, adminGrants: "admin@example.com:org_admin" }));
  return new URLSearchParams(url.hash.slice(1)).get("token")!;
}

test("the published CLI token format is accepted by the portal", () => {
  const token = cliToken();
  const claims = openAdminLogin(token, secret, publicUrl);
  assert.ok(claims);
  assert.equal(claims.email, "admin@example.com");
  assert.ok(claims.expiresAtMs > Date.now());
  assert.ok(claims.expiresAtMs <= Date.now() + 300_000);
  assert.equal(openAdminLogin(token, `${secret}-other`, publicUrl), null);
  assert.equal(openAdminLogin(token, secret, "https://another.example.com"), null);
  assert.equal(openAdminLogin(token, secret, publicUrl, claims.expiresAtMs), null);
  assert.equal(openAdminLogin(token, secret, publicUrl, Date.now() - 60_000), null);
});

test("admin link validation enforces purpose, lifetime, and principal boundaries", () => {
  const original = JSON.parse(Buffer.from(cliToken().split(".")[0]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
  const key = deriveKey(secret, "portal.admin-login.v1");
  const invalid = [
    { k: "session" },
    { k: "impersonate" },
    { aud: "https://attacker.example.com" },
    { sub: "" },
    { sub: "admin" },
    { sub: "ADMIN@example.com" },
    { sub: "admin@example.com\n" },
    { jti: "" },
    { jti: "../admin" },
    { iat: "1" },
    { exp: null },
    { exp: Number(original.iat) },
    { exp: Number(original.iat) + 301 },
    { iat: Number(original.iat) + 0.5 },
    { exp: Number(original.exp) + 0.5 },
  ];
  for (const changes of invalid) {
    assert.equal(
      openAdminLogin(seal({ ...original, ...changes }, key), secret, publicUrl),
      null,
      JSON.stringify(changes),
    );
  }
  assert.equal(openAdminLogin(seal(original, deriveKey(secret, "portal.session.v1")), secret, publicUrl), null);
  for (const invalidToken of ["", "garbage", `${cliToken()}extra`, "a".repeat(4097)]) {
    assert.equal(openAdminLogin(invalidToken, secret, publicUrl), null);
  }
});
