import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { setEdgeTenants } from "../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret } from "../../chassis/src/tenant-settings.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import { hashPassword } from "../src/password.ts";
import { basicAuth, CLIENT_ID, CLIENT_SECRET, hiddenRequestToken, pkcePair, signingJwk } from "./helpers.ts";

const PASSWORD = "correct horse battery staple";
const CORE_SECRET = "auth-tenant-hosts-core-secret";
const coreCalls: Array<{ host: string; path: string; signedForHost: boolean }> = [];
const rememberedTokens = new Set<string>();
const core = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    const host = String(req.headers["x-forwarded-host"]);
    const secret = host.startsWith("home.") ? CORE_SECRET : deriveTenantSecret(CORE_SECRET, `tenant-${host[0]}`);
    const canonical = canonicalPayload(req.method!, req.url!, body);
    const path = req.url!.split("?")[0]!;
    coreCalls.push({
      host,
      path,
      signedForHost: req.headers["x-signature"] === signRequest(secret, Number(req.headers["x-timestamp"]), canonical),
    });
    res.setHeader("content-type", "application/json");
    if (path === "/v1/auth/broker/claim") return res.end(JSON.stringify({ claimed: JSON.parse(body).ids[0] }));
    const session = { email: "admin@example.com", authTime: 1, expiresAtMs: Date.now() + 60_000 };
    if (path === "/v1/auth/broker/sessions") {
      const token = createHash("sha256").update(`${host}:${rememberedTokens.size}`).digest("base64url");
      rememberedTokens.add(token);
      return res.end(JSON.stringify({ ...session, token }));
    }
    if (path === "/v1/auth/broker/sessions/use")
      return res.end(JSON.stringify({ session: rememberedTokens.has(JSON.parse(body).token) ? session : null }));
    res.end("{}");
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  NODE_ENV: "test",
  AUTH_ISSUER: "https://home.example.test/idp",
  AUTH_REDIRECT_URI: "https://home.example.test/auth/callback",
  AUTH_CLIENT_ID: CLIENT_ID,
  AUTH_CLIENT_SECRET: CLIENT_SECRET,
  AUTH_TOKEN_SECRET: "fedcba9876543210fedcba9876543210",
  AUTH_SIGNING_JWK: signingJwk(),
  AUTH_ALLOWED_EMAILS: "admin@example.com",
  AUTH_PASSWORD_USERS: `admin@example.com:${await hashPassword(PASSWORD)}`,
  CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
  CORE_SIGNING_SECRET: CORE_SECRET,
});
delete process.env.RESEND_API_KEY;
const { startServer } = await import("../src/index.ts");
setEdgeTenants([
  { slug: "home", orgId: "home", hosts: ["home.example.test"], status: "active", oidcAdmin: false, secrets: {} },
  ...(["a", "b"] as const).map((name) => ({
    id: `tenant-${name}`,
    slug: name,
    orgId: `org-${name}`,
    hosts: [`${name}.example.test`],
    status: "active" as const,
    oidcAdmin: false,
    secrets: {},
  })),
]);
const server = await startServer({ port: 0, host: "127.0.0.1" });
const port = (server.address() as AddressInfo).port;
test.after(() => {
  setEdgeTenants([]);
  server.close();
  core.close();
});

function call(
  host: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: { "x-forwarded-host": host, ...init.headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const formHeaders = { "content-type": "application/x-www-form-urlencoded" };

function authorizePath(host: string, challenge: string): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: `https://${host}/auth/callback`,
    scope: "openid email",
    state: "state-value",
    nonce: "nonce-value",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `/authorize?${query}`;
}

async function signIn(host: string): Promise<{ code: string; verifier: string; cookie: string }> {
  const { verifier, challenge } = pkcePair();
  const page = await call(host, authorizePath(host, challenge));
  assert.equal(page.status, 200);
  const submitted = await call(host, "/authorize", {
    method: "POST",
    headers: formHeaders,
    body: new URLSearchParams({
      request: hiddenRequestToken(page.text),
      method: "password",
      email: "admin@example.com",
      password: PASSWORD,
    }).toString(),
  });
  assert.equal(submitted.status, 302, submitted.text);
  const location = new URL(String(submitted.headers.location));
  assert.equal(`${location.origin}${location.pathname}`, `https://${host}/auth/callback`);
  return {
    code: location.searchParams.get("code")!,
    verifier,
    cookie: String(submitted.headers["set-cookie"]).split(";")[0]!,
  };
}

function exchange(host: string, code: string, verifier: string) {
  return call(host, "/token", {
    method: "POST",
    headers: {
      ...formHeaders,
      authorization: basicAuth(CLIENT_ID, deriveTenantSecret(CLIENT_SECRET, `tenant-${host[0]}`)),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `https://${host}/auth/callback`,
      code_verifier: verifier,
    }).toString(),
  });
}

test("each tenant host is its own issuer, and a code minted on one host cannot be redeemed on another", async () => {
  coreCalls.length = 0;
  const { code, verifier } = await signIn("a.example.test");
  assert.equal((await exchange("b.example.test", code, verifier)).status, 400);
  const tokens = await exchange("a.example.test", code, verifier);
  assert.equal(tokens.status, 200);
  const jwks = JSON.parse((await call("a.example.test", "/.well-known/jwks.json")).text) as { keys: JWK[] };
  const { payload } = await jwtVerify(
    (JSON.parse(tokens.text) as { id_token: string }).id_token,
    createLocalJWKSet(jwks),
    {
      issuer: "https://a.example.test/idp",
      audience: CLIENT_ID,
    },
  );
  assert.equal(payload.email, "admin@example.com");
  const brokerCalls = coreCalls.filter((c) => c.path.startsWith("/v1/auth/broker/"));
  assert.ok(brokerCalls.length > 0);
  assert.deepEqual(new Set(brokerCalls.map((c) => c.host)), new Set(["a.example.test"]));
  assert.ok(coreCalls.filter((c) => c.host !== "undefined").every((c) => c.signedForHost));
  const discovery = JSON.parse((await call("b.example.test", "/.well-known/openid-configuration")).text) as {
    issuer: string;
  };
  assert.equal(discovery.issuer, "https://b.example.test/idp");
});

test("a tenant host refuses another host's redirect and remembered sign-in", async () => {
  const { challenge } = pkcePair();
  const foreign = await call("b.example.test", authorizePath("a.example.test", challenge));
  assert.notEqual(foreign.status, 200);
  const { cookie } = await signIn("a.example.test");
  const again = await call("a.example.test", authorizePath("a.example.test", challenge), { headers: { cookie } });
  assert.equal(again.status, 302);
  const elsewhere = await call("b.example.test", authorizePath("b.example.test", challenge), { headers: { cookie } });
  assert.equal(elsewhere.status, 200);
});

test("the broker refuses a host outside the tenant directory", async () => {
  assert.equal((await call("stranger.example.test", "/.well-known/openid-configuration")).status, 404);
});
