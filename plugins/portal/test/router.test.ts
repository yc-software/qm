import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let whoamiProbes = 0;
let lastConsentClicker: string | null = null;
let lastImpersonateIdentity: string | null = null;
let agentApiRequests = 0;
const VALID_AGENT_CAPABILITY = "valid.agent.capability";
let deploymentLayerRequests = 0;
const VALID_SOURCE_SIGNATURE = "v0=valid-source-signature";

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url?.startsWith("/v1/deployment-layer")) {
    deploymentLayerRequests++;
    if (req.headers["x-timestamp"] !== "123" || req.headers["x-signature"] !== VALID_SOURCE_SIGNATURE) {
      res.writeHead(401, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    return void req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
  }
  if (req.url?.startsWith("/v1/memory/self") || req.url?.startsWith("/v1/blobs")) {
    agentApiRequests++;
    if (req.headers["x-agent-capability"] !== VALID_AGENT_CAPABILITY) {
      res.writeHead(401, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    return void req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
  }
  if (typeof req.url === "string" && req.url.startsWith("/v1/connectors/oauth/consent/redeem/")) {
    lastConsentClicker = (req.headers["x-consent-clicker"] as string | undefined) ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({ status: "authorize", authorizeUrl: "https://accounts.google.test/o/oauth2?x=1" }),
    );
  }
  if (req.url === "/api/whoami") {
    whoamiProbes++;
    const m = (req.headers.cookie ?? "").match(/admin=([^;]+)/);
    const sub = m ? decodeURIComponent(m[1] ?? "") : "";
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: sub === "U-admin" }));
  }
  if (typeof req.url === "string" && req.url.startsWith("/v1/admin/impersonate")) {
    lastImpersonateIdentity =
      typeof req.headers["x-portal-identity"] === "string" ? req.headers["x-portal-identity"] : null;
    let body = "";
    req.on("data", (c) => (body += c));
    return void req.on("end", () => {
      const actor = req.headers["x-admin-actor"];
      const ok = typeof actor === "string" && actor.startsWith("U-admin@");
      res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok ? { ok: true, displayName: "Alice Example" } : { error: "forbidden", message: "admin grant required" },
        ),
      );
    });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, headers: req.headers }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const PUBLIC = "http://portal.test";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "router-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "router-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
const { deriveKey, seal, open } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const sessionKey = deriveKey("router-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string, ageS = 0): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - ageS;
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat, exp: iat + 28800 }, sessionKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
});

test("healthz is unauthenticated", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
});

test("favicon: served unauthenticated as an SVG of the pirate-flag emoji", async () => {
  for (const path of ["/favicon.ico", "/favicon.svg"]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.match(await r.text(), /\u{1F3F4}\u{200D}☠️/u);
  }
});

test("no session: JSON request is 401, HTML navigation is 302 to login", async () => {
  const j = await fetch(`${base}/api/sessions`, { redirect: "manual" });
  assert.equal(j.status, 401);
  const h = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(h.status, 302);
  assert.match(h.headers.get("location") ?? "", /^\/auth\/login\?returnTo=/);
});

test("legacy /web-ui prefix redirects permanently to the same path at the root", async () => {
  const r = await fetch(`${base}/web-ui/api/sessions?q=1`, { redirect: "manual" });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "/api/sessions?q=1");
  const bare = await fetch(`${base}/web-ui`, { redirect: "manual" });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/");
});

test("valid session: upstream receives ONLY the synthesized cookie, prefix stripped, forged identity dropped", async () => {
  const r = await fetch(`${base}/web-ui/api/x?q=1`, {
    headers: {
      cookie: `${sessionCookie("U1")}; webuiuser=EVIL; admin=EVIL`,
      "x-as-principal": "EVIL",
      "x-admin-actor": "EVIL@acme",
    },
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string; cookie: string; headers: Record<string, string> };
  assert.equal(body.url, "/api/x?q=1");
  assert.equal(body.cookie, "webuiuser=U1");
  assert.equal(body.headers["x-as-principal"], undefined);
  assert.equal(body.headers["x-admin-actor"], undefined);
});

test("web-ui /app-edit drops x-frame-options so its own frame-ancestors CSP can allow the app origin", async () => {
  const editPage = await fetch(`${base}/app-edit?slug=demo`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(editPage.status, 200);
  assert.equal(editPage.headers.get("x-frame-options"), null, "/app-edit must not carry the blanket DENY");
  const normal = await fetch(`${base}/api/x`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(normal.headers.get("x-frame-options"), "DENY", "every other surface path keeps DENY");
});

test("admin tier (derived gate): non-admin sub is 403 before the upstream; admin sub gets admin=<sub>", async () => {
  const denied = await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(denied.status, 403);
  const deniedHtml = await fetch(`${base}/admin/`, { headers: { cookie: sessionCookie("U1"), accept: "text/html" } });
  assert.equal(deniedHtml.status, 403);
  assert.match(await deniedHtml.text(), /admin access/i);

  const ok = await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U-admin") } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { cookie: string };
  assert.equal(body.cookie, "admin=U-admin");
});

test("admin gate fails closed for an unknown sub (whoami false ⇒ 403)", async () => {
  const r = await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U-ghost") } });
  assert.equal(r.status, 403);
});

test("an unclaimed prefix falls through to the web UI surface (its SPA owns unknown paths)", async () => {
  const r = await fetch(`${base}/nope/x`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string; cookie: string };
  assert.equal(body.url, "/nope/x");
  assert.equal(body.cookie, "webuiuser=U1");
});

test("an unmatched /v1 path is a hard 404, never the SPA shell", async () => {
  for (const p of ["/v1/keychain/credentials", "/v1", "/v1/"]) {
    const r = await fetch(`${base}${p}`, { headers: { cookie: sessionCookie("U1") } });
    assert.equal(r.status, 404, `expected 404 for ${p}, got ${r.status}`);
  }
});

test("tier-escape: encoded separators are rejected, and a normalized traversal cannot reach a higher tier", async () => {
  for (const p of ["/web-ui/..%2fadmin/x", "//admin/x", "/web-ui/%2e%2e%2fadmin", "/web-ui/%5cadmin"]) {
    const r = await fetch(`${base}${p}`, { headers: { cookie: sessionCookie("U1") }, redirect: "manual" });
    assert.equal(r.status, 400, `expected 400 for ${p}, got ${r.status}`);
  }
  const collapsed = await fetch(`${base}/web-ui/%2e%2e/admin/api/me`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(collapsed.status, 403);
});

test("CSRF: a non-GET without a same-origin Origin is refused", async () => {
  const noOrigin = await fetch(`${base}/web-ui/api/turn`, { method: "POST", headers: { cookie: sessionCookie("U1") } });
  assert.equal(noOrigin.status, 403);
  const sameOrigin = await fetch(`${base}/web-ui/api/turn`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: PUBLIC },
  });
  assert.equal(sameOrigin.status, 200);
});

test("inbound webhooks pass through to the core with NO session, signature headers preserved, no synthesized cookie", async () => {
  const r = await fetch(`${base}/v1/webhooks/incoming/wh_abc?x=1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=deadbeef",
      "x-github-delivery": "d-1",
    },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string; cookie: string | null; headers: Record<string, string> };
  assert.equal(body.url, "/v1/webhooks/incoming/wh_abc?x=1");
  assert.equal(body.cookie, null);
  assert.equal(body.headers["x-hub-signature-256"], "sha256=deadbeef");
  assert.equal(body.headers["x-github-delivery"], "d-1");
});

test("the webhook passthrough is exact-shape + POST-only (no widening of /v1)", async () => {
  assert.equal((await fetch(`${base}/v1/webhooks/incoming/abc`)).status, 404);
  assert.equal((await fetch(`${base}/v1/webhooks/incoming/a/b`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/v1/webhooks`, { method: "POST" })).status, 404);
});

test("miniapps pass through to the core with NO session so Slack buttons and iframes work", async () => {
  const r = await fetch(`${base}/m/aa/bb`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string; cookie: string | null };
  assert.equal(body.url, "/m/aa/bb");
  assert.equal(body.cookie, null);
  assert.equal(r.headers.get("x-frame-options"), null);
});

test("the miniapp passthrough is GET /m/:id/:key only", async () => {
  assert.equal((await fetch(`${base}/m/aa`, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(`${base}/m/aa/bb/cc`, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(`${base}/m/aa/bb`, { method: "POST", redirect: "manual" })).status, 401);
});

test("the provider callback still passes through publicly with NO session/cookie", async () => {
  const cb = await fetch(`${base}/v1/connectors/oauth/google/callback?code=c&state=s`, { redirect: "manual" });
  assert.equal(cb.status, 200);
  const cbb = (await cb.json()) as { url: string; cookie: string | null };
  assert.equal(cbb.url, "/v1/connectors/oauth/google/callback?code=c&state=s");
  assert.equal(cbb.cookie, null);
});

test("the legacy /v1 browser-leg aliases are gone: the portal no longer serves them, /v1 stays private", async () => {
  assert.equal(
    (await fetch(`${base}/v1/connectors/oauth/consent/redeem/abc?p=google`, { redirect: "manual" })).status,
    404,
  );
  assert.equal((await fetch(`${base}/v1/connectors/oauth/google/self-connect`, { redirect: "manual" })).status, 404);
  assert.equal((await fetch(`${base}/v1/keychain/drops/abc/form`, { redirect: "manual" })).status, 404);
  assert.equal(
    (await fetch(`${base}/v1/connectors/oauth/consent/redeem/abc`, { method: "POST", headers: { origin: PUBLIC } }))
      .status,
    404,
  );
  assert.equal((await fetch(`${base}/v1/connectors/oauth/status`)).status, 404);
});

test("new human path /connect/redeem/:id: session-gated; with session forwards the verified clicker to the core /v1 endpoint and redirects to the provider", async () => {
  const noSession = await fetch(`${base}/connect/redeem/abc-123?p=google`, { redirect: "manual" });
  assert.equal(noSession.status, 302);
  assert.match(noSession.headers.get("location") ?? "", /^\/auth\/login\?returnTo=%2Fconnect%2Fredeem%2Fabc-123/);

  lastConsentClicker = null;
  const r = await fetch(`${base}/connect/redeem/abc-123?p=google`, {
    headers: { cookie: sessionCookie("eve@acme") },
    redirect: "manual",
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://accounts.google.test/o/oauth2?x=1");
  assert.equal(
    lastConsentClicker,
    "eve@acme",
    "the verified session sub is forwarded to core, never an identity from the link",
  );
});

test("new human path /connect/:provider/self-connect: session-gated; with session it starts a personal flow via core", async () => {
  const noSession = await fetch(`${base}/connect/google/self-connect`, { redirect: "manual" });
  assert.equal(noSession.status, 302);
  assert.match(noSession.headers.get("location") ?? "", /^\/auth\/login/);
  const r = await fetch(`${base}/connect/google/self-connect`, {
    headers: { cookie: sessionCookie("eve@acme") },
    redirect: "manual",
  });
  assert.equal(
    r.status,
    200,
    "reaches core (the mock returns no authorizeUrl, so the portal renders a page rather than 404ing)",
  );
});

test("new human path /drop/:id: form GET reaches the core /v1 drop form with x-drop-owner; POST /drop/:id never redirects (no session → 401, cross-origin → 403)", async () => {
  const noSession = await fetch(`${base}/drop/drop-1/form`, { redirect: "manual" });
  assert.equal(noSession.status, 302);
  assert.match(noSession.headers.get("location") ?? "", /^\/auth\/login/);

  const form = await fetch(`${base}/drop/drop-1/form?t=link-token-1`, {
    headers: { cookie: sessionCookie("owner@acme") },
    redirect: "manual",
  });
  assert.equal(form.status, 200);
  const fb = (await form.json()) as { url: string; headers: Record<string, string> };
  assert.match(fb.url, /^\/v1\/keychain\/drops\/drop-1\/form/);
  assert.match(fb.url, /[?&]t=link-token-1/, "the link-bound token in the query string survives forwarding to core");
  assert.equal(
    fb.headers["x-drop-owner"],
    "owner@acme",
    "the verified session sub is forwarded to core as the drop owner",
  );

  assert.equal(
    (await fetch(`${base}/drop/drop-1`, { method: "POST", headers: { origin: PUBLIC } })).status,
    401,
    "a POST with no session returns an error, never a redirect that would drop the secret in flight",
  );
  assert.equal(
    (
      await fetch(`${base}/drop/drop-1`, {
        method: "POST",
        headers: { origin: "http://evil.test", cookie: sessionCookie("owner@acme") },
      })
    ).status,
    403,
  );

  const ok = await fetch(`${base}/drop/drop-1?t=link-token-1`, {
    method: "POST",
    headers: { origin: PUBLIC, cookie: sessionCookie("owner@acme"), "content-type": "application/json" },
    body: JSON.stringify({ secret: "s3cr3t" }),
  });
  assert.equal(ok.status, 200);
  const ob = (await ok.json()) as { url: string; headers: Record<string, string> };
  assert.match(ob.url, /^\/v1\/keychain\/drops\/drop-1(\?|$)/);
  assert.match(ob.url, /[?&]t=link-token-1/, "the submit leg forwards the token too — the redeem check depends on it");
  assert.equal(ob.headers["x-drop-owner"], "owner@acme");
});

test("deployments are OFF by default (404 even with a session)", async () => {
  const r = await fetch(`${base}/d/some-app/`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(r.status, 404);
});

test("auth/login sets the tmp cookie and 302s to the IdP with PKCE+state+nonce", async () => {
  const r = await fetch(`${base}/auth/login?returnTo=/web-ui/`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = r.headers.get("location") ?? "";
  assert.ok(loc.startsWith("https://slack.com/openid/connect/authorize"));
  const u = new URL(loc);
  assert.ok(u.searchParams.get("state"));
  assert.ok(u.searchParams.get("nonce"));
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(r.headers.get("set-cookie") ?? "", /portal_oidc_tmp=/);
});

test("auth/callback with no tmp cookie fails closed (400, no token exchange)", async () => {
  const r = await fetch(`${base}/auth/callback?code=x&state=y`, { redirect: "manual" });
  assert.equal(r.status, 400);
});

test("auth/logout requires same-origin and clears the session cookie", async () => {
  const denied = await fetch(`${base}/auth/logout`, { method: "POST" });
  assert.equal(denied.status, 403);
  const ok = await fetch(`${base}/auth/logout`, { method: "POST", headers: { origin: PUBLIC } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie") ?? "", /portal_session=;[^,]*Max-Age=0/);
});

test("auth/logout: a no-JS HTML form POST gets a 303 redirect to / (cookies still cleared)", async () => {
  const r = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { origin: PUBLIC, accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/");
  assert.match(r.headers.get("set-cookie") ?? "", /portal_session=;[^,]*Max-Age=0/);
});

test("root: a signed-in session proxies straight to the web UI; signed-out bounces to login", async () => {
  const r = await fetch(`${base}/`, { headers: { cookie: sessionCookie("U1"), accept: "text/html" } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string; cookie: string };
  assert.equal(body.url, "/");
  assert.equal(body.cookie, "webuiuser=U1");

  const out = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(out.status, 302);
  assert.match(out.headers.get("location") ?? "", /^\/auth\/login\?returnTo=/);
});

test("retired credential import routes are not public", async () => {
  const pairPath = ["/v1", "/wallet", "/pair"].join("");
  assert.equal((await fetch(`${base}${pairPath}/start`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}${pairPath}/poll`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}${pairPath}/mint`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}${pairPath}/consent`)).status, 404);
  assert.equal((await fetch(`${base}${pairPath}/approve`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/v1/credentials/other`, { method: "POST" })).status, 404);
});

test("external-agent routes are not public and packages are not publicly downloadable", async () => {
  const retiredRoot = ["/v1", "/external", "-agents"].join("");
  assert.equal((await fetch(`${base}/${["qm", "link.tgz"].join("-")}`)).status, 401);
  for (const path of [
    `${retiredRoot}/link/register`,
    `${retiredRoot}/link/jobs/next`,
    `${retiredRoot}/link/jobs/job-1/result`,
    `${retiredRoot}/link/nope`,
    `${retiredRoot}/pair-code`,
    `${retiredRoot}/ask`,
    retiredRoot,
  ]) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer link-device-token",
        cookie: "must-not-cross=1",
      },
      body: "{}",
    });
    assert.equal(response.status, 404);
  }
});

test("capability-authenticated agent memory and blob requests reach core with only safe headers", async () => {
  const memory = await fetch(`${base}/v1/memory/self?scope=org`, {
    headers: {
      "x-agent-capability": VALID_AGENT_CAPABILITY,
      "x-signature": "must-not-cross",
      "x-timestamp": "123",
      "x-as-principal": "spoofed",
      cookie: "portal_session=spoofed",
    },
  });
  assert.equal(memory.status, 200);
  const memoryBody = (await memory.json()) as { url: string; headers: Record<string, string> };
  assert.equal(memoryBody.url, "/v1/memory/self?scope=org");
  assert.equal(memoryBody.headers["x-agent-capability"], VALID_AGENT_CAPABILITY);
  assert.equal(memoryBody.headers["x-signature"], undefined);
  assert.equal(memoryBody.headers["x-timestamp"], undefined);
  assert.equal(memoryBody.headers["x-as-principal"], undefined);
  assert.equal(memoryBody.headers.cookie, undefined);

  const bytes = "blob bytes";
  const sha = "a".repeat(64);
  const blob = await fetch(`${base}/v1/blobs`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-agent-capability": VALID_AGENT_CAPABILITY,
      "x-content-sha256": sha,
    },
    body: bytes,
  });
  assert.equal(blob.status, 200);
  const blobBody = (await blob.json()) as { body: string; headers: Record<string, string> };
  assert.equal(blobBody.body, bytes);
  assert.equal(blobBody.headers["content-type"], "application/octet-stream");
  assert.equal(blobBody.headers["x-content-sha256"], sha);
});

test("core rejects invalid agent capabilities, while missing/source-auth-only requests never reach core", async () => {
  const before = agentApiRequests;
  const invalid = await fetch(`${base}/v1/memory/self`, { headers: { "x-agent-capability": "invalid" } });
  assert.equal(invalid.status, 401, "the upstream core remains the token authority");
  assert.equal(agentApiRequests, before + 1, "a nonempty opaque token is forwarded for core verification");

  assert.equal((await fetch(`${base}/v1/memory/self`)).status, 404);
  assert.equal(
    (
      await fetch(`${base}/v1/memory/self`, {
        headers: { "x-signature": "source-auth", "x-timestamp": "123" },
      })
    ).status,
    404,
  );
  assert.equal(agentApiRequests, before + 1, "unauthenticated and source-auth-only requests are not broadly proxied");
});

test("the exact deployment-layer route carries source auth to core without widening source-auth routing", async () => {
  const before = deploymentLayerRequests;
  const payload = JSON.stringify({ contract: 1, tools: [], skills: [] });
  const applied = await fetch(`${base}/v1/deployment-layer`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-timestamp": "123",
      "x-signature": VALID_SOURCE_SIGNATURE,
      "x-as-principal": "must-not-cross",
      cookie: "portal_session=must-not-cross",
    },
    body: payload,
  });
  assert.equal(applied.status, 200);
  const body = (await applied.json()) as { body: string; headers: Record<string, string> };
  assert.equal(body.body, payload);
  assert.equal(body.headers["x-timestamp"], "123");
  assert.equal(body.headers["x-signature"], VALID_SOURCE_SIGNATURE);
  assert.equal(body.headers["x-as-principal"], undefined);
  assert.equal(body.headers.cookie, undefined);

  const invalid = await fetch(`${base}/v1/deployment-layer`, {
    method: "GET",
    headers: { "x-timestamp": "123", "x-signature": "v0=invalid" },
  });
  assert.equal(invalid.status, 401, "core remains the source-auth authority");
  assert.equal(deploymentLayerRequests, before + 2);

  assert.equal(
    (
      await fetch(`${base}/v1/deployment-layer/nope`, {
        method: "PUT",
        headers: { "x-timestamp": "123", "x-signature": VALID_SOURCE_SIGNATURE },
      })
    ).status,
    404,
  );
  assert.equal(deploymentLayerRequests, before + 2, "nearby source-auth paths never reach core");
});

test("agent capabilities do not bypass the connect/drop browser session gates", async () => {
  const headers = { "x-agent-capability": VALID_AGENT_CAPABILITY };
  const oauth = await fetch(`${base}/connect/redeem/abc?p=google`, { headers, redirect: "manual" });
  assert.equal(oauth.status, 302);
  assert.match(oauth.headers.get("location") ?? "", /^\/auth\/login\?returnTo=/);
  const drop = await fetch(`${base}/drop/drop-1/form`, { headers, redirect: "manual" });
  assert.equal(drop.status, 302);
  assert.match(drop.headers.get("location") ?? "", /^\/auth\/login\?returnTo=/);
});

test("sliding renewal: a fresh session is NOT re-stamped, an aged one is re-issued with a full TTL (and survives the proxy)", async () => {
  const fresh = await fetch(`${base}/web-ui/api/x`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(fresh.status, 200);
  assert.doesNotMatch(fresh.headers.get("set-cookie") ?? "", /portal_session=/, "a fresh session is not re-stamped");

  const aged = await fetch(`${base}/web-ui/api/x`, { headers: { cookie: sessionCookie("U1", 20000) } });
  assert.equal(aged.status, 200);
  const setCookie = aged.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/portal_session=([^;]+)/);
  assert.ok(m, "an aged session is re-stamped through the proxy");
  assert.match(setCookie, /Max-Age=28800/, "the renewed cookie carries a full TTL");
  const claims = open(decodeURIComponent(m![1] ?? ""), sessionKey) as { sub: string; exp: number } | null;
  assert.equal(claims?.sub, "U1", "the renewed cookie is valid and preserves the sub");
  assert.ok((claims?.exp ?? 0) > Math.floor(Date.now() / 1000) + 28000, "exp is pushed out to ~now + full TTL");
});

test("admin-status probe is memoized within the TTL (one round-trip per sub)", async () => {
  const before = whoamiProbes;
  await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U-fresh-ttl") } });
  await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U-fresh-ttl") } });
  assert.equal(whoamiProbes - before, 1, "the sub is probed once then served from the 60s cache");
});

test("impersonate start: non-admin is refused; cross-origin is refused; self-target is rejected", async () => {
  const nonAdmin = await fetch(`${base}/auth/impersonate?target=alice@acme`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: PUBLIC },
  });
  assert.equal(nonAdmin.status, 403);
  const noOrigin = await fetch(`${base}/auth/impersonate?target=alice@acme`, {
    method: "POST",
    headers: { cookie: sessionCookie("U-admin") },
  });
  assert.equal(noOrigin.status, 403);
  const self = await fetch(`${base}/auth/impersonate?target=U-admin`, {
    method: "POST",
    headers: { cookie: sessionCookie("U-admin"), origin: PUBLIC },
  });
  assert.equal(self.status, 400);
});

test("impersonate: an admin starts it; the web-ui hop carries target + impersonator; admin plane is untouched; cookie is bound to the admin", async () => {
  const start = await fetch(`${base}/auth/impersonate?target=alice@acme`, {
    method: "POST",
    headers: { cookie: sessionCookie("U-admin"), origin: PUBLIC, accept: "application/json" },
  });
  assert.equal(start.status, 200);
  assert.ok(lastImpersonateIdentity, "the direct core call carries the signed portal identity");
  const startBody = (await start.json()) as { ok: boolean; target: string; displayName: string };
  assert.equal(startBody.target, "alice@acme");
  assert.equal(startBody.displayName, "Alice Example", "the display name resolved by core is echoed back");
  const m = (start.headers.get("set-cookie") ?? "").match(/portal_impersonate=([^;]+)/);
  assert.ok(m, "the impersonation cookie is set");
  const impCookie = `portal_impersonate=${m![1]}`;

  const web = await fetch(`${base}/web-ui/api/x`, { headers: { cookie: `${sessionCookie("U-admin")}; ${impCookie}` } });
  assert.equal(((await web.json()) as { cookie: string }).cookie, "webuiuser=alice%40acme; webui_impersonator=U-admin");

  const adminHop = await fetch(`${base}/admin/api/me`, {
    headers: { cookie: `${sessionCookie("U-admin")}; ${impCookie}` },
  });
  assert.equal(((await adminHop.json()) as { cookie: string }).cookie, "admin=U-admin");

  const other = await fetch(`${base}/web-ui/api/x`, { headers: { cookie: `${sessionCookie("U1")}; ${impCookie}` } });
  assert.equal(((await other.json()) as { cookie: string }).cookie, "webuiuser=U1");

  const stop = await fetch(`${base}/auth/impersonate/stop`, {
    method: "POST",
    headers: { cookie: `${sessionCookie("U-admin")}; ${impCookie}`, origin: PUBLIC },
  });
  assert.equal(stop.status, 200);
  assert.match(stop.headers.get("set-cookie") ?? "", /portal_impersonate=;[^,]*Max-Age=0/);
});
