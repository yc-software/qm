import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const seen: Array<{ url: string; method: string; headers: Record<string, unknown>; body: string }> = [];
const broker = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({
      url: req.url ?? "",
      method: req.method ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (req.url?.startsWith("/verify")) {
      res.writeHead(302, { location: "https://portal.test/auth/callback?code=c&state=s" });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<form>broker</form>");
  });
});
await new Promise<void>((r) => broker.listen(0, "127.0.0.1", r));
const brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;

const surface = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ surface: req.url }));
});
await new Promise<void>((r) => surface.listen(0, "127.0.0.1", r));
const surfaceUrl = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;

const PUBLIC = "http://portal.test";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "broker-proxy-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "broker-proxy-test-core-secret";
process.env.CORE_ORG_ID = "acme";
process.env.WEB_UI_UPSTREAM = surfaceUrl;
process.env.ADMIN_UPSTREAM = surfaceUrl;
process.env.CORE_API_URL = surfaceUrl;
process.env.AUTH_BROKER_UPSTREAM = brokerUrl;

const { server, brokerRouteFor, clientIpOf, isPrivateNetworkUrl } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  broker.close();
  surface.close();
});

test("the broker's sign-in pages are reachable without a session", async () => {
  const page = await fetch(`${base}/idp/authorize?client_id=qm-portal&state=s`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<form>broker</form>");
  assert.equal(
    seen.at(-1)!.url,
    "/authorize?client_id=qm-portal&state=s",
    "the /idp prefix is stripped before the broker sees it",
  );
});

test("the verify redirect is relayed back to the browser", async () => {
  const redirect = await fetch(`${base}/idp/verify?token=abc`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://portal.test/auth/callback?code=c&state=s");
});

test("the submit form posts through, same-origin only", async () => {
  const posted = await fetch(`${base}/idp/authorize`, {
    method: "POST",
    headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" },
    body: "email=admin%40example.com&request=tok",
  });
  assert.equal(posted.status, 200);
  assert.equal(seen.at(-1)!.body, "email=admin%40example.com&request=tok");

  const crossOrigin = await fetch(`${base}/idp/authorize`, {
    method: "POST",
    headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
    body: "email=admin%40example.com",
  });
  assert.equal(crossOrigin.status, 403);
});

test("a same-origin form POST is accepted even though no-referrer makes the browser send Origin: null", async () => {
  const post = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${base}/idp/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: "email=admin%40example.com&request=tok",
    });
  assert.equal((await post({ origin: "null", "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal(
    (await post({ origin: "null" })).status,
    403,
    "without the fetch-metadata proof a null origin is still refused",
  );
  assert.equal(
    (await post({ origin: PUBLIC, "sec-fetch-site": "cross-site" })).status,
    403,
    "fetch metadata overrides a forged Origin",
  );
  assert.equal((await post({ "sec-fetch-site": "same-site" })).status, 403);
});

test("the portal stamps the client address and refuses to relay a spoofed one", async () => {
  await fetch(`${base}/idp/authorize?x=1`, { headers: { "x-qm-client-ip": "9.9.9.9" } });
  const relayed = seen.at(-1)!.headers["x-qm-client-ip"];
  assert.notEqual(relayed, "9.9.9.9", "a client-supplied address must never become the rate-limit key");
  assert.equal(typeof relayed, "string");

  await fetch(`${base}/idp/authorize?x=2`, { headers: { "fly-client-ip": "203.0.113.7" } });
  assert.notEqual(
    seen.at(-1)!.headers["x-qm-client-ip"],
    "203.0.113.7",
    "this portal is not on Fly, so the Fly edge header is just another client-settable header",
  );
});

test("only the browser-facing broker routes are exposed", async () => {
  for (const path of ["/idp/token", "/idp/userinfo", "/idp/.well-known/jwks.json", "/idp/healthz"]) {
    const before = seen.length;
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(seen.length, before, `${path} must not reach the broker`);
    assert.notEqual(response.status, 200, path);
  }
  for (const method of ["PUT", "DELETE"]) {
    const before = seen.length;
    await fetch(`${base}/idp/verify`, { method, headers: { origin: PUBLIC } });
    assert.equal(seen.length, before, `${method} /idp/verify must not reach the broker`);
  }
});

test("confirming a sign-in posts through, same-origin only", async () => {
  const confirmed = await fetch(`${base}/idp/verify`, {
    method: "POST",
    headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" },
    body: "token=abc",
    redirect: "manual",
  });
  assert.equal(confirmed.status, 302);
  assert.equal(seen.at(-1)!.url, "/verify");
  assert.equal(seen.at(-1)!.body, "token=abc");

  const scanner = await fetch(`${base}/idp/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "token=abc",
  });
  assert.equal(scanner.status, 403, "a mail scanner replaying the form has neither Origin nor fetch metadata");
});

test("brokerRouteFor matches only the exact public routes", () => {
  assert.equal(brokerRouteFor("GET", "/idp/authorize"), "/authorize");
  assert.equal(brokerRouteFor("POST", "/idp/authorize"), "/authorize");
  assert.equal(brokerRouteFor("GET", "/idp/verify"), "/verify");
  for (const path of ["/idp/authorize/extra", "/idpauthorize", "/idp/", "/idp", "/idp/token", "/authorize"]) {
    assert.equal(brokerRouteFor("GET", path), null, path);
  }
  assert.equal(brokerRouteFor("DELETE", "/idp/authorize"), null);
});

test("clientIpOf ignores a Fly edge header when the portal is not running on Fly", () => {
  const fake = (headers: Record<string, string>): IncomingMessage =>
    ({ headers, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;
  assert.equal(
    clientIpOf(fake({ "fly-client-ip": "1.2.3.4" })),
    "10.0.0.1",
    "off Fly, fly-client-ip is just a header any client can set",
  );
  assert.equal(
    clientIpOf(fake({ "x-forwarded-for": "9.9.9.9" })),
    "10.0.0.1",
    "with no configured trusted proxy the socket address is the only identity a client cannot forge",
  );
  assert.equal(clientIpOf(fake({})), "10.0.0.1");
});

test("isPrivateNetworkUrl admits only unroutable hosts", () => {
  for (const url of [
    "http://qm-auth.internal:8080",
    "http://qm-web-ui.flycast",
    "http://localhost:8099",
    "http://127.0.0.1:8099",
    "http://10.1.2.3:8080",
    "http://172.16.5.4:8080",
    "http://192.168.1.9:8080",
    "http://[fdaa:0:1::3]:8080",
    "http://[::1]:8080",
  ]) {
    assert.equal(isPrivateNetworkUrl(url), true, url);
  }
  for (const url of [
    "http://accounts.google.com",
    "https://slack.com",
    "http://172.32.0.1",
    "http://11.0.0.1",
    "http://internal.example.com",
    "http://evil.test/.internal",
    "not-a-url",
    "file:///etc/passwd",
  ]) {
    assert.equal(isPrivateNetworkUrl(url), false, url);
  }
});
