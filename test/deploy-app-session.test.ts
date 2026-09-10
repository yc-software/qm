import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  mintAppSession,
  verifyAppSession,
  localAppIngress,
  safeAppPath,
  withoutQueryParameter,
} from "../src/deploy/app-session.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { loadConfig } from "../src/config.ts";

const secret = "test-secret";
const audience = { orgId: "acme", deploymentId: "immutable-id", origin: "https://one.apps.test" };

test("app tokens bind type, exact origin, immutable id, principal and finite expiry with independent keys", async () => {
  const claims = {
    ...audience,
    type: "launch" as const,
    iat: 1000,
    nonce: "a".repeat(43),
    jti: "b".repeat(43),
    sourceOrigin: "https://qm.test",
    sub: "viewer",
    exp: 2000,
    path: "/deep?x=%20&x=+",
  };
  const token = await mintAppSession(secret, claims);
  assert.equal((await verifyAppSession(secret, token, "launch", audience, 1000))?.sub, "viewer");
  for (const other of [
    { ...audience, deploymentId: "replacement-id" },
    { ...audience, origin: "https://two.apps.test" },
    { ...audience, origin: "https://one.apps.test:444" },
    { ...audience, origin: "http://one.apps.test" },
  ]) {
    assert.equal(await verifyAppSession(secret, token, "launch", other, 1000), null);
  }
  assert.equal(await verifyAppSession(secret, token, "session", audience, 1000), null);
  assert.equal(await verifyAppSession(secret, token, "launch", audience, 2000), null);
  assert.equal(await verifyAppSession("other", token, "launch", audience, 1000), null);
  const appKey = createHmac("sha256", secret).update("qm.deployment.session.v1").digest("base64url");
  const wrongKey = await mintSignedPayload({ ...claims, version: 1 }, appKey);
  assert.equal(await verifyAppSession(secret, wrongKey, "launch", audience, 1000), null);
  for (const overrides of [
    { sub: "" },
    { sub: " " },
    { exp: Infinity },
    { exp: "2000" },
    { path: "//evil.test" },
    { path: "/%2fhost" },
    { path: "/%5cevil" },
  ]) {
    const bad = await mintAppSession(secret, { ...claims, ...overrides } as typeof claims);
    assert.equal(await verifyAppSession(secret, bad, "launch", audience, 1000), null);
  }
});

test("transport query stripping removes only the named key, without serializing other bytes", () => {
  assert.equal(
    withoutQueryParameter("?a=%20&_sourceAuthNonce=x&b=+&b=%2f&bare&", "_sourceAuthNonce"),
    "?a=%20&b=+&b=%2f&bare&",
  );
  assert.equal(withoutQueryParameter("?_sourceAuthNonce=x&a=1&_sourceAuthNonce=y", "_sourceAuthNonce"), "?a=1");
  assert.equal(withoutQueryParameter("?%5FsourceAuthNonce=x&%ff=keep", "_sourceAuthNonce"), "?%ff=keep");
  assert.equal(withoutQueryParameter("?_sourceAuthNonce=x", "_sourceAuthNonce"), "");
  for (const path of [
    "/",
    "/path?value=https://example.test#fragment",
    "//evil.test",
    "/%252fhost",
    "/%5cevil",
    "/\r\nhost",
  ]) {
    assert.equal(safeAppPath(path), path === "/");
  }
});

test("local mode requires explicit non-production plus local socket, loopback Host, and actual port", () => {
  function req(host: string, remoteAddress = "127.0.0.1", localAddress = "127.0.0.1") {
    return { headers: { host }, socket: { remoteAddress, localAddress, localPort: 4321 } } as IncomingMessage;
  }
  for (const host of ["localhost:4321", "127.0.0.1:4321", "[::1]:4321", "id.apps.localhost:4321"])
    assert.equal(localAppIngress(req(host), false), true);
  for (const host of [
    "localhost",
    "localhost:1234",
    "evil.test:4321",
    "localhost.evil.test:4321",
    "localhost:4321@evil.test",
    "localhost:4321/path",
    "localhost:4321#x",
  ])
    assert.equal(localAppIngress(req(host), false), false);
  assert.equal(localAppIngress(req("localhost:4321", "198.51.100.3"), false), false);
  assert.equal(localAppIngress(req("localhost:4321", "127.0.0.1", "192.0.2.3"), false), false);
  assert.equal(localAppIngress(req("localhost:4321"), undefined), false);
  assert.equal(localAppIngress(req("localhost:4321"), true), false);
  assert.equal(localAppIngress(req("localhost:4321", "::ffff:127.0.0.1", "::1"), false), true);
});

test("app sign-in URL no longer needs a shared parent-domain portal session secret", () => {
  assert.equal(
    loadConfig({ DEPLOY_APPS_LOGIN_URL: "https://portal.example.test/" }).deployAppsLoginUrl,
    "https://portal.example.test",
  );
  const config = loadConfig({ PUBLIC_WEB_URL: "https://portal.example.test" });
  assert.equal(config.deployAppsLoginUrl, "https://portal.example.test");
  assert.equal(config.deployAppsSessionSecret, undefined);
});
