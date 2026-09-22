import assert from "node:assert/strict";
import { test } from "node:test";
import { instanceUrl, externalUrl, browserLoginUrl } from "../url.mjs";

test("accepts secure deployments and explicit loopback development URLs", () => {
  for (const url of [
    "https://qm.example.com/chat",
    "http://localhost:3000/",
    "http://127.0.0.1:4000/",
    "http://[::1]:3000/",
  ]) {
    assert.equal(instanceUrl(url), url);
  }
});

test("rejects insecure remote servers, credentials, and privileged protocols", () => {
  for (const url of [
    "http://qm.example.com",
    "https://user:secret@qm.example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "http://localhost.evil.com",
    "qm.example.com",
  ]) {
    assert.throws(() => instanceUrl(url));
  }
});

test("external links cannot launch local files or arbitrary protocol handlers", () => {
  for (const url of ["https://example.com/path", "http://localhost:3000", "mailto:hello@example.com"])
    assert.equal(externalUrl(url), true);
  for (const url of [
    "file:///tmp/script.sh",
    "javascript:alert(1)",
    "vscode://file/tmp/foo",
    "https://user:pass@example.com",
    "invalid",
  ])
    assert.equal(externalUrl(url), false);
});

test("browser sign-in only intercepts exact same-origin auth route families", () => {
  const origin = "https://qm.example.com";
  for (const route of ["/auth/login", "/auth/login?returnTo=/", "/auth/trusted/login", "/auth/trusted/login/start"])
    assert.equal(browserLoginUrl(origin + route, origin), true);
  for (const value of [
    "https://other.example/auth/login",
    origin + "/auth/login-lookalike",
    origin + "/auth/trusted/login-other",
    origin + "/chat",
  ])
    assert.equal(browserLoginUrl(value, origin), false);
});
