import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, open, readCookie, seal } from "../src/session.ts";

const secret = "app-hosts-session-test-secret";
const sessionKey = deriveKey(secret, "portal.session.v1");
const alpha = "00000000-0000-4000-8000-00000000000a";
const beta = "00000000-0000-4000-8000-00000000000b";
const appHosts: Record<string, string> = { "nitroduck-dash.qm.test": alpha, "beta7-dash.qm.test": beta };
const proxied: Array<{ host: string; path: string; appHost: boolean }> = [];
const claimed = new Set<string>();

const upstream = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url!, "http://core.test");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/auth/broker/host-tenant") {
      const host = url.searchParams.get("host")!;
      const app = appHosts[host];
      return void res.end(JSON.stringify(app ? { tenant: app, app: true } : { tenant: null }));
    }
    if (url.pathname === "/v1/auth/broker/claim") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const id = (JSON.parse(raw) as { ids: string[] }).ids[0]!;
      const fresh = !claimed.has(id);
      claimed.add(id);
      return void res.end(JSON.stringify({ claimed: fresh ? id : null }));
    }
    proxied.push({ host: String(req.headers.host), path: url.pathname, appHost: req.headers["x-qm-app-host"] === "1" });
    res.end(JSON.stringify({ path: url.pathname }));
  })().catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PUBLIC_WEB_URL: "http://mt.qm.test",
  PORTAL_APPS_DOMAIN: "qm.test",
  PORTAL_SESSION_SECRET: secret,
  PORTAL_IDENTITY_SECRET: "app-hosts-identity-secret-0123456789",
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "app-hosts-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  OIDC_ISSUER: upstreamUrl,
  OIDC_AUTH_ENDPOINT: `${upstreamUrl}/authorize`,
  OIDC_TOKEN_ENDPOINT: `${upstreamUrl}/token`,
  OIDC_USERINFO_ENDPOINT: `${upstreamUrl}/userinfo`,
  OIDC_JWKS_URI: `${upstreamUrl}/keys`,
  OIDC_CLIENT_ID: "portal-client",
  OIDC_CLIENT_SECRET: "client-secret",
  OIDC_PRINCIPAL_CLAIM: "email",
  AUTH_BROKER_UPSTREAM: upstreamUrl,
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

interface HostResponse {
  status: number;
  location: string;
  cookies: string[];
}

function onHost(host: string, path: string, cookie = ""): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host, accept: "text/html", ...(cookie ? { cookie } : {}) } },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers.location ?? ""),
            cookies: ([] as string[]).concat(res.headers["set-cookie"] ?? []),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function session(tenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    k: "session",
    sub: "founder@nitro.test",
    org: "acme",
    auth: now,
    iat: now,
    exp: now + 600,
    t: tenant,
  };
  return `portal_session=${seal(claims, sessionKey)}`;
}

const minted = (r: HostResponse) =>
  r.cookies.find((c) => c.startsWith("portal_session=") && !c.startsWith("portal_session=;"));

test("the portal host stays the portal, while <handle>-<app> hosts go to the app gateway", async () => {
  proxied.length = 0;
  await onHost("mt.qm.test", "/");
  assert.equal(
    proxied.some((p) => p.appHost),
    false,
  );
  await onHost("nitroduck-dash.qm.test", "/reports?x=1");
  assert.deepEqual(proxied.at(-1), { host: "nitroduck-dash.qm.test", path: "/reports", appHost: true });
});

test("a shared-host session hands off to its own company's app host as a host-only cookie, once", async () => {
  const to = "http://nitroduck-dash.qm.test/reports?dpl_signin=1";
  const start = await onHost("mt.qm.test", `/auth/host?to=${encodeURIComponent(to)}`, session(alpha));
  assert.equal(start.status, 302);
  assert.match(start.location, /^http:\/\/nitroduck-dash\.qm\.test\/auth\/handoff\?token=/);
  const handoff = start.location.slice("http://nitroduck-dash.qm.test".length);
  assert.equal((await onHost("beta7-dash.qm.test", handoff)).status, 400);
  const landed = await onHost("nitroduck-dash.qm.test", handoff);
  assert.equal(landed.status, 302);
  assert.equal(landed.location, "/reports?dpl_signin=1");
  const cookie = minted(landed)!;
  assert.doesNotMatch(cookie, /domain=/i);
  const claims = open(readCookie(cookie.split(";")[0], "portal_session"), sessionKey);
  assert.equal(claims?.t, alpha);
  assert.equal((await onHost("nitroduck-dash.qm.test", handoff)).status, 400);
});

test("another company's app host gets no handoff and is sent to sign in", async () => {
  const refused = await onHost(
    "mt.qm.test",
    `/auth/host?to=${encodeURIComponent("http://beta7-dash.qm.test/")}`,
    session(alpha),
  );
  assert.equal(refused.status, 302);
  assert.match(refused.location, /^\/auth\/login\?returnTo=/);
  const unknown = await onHost(
    "mt.qm.test",
    `/auth/host?to=${encodeURIComponent("http://nosuch-dash.qm.test/")}`,
    session(alpha),
  );
  assert.equal(unknown.status, 400);
});
