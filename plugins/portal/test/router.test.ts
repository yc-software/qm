import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { startWithFakeCore, type CoreHit } from "./fake-core.ts";

let whoamiProbes = 0;
let lastWhoamiActor: string | null = null;
let lastWhoamiSigned = false;
let lastConsentClicker: string | null = null;
let lastImpersonateIdentity: string | null = null;
let agentApiRequests = 0;
let flakyLookups = 0;
const VALID_AGENT_CAPABILITY = "valid.agent.capability";
let deploymentLayerRequests = 0;
const VALID_SOURCE_SIGNATURE = "v0=valid-source-signature";

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url === "/readyz" || req.url?.startsWith("/slack/events") || req.url?.includes("/export")) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    return void req.on("end", () => {
      res.writeHead(req.url === "/readyz" ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
  }
  if (req.url?.startsWith("/v1/deployments/app-1/git/")) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    return void req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
  }
  if (
    req.url?.startsWith("/v1/deployment-layer") ||
    req.url?.startsWith("/v1/deployment/live-session") ||
    req.url === "/v1/egress-audit"
  ) {
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
  if (req.url?.startsWith("/v1/principals/U-admin-alias/canonical")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ canonicalId: "U-admin" }));
  }
  if (req.url?.startsWith("/v1/principals/U-alias/canonical")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ principalId: "U-alias", canonicalId: "U1" }));
  }
  if (req.url?.startsWith("/v1/principals/U-flaky/canonical")) {
    flakyLookups++;
    res.writeHead(flakyLookups === 1 ? 200 : 500, { "content-type": "application/json" });
    return void res.end(JSON.stringify(flakyLookups === 1 ? { canonicalId: "U1" } : { error: "timeout" }));
  }
  if (req.url?.startsWith("/v1/principals/U-unresolved/canonical")) {
    res.writeHead(500, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "boom" }));
  }
  if (req.url?.startsWith("/v1/admin/whoami")) {
    whoamiProbes++;
    lastWhoamiActor = typeof req.headers["x-admin-actor"] === "string" ? req.headers["x-admin-actor"] : null;
    lastWhoamiSigned = typeof req.headers["x-signature"] === "string" && typeof req.headers["x-timestamp"] === "string";
    res.writeHead(200, { "content-type": "application/json" });
    const canonicalActor = lastWhoamiActor === "U-admin-alias@acme" ? "U-admin@acme" : lastWhoamiActor;
    return void res.end(JSON.stringify({ isAdmin: canonicalActor === "U-admin@acme" }));
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
  if (req.url?.startsWith("/api/files/")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self' *.apps.test",
    });
    return void res.end("<p>hi</p>");
  }
  if (req.url?.startsWith("/app-edit")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; frame-ancestors 'self' demo.apps.test",
    });
    return void res.end("<p>edit</p>");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, headers: req.headers }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const PUBLIC = "http://portal.test";
process.env.PUBLIC_WEB_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "router-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "router-test-core-secret";
process.env.CORE_API_URL = upstreamUrl;
const SESSION_TTL_S = 28800;
process.env.PORTAL_SESSION_TTL_S = String(SESSION_TTL_S);

const { deriveKey, seal, open } = await import("../src/session.ts");
const { base, hits, close } = await startWithFakeCore((method, pathname) => pathname.startsWith("/api/aliased/"));

const sessionKey = deriveKey("router-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string, ageS = 0): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - ageS;
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat, exp: iat + SESSION_TTL_S }, sessionKey))}`;
}

test.after(() => {
  close();
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

test("favicon: PORTAL_FAVICON_SVG replaces the emoji with operator-supplied markup, anything else falls back", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
  process.env.PORTAL_FAVICON_SVG = svg;
  try {
    for (const path of ["/favicon.ico", "/favicon.svg"]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/svg+xml; charset=utf-8");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await r.text(), svg);
    }
    process.env.PORTAL_FAVICON_SVG = "not an svg document";
    assert.match(await (await fetch(`${base}/favicon.svg`)).text(), /\u{1F3F4}\u{200D}☠️/u);
  } finally {
    delete process.env.PORTAL_FAVICON_SVG;
  }
});

test("no session: JSON request is 401, HTML navigation is 302 to login", async () => {
  const j = await fetch(`${base}/api/sessions`, { redirect: "manual" });
  assert.equal(j.status, 401);
  assert.equal(((await j.json()) as { loginUrl?: unknown }).loginUrl, "/auth/login");
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

test("valid session: the browser request reaches core's web shell with its own session cookie", async () => {
  const r = await fetch(`${base}/api/x?q=1`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(r.status, 200);
  const hit = (await r.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.method, "GET");
  assert.equal(hit.url, "/api/x?q=1");
  const { openSession, readCookie } = await import("../src/session.ts");
  assert.match(hit.cookie ?? "", /^portal_session=[^;]+$/);
  assert.equal(
    openSession(readCookie(hit.cookie!, "portal_session"), sessionKey, Date.now(), "acme", SESSION_TTL_S)?.sub,
    "U1",
  );
});

test("a route core serves is handed to core's router, not the shell", async () => {
  const r = await fetch(`${base}/api/aliased/thing?x=2`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(r.status, 200);
  const hit = (await r.json()) as CoreHit;
  assert.equal(hit.lane, "handle");
  assert.equal(hit.url, "/api/aliased/thing?x=2");
  assert.match(hit.cookie ?? "", /^portal_session=/);
});

test("when core cannot resolve the session subject the portal refuses to proxy instead of guessing", async () => {
  const r = await fetch(`${base}/api/x`, { headers: { cookie: sessionCookie("U-unresolved") } });
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "identity_unavailable");
  const logout = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { cookie: sessionCookie("U-unresolved"), origin: PUBLIC },
    redirect: "manual",
  });
  assert.notEqual(logout.status, 503, "auth routes still work without core");
});

test("a signed-in user keeps their last known identity while core cannot answer the lookup", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const first = await fetch(`${base}/api/x`, { headers: { cookie: sessionCookie("U-flaky") } });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as CoreHit).lane, "shell");
    mock.timers.tick(61_000);
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/api/x`, { headers: { cookie: sessionCookie("U-flaky") } });
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as CoreHit).lane, "shell");
    }
    const drop = await fetch(`${base}/drop/abc/form`, { headers: { cookie: sessionCookie("U-flaky") } });
    assert.equal(drop.status, 503, "routes core does not re-verify never act on a stale identity");
    const app = await fetch(`${base}/d/demo/`, { headers: { cookie: sessionCookie("U-flaky") } });
    assert.equal(app.status, 503);
    const impersonate = await fetch(`${base}/auth/impersonate?target=U2`, {
      method: "POST",
      headers: { cookie: sessionCookie("U-flaky"), origin: PUBLIC },
    });
    assert.equal(impersonate.status, 503);
  } finally {
    mock.timers.reset();
  }
});

test("/settings reaches the web UI as the signed-in user without an admin probe", async () => {
  const before = whoamiProbes;
  for (const path of ["/settings/users"]) {
    const cookie = sessionCookie("U1");
    const r = await fetch(`${base}${path}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const hit = (await r.json()) as CoreHit;
    assert.equal(hit.lane, "shell");
    assert.equal(hit.url, path);
    assert.equal(hit.cookie, cookie);
  }
  assert.equal(whoamiProbes, before);
});

test("an unclaimed prefix falls through to the web UI surface (its SPA owns unknown paths)", async () => {
  const cookie = sessionCookie("U1");
  const r = await fetch(`${base}/nope/x`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const hit = (await r.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.url, "/nope/x");
  assert.equal(hit.cookie, cookie);
});

test("an unmatched /v1 path is a hard 404, never the SPA shell", async () => {
  for (const p of ["/v1/keychain/credentials", "/v1", "/v1/"]) {
    const r = await fetch(`${base}${p}`, { headers: { cookie: sessionCookie("U1") } });
    assert.equal(r.status, 404, `expected 404 for ${p}, got ${r.status}`);
  }
});

test("path confusion: encoded separators are rejected, and a normalized traversal reaches only the web UI as the signed-in user", async () => {
  const before = hits.length;
  for (const p of ["/web-ui/..%2fadmin/x", "//admin/x", "/web-ui/%2e%2e%2fadmin", "/web-ui/%5cadmin"]) {
    const r = await fetch(`${base}${p}`, { headers: { cookie: sessionCookie("U1") }, redirect: "manual" });
    assert.equal(r.status, 400, `expected 400 for ${p}, got ${r.status}`);
  }
  assert.equal(hits.length, before);
  const cookie = sessionCookie("U1");
  const collapsed = await fetch(`${base}/web-ui/%2e%2e/admin/api/me`, { headers: { cookie } });
  assert.equal(collapsed.status, 200);
  const hit = (await collapsed.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.url, "/admin/api/me");
  assert.equal(hit.cookie, cookie);
});

test("CSRF: a non-GET without a same-origin Origin is refused", async () => {
  const before = hits.length;
  const noOrigin = await fetch(`${base}/api/turn`, { method: "POST", headers: { cookie: sessionCookie("U1") } });
  assert.equal(noOrigin.status, 403);
  assert.equal(hits.length, before);
  const sameOrigin = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { cookie: sessionCookie("U1"), origin: PUBLIC },
    body: "{}",
  });
  assert.equal(sameOrigin.status, 200);
  const hit = (await sameOrigin.json()) as CoreHit;
  assert.equal(hit.method, "POST");
  assert.equal(hit.url, "/api/turn");
  assert.equal(hit.body, "{}");
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

test("inbound Linear webhooks reach the core with their signature header", async () => {
  const r = await fetch(`${base}/v1/webhooks/incoming/wh_linear`, {
    method: "POST",
    headers: { "content-type": "application/json", "linear-signature": "abc123" },
    body: JSON.stringify({ webhookTimestamp: 1 }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { headers: Record<string, string> };
  assert.equal(body.headers["linear-signature"], "abc123");
});

test("inbound token and Standard Webhooks requests reach the core with their credentials", async () => {
  const sent = {
    authorization: "Bearer hook-token",
    "webhook-id": "msg_1",
    "webhook-timestamp": "1",
    "webhook-signature": "v1,abc",
  };
  const r = await fetch(`${base}/v1/webhooks/incoming/wh_token?token=hook-token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...sent },
    body: "{}",
  });
  const body = (await r.json()) as { url: string; headers: Record<string, string> };
  assert.equal(body.url, "/v1/webhooks/incoming/wh_token?token=hook-token");
  for (const [name, value] of Object.entries(sent)) assert.equal(body.headers[name], value);
});

test("partner-chat events reach the core with only their body and signature headers", async () => {
  const payload = JSON.stringify({ type: "message.created" });
  const r = await fetch(`${base}/v1/surfaces/partner-chat/events?x=1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-app-request-timestamp": "1793649600",
      "x-agent-app-signature": "v0=abc",
      authorization: "Bearer nope",
      cookie: sessionCookie("U1"),
      "x-extra": "1",
    },
    body: payload,
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { url: string; cookie: string | null; headers: Record<string, string> };
  assert.equal(body.url, "/v1/surfaces/partner-chat/events");
  assert.equal(body.cookie, null);
  assert.deepEqual(
    Object.fromEntries(
      [
        "content-type",
        "content-length",
        "x-agent-app-request-timestamp",
        "x-agent-app-signature",
        "authorization",
        "x-extra",
      ].map((h) => [h, body.headers[h]]),
    ),
    {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
      "x-agent-app-request-timestamp": "1793649600",
      "x-agent-app-signature": "v0=abc",
      authorization: undefined,
      "x-extra": undefined,
    },
  );
  assert.equal((await fetch(`${base}/v1/surfaces/partner-chat/events`)).status, 404);
});

test("the webhook passthrough is exact-shape + POST-only (no widening of /v1)", async () => {
  assert.equal((await fetch(`${base}/v1/webhooks/incoming/abc`)).status, 404);
  assert.equal((await fetch(`${base}/v1/webhooks/incoming/a/b`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/v1/webhooks`, { method: "POST" })).status, 404);
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

test("/d/ proxies to core for a signed-in session", async () => {
  const r = await fetch(`${base}/d/some-app/`, { headers: { cookie: sessionCookie("U1") } });
  assert.notEqual(r.status, 404, "the /d/ route exists");
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
  const cookie = sessionCookie("U1");
  const r = await fetch(`${base}/`, { headers: { cookie, accept: "text/html" } });
  assert.equal(r.status, 200);
  const hit = (await r.json()) as CoreHit;
  assert.equal(hit.lane, "shell");
  assert.equal(hit.url, "/");
  assert.equal(hit.cookie, cookie);

  const before = hits.length;
  const out = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(out.status, 302);
  assert.match(out.headers.get("location") ?? "", /^\/auth\/login\?returnTo=/);
  assert.equal(hits.length, before);
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

test("the egress proxy's signed audit POST reaches core through the front door, and nothing nearby does", async () => {
  const before = deploymentLayerRequests;
  const payload = JSON.stringify({ records: [{ host: "example.com", verdict: "ok" }] });
  const relayed = await fetch(`${base}/v1/egress-audit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-timestamp": "123",
      "x-signature": VALID_SOURCE_SIGNATURE,
      cookie: "portal_session=must-not-cross",
    },
    body: payload,
  });
  assert.equal(relayed.status, 200);
  const body = (await relayed.json()) as { body: string; headers: Record<string, string> };
  assert.equal(body.body, payload);
  assert.equal(body.headers["x-signature"], VALID_SOURCE_SIGNATURE);
  assert.equal(body.headers.cookie, undefined);
  assert.equal(deploymentLayerRequests, before + 1);

  const read = await fetch(`${base}/v1/egress-audit`, {
    headers: { "x-timestamp": "123", "x-signature": VALID_SOURCE_SIGNATURE },
  });
  assert.equal(read.status, 404);
  assert.equal(deploymentLayerRequests, before + 1, "only the POST is passed through");
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
  const fresh = await fetch(`${base}/api/x`, { headers: { cookie: sessionCookie("U1") } });
  assert.equal(fresh.status, 200);
  assert.doesNotMatch(fresh.headers.get("set-cookie") ?? "", /portal_session=/, "a fresh session is not re-stamped");

  const aged = await fetch(`${base}/api/x`, { headers: { cookie: sessionCookie("U1", 20000) } });
  assert.equal(aged.status, 200);
  const setCookie = aged.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/portal_session=([^;]+)/);
  assert.ok(m, "an aged session is re-stamped through the proxy");
  assert.match(setCookie, new RegExp(`Max-Age=${SESSION_TTL_S}\\b`), "the renewed cookie carries a full TTL");
  const claims = open(decodeURIComponent(m![1] ?? ""), sessionKey) as { sub: string; exp: number } | null;
  assert.equal(claims?.sub, "U1", "the renewed cookie is valid and preserves the sub");
  const twin = aged.headers.getSetCookie().find((cookie) => cookie.startsWith("portal_session_x="));
  assert.ok(twin?.startsWith(`portal_session_x=${m![1]};`), "renewal re-issues the framed twin with the same session");
  assert.match(twin!, /SameSite=Lax/, "the twin falls back to Lax on a non-https origin");
  assert.match(twin!, new RegExp(`Max-Age=${SESSION_TTL_S}\\b`));
  assert.ok(
    (claims?.exp ?? 0) > Math.floor(Date.now() / 1000) + SESSION_TTL_S - 800,
    "exp is pushed out to ~now + full TTL",
  );
});

test("admin status comes from a signed core whoami for the session subject, memoized within the TTL", async () => {
  const before = whoamiProbes;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/auth/impersonate?target=alice@acme`, {
      method: "POST",
      headers: { cookie: sessionCookie("U-fresh-ttl"), origin: PUBLIC },
    });
    assert.equal(r.status, 403);
  }
  assert.equal(whoamiProbes - before, 1, "the sub is probed once then served from the 60s cache");
  assert.equal(lastWhoamiActor, "U-fresh-ttl@acme");
  assert.equal(lastWhoamiSigned, true);
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

test("impersonate: an admin starts it, gets a cookie, and can stop it", async () => {
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

  const stop = await fetch(`${base}/auth/impersonate/stop`, {
    method: "POST",
    headers: { cookie: `${sessionCookie("U-admin")}; ${impCookie}`, origin: PUBLIC },
  });
  assert.equal(stop.status, 200);
  assert.match(stop.headers.get("set-cookie") ?? "", /portal_impersonate=;[^,]*Max-Age=0/);
});

test("the deployment live session forwards both credentials only on its exact route", async () => {
  for (const [method, path] of [["POST", "/v1/deployment/live-session"]]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "x-timestamp": "123",
        "x-signature": VALID_SOURCE_SIGNATURE,
        authorization: "Bearer deployment-only-secret",
        "x-as-principal": "must-not-cross",
        cookie: "portal_session=must-not-cross",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: '{"expectedGeneration":0}' } : {}),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { headers: Record<string, string>; body: string };
    assert.equal(payload.headers.authorization, "Bearer deployment-only-secret");
    assert.equal(payload.headers["x-signature"], VALID_SOURCE_SIGNATURE);
    assert.equal(payload.headers.cookie, undefined);
    assert.equal(payload.headers["x-as-principal"], undefined);
    if (method === "POST") assert.equal(payload.body, '{"expectedGeneration":0}');
  }
  for (const [method, path] of [
    ["GET", "/v1/deployment/live-session"],
    ["POST", "/v1/deployment/live-session/nearby"],
  ]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: "Bearer deployment-only-secret",
        "x-timestamp": "123",
        "x-signature": VALID_SOURCE_SIGNATURE,
      },
    });
    assert.equal(response.status, 404);
  }
});

test("core's readiness, Slack HTTP events and the spend export reach core through the front door", async () => {
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  const events = await fetch(`${base}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": "v0=sig",
      "x-slack-request-timestamp": "123",
      "x-slack-retry-num": "1",
      cookie: "portal_session=x",
    },
    body: '{"type":"event_callback"}',
  });
  assert.equal(events.status, 200);
  const event = (await events.json()) as { headers: Record<string, string>; body: string };
  assert.equal(event.body, '{"type":"event_callback"}');
  assert.equal(event.headers["x-slack-signature"], "v0=sig");
  assert.equal(event.headers["x-slack-retry-num"], "1");
  assert.equal(event.headers.cookie, undefined);
  const spend = await fetch(`${base}/v1/spend/export?from=2026-10-01&to=2026-11-01`, {
    headers: { authorization: "Bearer spend-token" },
  });
  assert.equal(spend.status, 200);
  const exported = (await spend.json()) as { url: string; headers: Record<string, string> };
  assert.equal(exported.url, "/v1/spend/export?from=2026-10-01&to=2026-11-01");
  assert.equal(exported.headers.authorization, "Bearer spend-token");
  const apps = await fetch(`${base}/v1/deployments/export?principalId=alice%40example.com`, {
    headers: { authorization: "Bearer spend-token", cookie: "portal_session=x" },
  });
  assert.equal(apps.status, 200);
  const listed = (await apps.json()) as { url: string; headers: Record<string, string> };
  assert.equal(listed.url, "/v1/deployments/export?principalId=alice%40example.com");
  assert.equal(listed.headers.authorization, "Bearer spend-token");
  assert.equal(listed.headers.cookie, undefined);
  assert.equal((await fetch(`${base}/slack/events`)).status === 200, false);
});

test("deployment git requests reach core with their token and without browser credentials", async () => {
  const refs = await fetch(`${base}/v1/deployments/app-1/git/info/refs?service=git-upload-pack`, {
    headers: { authorization: "Bearer deploy-git-token", cookie: "portal_session=x", "git-protocol": "version=2" },
  });
  assert.equal(refs.status, 200);
  const refsBody = (await refs.json()) as { url: string; headers: Record<string, string> };
  assert.equal(refsBody.url, "/v1/deployments/app-1/git/info/refs?service=git-upload-pack");
  assert.equal(refsBody.headers.authorization, "Bearer deploy-git-token");
  assert.equal(refsBody.headers["git-protocol"], "version=2");
  assert.equal(refsBody.headers.cookie, undefined);
  const pack = await fetch(`${base}/v1/deployments/app-1/git/git-upload-pack`, {
    method: "POST",
    headers: { authorization: "Bearer deploy-git-token", "content-type": "application/x-git-upload-pack-request" },
    body: "0032want",
  });
  assert.equal(pack.status, 200);
  assert.equal(((await pack.json()) as { body: string }).body, "0032want");
  for (const [method, path] of [
    ["POST", "/v1/deployments/app-1/git/info/refs"],
    ["GET", "/v1/deployments/app-1/git/git-upload-pack"],
    ["GET", "/v1/deployments/app-1/git/HEAD"],
    ["GET", "/v1/deployments/app-1/versions"],
  ] as const)
    assert.equal((await fetch(`${base}${path}`, { method })).status, 404, `${method} ${path}`);
});

test("Loop ingress forwards signed events and Google identity without a portal session", async () => {
  const response = await fetch(`${base}/v1/loop-ingress/gmail`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer google-id-token",
      "x-slack-signature": "v0=signature",
      "x-slack-request-timestamp": "123",
    },
    body: JSON.stringify({ message: { data: "test" } }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { cookie: string | null; headers: Record<string, string> };
  assert.equal(body.cookie, null);
  assert.equal(body.headers.authorization, "Bearer google-id-token");
  assert.equal(body.headers["x-slack-signature"], "v0=signature");
  assert.equal((await fetch(`${base}/v1/loop-ingress/gmail`)).status, 404);
  assert.equal((await fetch(`${base}/v1/loop-ingress/gmail/extra`, { method: "POST" })).status, 404);
});

test("an administrator signed in under a linked alias can start impersonation", async () => {
  const start = await fetch(`${base}/auth/impersonate?target=alice@acme`, {
    method: "POST",
    headers: { cookie: sessionCookie("U-admin-alias"), origin: PUBLIC },
  });
  assert.equal(start.status, 200);
  assert.match(start.headers.get("set-cookie") ?? "", /portal_impersonate=[^;]+/);
});
