import assert from "node:assert/strict";
import { test } from "node:test";
import { instanceUrl, externalUrl, browserLoginUrl, loginDestination } from "../url.mjs";

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

test("desktop login preserves same-origin return destinations", () => {
  const instance = "https://qm.example.com/s/current";
  const drop = "/drop/example/form?t=test-token&other=value";
  const login = `https://qm.example.com/auth/login?returnTo=${encodeURIComponent(drop)}`;
  assert.equal(loginDestination(login, instance), `https://qm.example.com${drop}`);
  assert.equal(
    loginDestination(login.replace("/auth/login", "/auth/trusted/login"), instance),
    `https://qm.example.com${drop}`,
  );
  assert.equal(loginDestination("https://qm.example.com/auth/login", instance), instance);
  assert.equal(
    loginDestination("https://qm.example.com/auth/login", "https://qm.example.com/auth/login"),
    "https://qm.example.com/",
  );
});

test("desktop login never resumes off-origin, credential-bearing or auth destinations", () => {
  const instance = "https://qm.example.com/s/current";
  for (const target of [
    "https://evil.example/drop",
    "//evil.example/drop",
    "https://user:pass@qm.example.com/drop",
    "javascript:alert(1)",
    "file:///tmp/key",
    "/auth/login",
    "/auth/desktop/redeem",
  ]) {
    assert.equal(
      loginDestination(`https://qm.example.com/auth/login?returnTo=${encodeURIComponent(target)}`, instance),
      instance,
    );
  }
  assert.equal(loginDestination("https://evil.example/auth/login?returnTo=/drop/example", instance), instance);
});

test("initial blank or failed pages cannot change the trusted instance origin", () => {
  const instance = "https://qm.example.com/";
  const login = "https://qm.example.com/auth/login?returnTo=%2Fdrop%2Ftest%2Fform";
  for (const current of ["", "about:blank", "chrome-error://chromewebdata/", "https://other.example/page"]) {
    assert.equal(loginDestination(login, instance, current), "https://qm.example.com/drop/test/form");
    assert.equal(loginDestination("https://qm.example.com/auth/login", instance, current), instance);
  }
  assert.equal(
    loginDestination("https://qm.example.com/auth/login", instance, "https://qm.example.com/s/current"),
    "https://qm.example.com/s/current",
  );
});
