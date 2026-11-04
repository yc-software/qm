import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const a = randomUUID();
const b = randomUUID();
const hosts: Record<string, string> = { "a.example.test": a, "b.example.test": b };
const clients: Record<string, { clientId: string; clientSecret: string }> = {
  [a]: { clientId: "client-a", clientSecret: "a".repeat(40) },
  [b]: { clientId: "client-b", clientSecret: "b".repeat(40) },
};
const { privateKey, publicKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
const seen: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = [];

const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://core.test").pathname;
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    seen.push({ path, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/v1/operator/hosts/")) {
      const tenant = hosts[decodeURIComponent(path.slice(19))];
      return void res.end(JSON.stringify({ tenant: tenant ?? null, multi: true, sole: false }));
    }
    if (path === "/v1/auth/broker/sign-in-settings") {
      const client = clients[String(req.headers["x-qm-tenant"])];
      return void res.end(JSON.stringify({ oidcClient: { issuer: "https://auth.example.test", ...client } }));
    }
    if (path.endsWith("/email-allowed")) return void res.end(JSON.stringify({ allowed: true }));
    if (path === "/.well-known/jwks.json") return void res.end(JSON.stringify({ keys: [jwk] }));
    if (path === "/token") {
      const form = new URLSearchParams(body);
      const clientId = Buffer.from(String(req.headers.authorization).slice(6), "base64").toString().split(":")[0]!;
      void new SignJWT({ nonce: nonces.get(clientId), email: "alice@a.example.test" })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(`${new URL(form.get("redirect_uri")!).origin}/idp`)
        .setAudience(clientId)
        .setSubject("alice")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey)
        .then((idToken) => res.end(JSON.stringify({ access_token: "at", id_token: idToken })));
      return;
    }
    if (path === "/userinfo")
      return void res.end(JSON.stringify({ sub: "alice", email: "alice@a.example.test", email_verified: true }));
    res.end(JSON.stringify({ path }));
  });
});
const nonces = new Map<string, string>();
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: "tenant-sign-in-test-secret",
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "tenant-sign-in-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  AUTH_BROKER_UPSTREAM: upstreamUrl,
  OIDC_ISSUER: "http://portal.test/idp",
  OIDC_AUTH_ENDPOINT: "http://portal.test/idp/authorize",
  OIDC_TOKEN_ENDPOINT: `${upstreamUrl}/token`,
  OIDC_USERINFO_ENDPOINT: `${upstreamUrl}/userinfo`,
  OIDC_JWKS_URI: `${upstreamUrl}/.well-known/jwks.json`,
  OIDC_CLIENT_ID: "deployment-client",
  OIDC_CLIENT_SECRET: "d".repeat(40),
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
test.after(() => {
  server.close();
  upstream.close();
});

function get(
  host: string,
  path: string,
  cookie = "",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host, cookie, accept: "text/html" } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function login(host: string): Promise<{ authorize: URL; tmp: string }> {
  const r = await get(host, "/auth/login");
  assert.equal(r.status, 302);
  const tmp = (r.headers["set-cookie"] ?? []).find((c) => c.startsWith("portal_oidc_tmp="))!.split(";")[0]!;
  return { authorize: new URL(r.headers.location!), tmp };
}

test("each company's sign-in stays on its own host with its own client", async () => {
  for (const [host, clientId] of [
    ["a.example.test", "client-a"],
    ["b.example.test", "client-b"],
  ]) {
    const { authorize } = await login(host!);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `http://${host}/idp/authorize`);
    assert.equal(authorize.searchParams.get("client_id"), clientId);
    assert.equal(authorize.searchParams.get("redirect_uri"), `http://${host}/auth/callback`);
  }
});

test("the broker and the token exchange are told the company's host", async () => {
  seen.length = 0;
  await get("a.example.test", "/idp/authorize?client_id=client-a");
  assert.equal(seen.find((r) => r.path === "/authorize")?.headers["x-forwarded-host"], "a.example.test");

  const { authorize, tmp } = await login("a.example.test");
  nonces.set("client-a", authorize.searchParams.get("nonce")!);
  seen.length = 0;
  const state = authorize.searchParams.get("state")!;
  const callback = await get("a.example.test", `/auth/callback?code=c&state=${state}`, tmp);
  assert.equal(callback.status, 302, callback.body);
  assert.ok((callback.headers["set-cookie"] ?? []).some((c) => c.startsWith("portal_session=")));
  const token = seen.find((r) => r.path === "/token")!;
  assert.equal(token.headers["x-forwarded-host"], "a.example.test");
  assert.equal(new URLSearchParams(token.body).get("redirect_uri"), "http://a.example.test/auth/callback");
  assert.equal(seen.find((r) => r.path === "/userinfo")?.headers["x-forwarded-host"], "a.example.test");
});
