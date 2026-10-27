import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { setEdgeTenants } from "../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret } from "../../chassis/src/tenant-settings.ts";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";

const identitySecret = "tenant-hosts-identity-secret-distinct-32";
const clients: Record<string, string> = {
  "a-client": "tenant-a-trusted-secret-of-at-least-32-characters",
  "b-client": "tenant-b-trusted-secret-of-at-least-32-characters",
};
const codes = new Map<string, { nonce: string; client: string }>();
const coreHosts: string[] = [];
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
let issuer = "";

async function body(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

const upstream = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url!, issuer);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/jwks")
      return res.end(JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "test" }] }));
    if (url.pathname === "/token") {
      const params = new URLSearchParams(await body(req));
      const code = codes.get(params.get("code")!)!;
      const [client, secret] = Buffer.from(req.headers.authorization!.slice(6), "base64").toString().split(":");
      assert.equal(client, code.client);
      assert.equal(secret, clients[client!]);
      const id = await new SignJWT({ nonce: code.nonce })
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .setIssuer(issuer)
        .setAudience(code.client)
        .setSubject("person-7")
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(privateKey);
      return res.end(JSON.stringify({ access_token: "profile-access", id_token: id }));
    }
    if (url.pathname === "/userinfo") return res.end(JSON.stringify({ sub: "person-7", name: "Test Founder" }));
    if (url.pathname === "/v1/auth/broker/claim") {
      const { ids } = JSON.parse(await body(req)) as { ids: string[] };
      return res.end(JSON.stringify({ claimed: ids[0] }));
    }
    if (url.pathname.startsWith("/v1/principals/")) {
      coreHosts.push(String(req.headers["x-forwarded-host"]));
      return res.end(JSON.stringify({ canonicalId: decodeURIComponent(url.pathname.split("/")[3]!) }));
    }
    if (url.pathname === "/me") {
      const host = String(req.headers["x-forwarded-host"]);
      const token = String(req.headers["x-portal-identity"]);
      return res.end(
        JSON.stringify({
          identity: verifyPortalIdentity(token, deriveTenantSecret(identitySecret, `tenant-${host[0]}`), Date.now()),
          deploymentIdentity: verifyPortalIdentity(token, identitySecret, Date.now()),
          host,
        }),
      );
    }
    return res.end("{}");
  })().catch((error) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
issuer = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://home.example.test",
  PORTAL_SESSION_SECRET: "tenant-hosts-test-session-secret",
  CORE_ORG_ID: "home-org",
  CORE_API_URL: issuer,
  CORE_SIGNING_SECRET: "test-core-secret",
  PORTAL_IDENTITY_SECRET: identitySecret,
  WEB_UI_UPSTREAM: issuer,
  OIDC_AUTH_ENDPOINT: "https://primary.example.test/authorize",
  OIDC_CLIENT_ID: "primary-client",
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_API_ALLOWED_ORIGINS: "https://embedder.example.test",
  PORTAL_TRUSTED_OIDC: JSON.stringify({
    issuer,
    authEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/userinfo`,
    jwksUri: `${issuer}/jwks`,
    clientId: "home-client",
  }),
  PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "home-trusted-secret-of-at-least-32-characters",
});
const { server } = await import("../src/index.ts");
setEdgeTenants([
  { slug: "home", orgId: "home-org", hosts: ["home.example.test"], status: "active", oidcAdmin: false, secrets: {} },
  ...(["a", "b"] as const).map((name) => ({
    id: `tenant-${name}`,
    slug: name,
    orgId: `org-${name}`,
    hosts: [`${name}.example.test`],
    status: "active" as const,
    faviconSvg: `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`,
    oidcClientId: `${name}-client`,
    oidcAdmin: false,
    secrets: { oidcClientSecret: clients[`${name}-client`]! },
  })),
  {
    id: "tenant-c",
    slug: "c",
    orgId: "org-c",
    hosts: ["c.example.test"],
    status: "active",
    oidcClientId: "c-client",
    oidcAdmin: false,
    secrets: {},
  },
]);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
test.after(() => {
  setEdgeTenants([]);
  server.close();
  upstream.close();
});

function get(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
      void body(res).then((text) => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

function cookieOf(headers: IncomingHttpHeaders, name: string): string {
  return (headers["set-cookie"] ?? []).find((cookie) => cookie.startsWith(`${name}=`))!.split(";")[0]!;
}

async function signIn(host: string): Promise<string> {
  const start = await get(host, "/auth/trusted/login");
  const authorize = new URL(String(start.headers.location));
  assert.equal(authorize.searchParams.get("redirect_uri"), `https://${host}/auth/trusted/callback`);
  const code = `code-${codes.size}`;
  codes.set(code, { nonce: authorize.searchParams.get("nonce")!, client: authorize.searchParams.get("client_id")! });
  const callback = await get(host, `/auth/trusted/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
    cookie: cookieOf(start.headers, "portal_trusted_tmp"),
  });
  assert.equal(callback.status, 302);
  return cookieOf(callback.headers, "portal_session");
}

const asJson = (cookie: string, extra: Record<string, string> = {}) => ({
  cookie,
  accept: "application/json",
  ...extra,
});

test("an unknown host is refused while health checks still answer", async () => {
  const stranger = await get("stranger.example.test", "/");
  assert.equal(stranger.status, 404);
  assert.equal(stranger.text, "unknown host\n");
  assert.equal((await get("10.0.0.7:8000", "/healthz")).status, 200);
});

test("a tenant whose trusted sign-in is misconfigured keeps serving with that sign-in off", async () => {
  assert.equal((await get("c.example.test", "/healthz")).status, 200);
  assert.equal((await get("c.example.test", "/auth/trusted/login")).status, 404);
  assert.equal((await get("c.example.test", "/auth/login")).status, 404);
});

test("the deployment's cross-origin API allowlist applies to the home host only", async () => {
  const preflight = (host: string) =>
    get(
      host,
      "/api/turn",
      { origin: "https://embedder.example.test", "access-control-request-method": "POST" },
      "OPTIONS",
    ).then((r) => r.headers["access-control-allow-origin"]);
  assert.equal(await preflight("home.example.test"), "https://embedder.example.test");
  assert.equal(await preflight("a.example.test"), undefined);
});

test("each tenant host serves its own favicon", async () => {
  assert.match((await get("a.example.test", "/favicon.svg")).text, /<title>a<\/title>/);
  assert.match((await get("b.example.test:443", "/favicon.svg")).text, /<title>b<\/title>/);
  assert.match((await get("home.example.test", "/favicon.svg")).text, /\u{1F3F4}/u);
});

test("a tenant host signs in through its own trusted client while home keeps its primary provider", async () => {
  const tenant = await get("a.example.test", "/auth/login?returnTo=%2Fsettings");
  assert.equal(tenant.headers.location, "/auth/trusted/login?returnTo=%2Fsettings");
  const trusted = new URL(String((await get("a.example.test", "/auth/trusted/login")).headers.location));
  assert.equal(trusted.searchParams.get("client_id"), "a-client");
  const home = new URL(String((await get("home.example.test", "/auth/login")).headers.location));
  assert.equal(home.origin, "https://primary.example.test");
  assert.equal(home.searchParams.get("client_id"), "primary-client");
});

test("a session signed in on one tenant's host does not authenticate on another's", async () => {
  const session = await signIn("a.example.test");
  const subject = Buffer.from("person-7").toString("base64url");
  coreHosts.length = 0;
  const own = await get("a.example.test", "/me", asJson(session));
  assert.equal(own.status, 200);
  const seen = JSON.parse(own.text) as { identity: { p: string; t: string }; deploymentIdentity: null; host: string };
  assert.equal(seen.deploymentIdentity, null);
  assert.equal(seen.identity.p, `oidc:${createHash("sha256").update(issuer).digest("hex")}:${subject}`);
  assert.equal(seen.identity.t, "org-a");
  assert.equal(seen.host, "a.example.test");
  assert.deepEqual(coreHosts, ["a.example.test"]);
  for (const host of ["b.example.test", "home.example.test"])
    assert.equal((await get(host, "/me", asJson(session))).status, 401);
  assert.equal(
    (await get("a.example.test", "/me", asJson(session, { "x-forwarded-host": "b.example.test" }))).status,
    401,
  );
  const other = await signIn("b.example.test");
  const theirs = JSON.parse((await get("b.example.test", "/me", asJson(other))).text) as {
    identity: { t: string };
    host: string;
  };
  assert.equal(theirs.identity.t, "org-b");
  assert.equal(theirs.host, "b.example.test");
});
