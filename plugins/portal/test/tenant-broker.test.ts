import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { setEdgeTenants } from "../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret } from "../../chassis/src/tenant-settings.ts";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { hashPassword } from "../../auth/src/password.ts";

const PASSWORD = "correct horse battery staple";
const IDENTITY_SECRET = "embedded-broker-identity-secret-of-32-chars";
const members: Record<string, string> = { "a.example.test": "worker@outside.example", "b.example.test": "" };
const sessions = new Set<string>();

async function body(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

const core = createServer((req, res) => {
  void body(req).then((text) => {
    const host = String(req.headers["x-forwarded-host"]);
    const url = new URL(req.url!, "http://core.local");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/auth/broker/claim") return res.end(JSON.stringify({ claimed: JSON.parse(text).ids[0] }));
    if (url.pathname === "/v1/auth/broker/email-allowed")
      return res.end(JSON.stringify({ allowed: members[host] === url.searchParams.get("email") }));
    if (url.pathname === "/v1/auth/broker/sessions") {
      const token = createHash("sha256").update(`${host}:${sessions.size}`).digest("base64url");
      sessions.add(token);
      return res.end(
        JSON.stringify({ token, email: JSON.parse(text).email, authTime: 1, expiresAtMs: Date.now() + 60_000 }),
      );
    }
    if (url.pathname.startsWith("/v1/principals/"))
      return res.end(JSON.stringify({ canonicalId: decodeURIComponent(url.pathname.split("/")[3]!) }));
    if (url.pathname === "/me") {
      const id = host.startsWith("a.") ? "tenant-a" : "tenant-b";
      const identity = verifyPortalIdentity(
        String(req.headers["x-portal-identity"]),
        deriveTenantSecret(IDENTITY_SECRET, id),
        Date.now(),
      );
      return res.end(JSON.stringify({ identity, host }));
    }
    res.end("{}");
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
const brokerPort = await new Promise<number>((resolve) => {
  const probe = createNetServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});
const broker = `http://127.0.0.1:${brokerPort}`;
const clientSecret = "embedded-broker-client-secret-of-32-chars";
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "https://home.example.test",
  PORTAL_SESSION_SECRET: "embedded-broker-portal-session-secret",
  CORE_ORG_ID: "home-org",
  CORE_API_URL: coreUrl,
  WEB_UI_UPSTREAM: coreUrl,
  CORE_SIGNING_SECRET: "embedded-broker-core-secret",
  PORTAL_IDENTITY_SECRET: IDENTITY_SECRET,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  AUTH_EMBEDDED: "1",
  AUTH_BROKER_UPSTREAM: broker,
  OIDC_ISSUER: "https://home.example.test/idp",
  OIDC_AUTH_ENDPOINT: "https://home.example.test/idp/authorize",
  OIDC_TOKEN_ENDPOINT: `${broker}/token`,
  OIDC_USERINFO_ENDPOINT: `${broker}/userinfo`,
  OIDC_JWKS_URI: `${broker}/.well-known/jwks.json`,
  OIDC_CLIENT_ID: "qm-portal",
  OIDC_CLIENT_SECRET: clientSecret,
  AUTH_ISSUER: "https://home.example.test/idp",
  AUTH_REDIRECT_URI: "https://home.example.test/auth/callback",
  AUTH_CLIENT_ID: "qm-portal",
  AUTH_CLIENT_SECRET: clientSecret,
  AUTH_TOKEN_SECRET: "embedded-broker-token-secret-of-32-chars",
  AUTH_SIGNING_JWK: JSON.stringify(
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
  ),
  AUTH_ALLOWED_EMAIL_DOMAIN: "home.example",
  AUTH_PASSWORD_USERS: `worker@outside.example:${await hashPassword(PASSWORD)}`,
});
const { startServer } = await import("../src/index.ts");
setEdgeTenants([
  { slug: "home", orgId: "home-org", hosts: ["home.example.test"], status: "active", oidcAdmin: false, secrets: {} },
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
const server = await startServer(0, "127.0.0.1");
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
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host, ...init.headers } },
      (res) => void body(res).then((text) => resolve({ status: res.statusCode ?? 0, headers: res.headers, text })),
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const cookie = (headers: IncomingHttpHeaders, name: string): string =>
  (headers["set-cookie"] ?? []).find((value) => value.startsWith(`${name}=`))!.split(";")[0]!;

async function signIn(host: string): Promise<{ status: number; session?: string }> {
  const login = await call(host, "/auth/login");
  const authorize = new URL(String(login.headers.location));
  assert.equal(authorize.origin, `https://${host}`);
  assert.equal(authorize.searchParams.get("redirect_uri"), `https://${host}/auth/callback`);
  const page = await call(host, `${authorize.pathname}${authorize.search}`);
  assert.equal(page.status, 200);
  const requestToken = /name="request" value="([^"]+)"/.exec(page.text)![1]!.replace(/&amp;/g, "&");
  const submitted = await call(host, "/idp/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${host}` },
    body: new URLSearchParams({
      request: requestToken,
      method: "password",
      email: "worker@outside.example",
      password: PASSWORD,
    }).toString(),
  });
  if (submitted.status !== 302) return { status: submitted.status };
  const callback = new URL(String(submitted.headers.location));
  assert.equal(`${callback.origin}${callback.pathname}`, `https://${host}/auth/callback`);
  const done = await call(host, `${callback.pathname}${callback.search}`, {
    headers: { cookie: cookie(login.headers, "portal_oidc_tmp") },
  });
  return done.status === 302
    ? { status: 302, session: cookie(done.headers, "portal_session") }
    : { status: done.status };
}

test("an invited employee signs in through the shared broker on their tenant's host only", async () => {
  const { status, session } = await signIn("a.example.test");
  assert.equal(status, 302);
  const me = await call("a.example.test", "/me", { headers: { cookie: session!, accept: "application/json" } });
  const seen = JSON.parse(me.text) as { identity: { p: string; t: string }; host: string };
  assert.equal(seen.identity.p, "worker@outside.example");
  assert.equal(seen.identity.t, "org-a");
  assert.equal(seen.host, "a.example.test");
  assert.equal(
    (await call("b.example.test", "/me", { headers: { cookie: session!, accept: "application/json" } })).status,
    401,
  );
  assert.equal((await signIn("b.example.test")).status, 401);
});
