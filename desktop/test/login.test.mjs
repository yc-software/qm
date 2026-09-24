import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createLogin, loginCallback } from "../login.mjs";

test("browser login carries only the proof challenge, never its secret", () => {
  const pending = createLogin("https://qm.example.com/s/123", 1000);
  const url = new URL(pending.url);
  assert.equal(url.origin, "https://qm.example.com");
  assert.equal(url.pathname, "/auth/desktop");
  assert.equal(url.searchParams.get("challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.equal(url.href.includes(pending.verifier), false);
  assert.notEqual(createLogin(pending.instance).state, pending.state);
});

test("only a callback for the current unexpired attempt is accepted", () => {
  const pending = createLogin("https://qm.example.com", 1000);
  const callback = `qm-desktop://auth/callback?state=${pending.state}&code=signed-code`;
  assert.equal(loginCallback(callback, pending, 2000), "signed-code");
  assert.equal(loginCallback(callback, pending, pending.expiresAt), null);
  assert.equal(loginCallback(callback, undefined, 2000), null);
  assert.equal(loginCallback(callback, createLogin(pending.instance, 1000), 2000), null);
  for (const invalid of [
    callback.replace("qm-desktop:", "https:"),
    callback.replace("//auth/", "//attacker/"),
    callback.replace("/callback?", "/elsewhere?"),
    `${callback}&state=${pending.state}`,
    `${callback}&code=another`,
    `${callback}#fragment`,
    callback.replace("signed-code", ""),
  ])
    assert.equal(loginCallback(invalid, pending, 2000), null);
});

test("explicit provider choice wraps the proof request without leaking the destination", () => {
  for (const route of ["/auth/trusted/login", "/auth/login?provider=primary"]) {
    const attempt = createLogin("https://qm.example.com/drop/test?t=private", 1000, `https://qm.example.com${route}`);
    const url = new URL(attempt.url);
    const request = new URL(url.searchParams.get("returnTo"), url);
    assert.equal(url.pathname, route.split("?")[0]);
    assert.equal(request.pathname, "/auth/desktop");
    assert.equal(request.searchParams.get("state"), attempt.state);
    assert.equal(attempt.url.includes("private"), false);
    assert.equal(attempt.url.includes(attempt.verifier), false);
  }
  assert.equal(
    new URL(createLogin("https://qm.example.com", 1000, "https://evil.example/auth/trusted/login").url).pathname,
    "/auth/desktop",
  );
});
