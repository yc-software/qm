import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { format } from "node:util";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { answerPrincipalLookup } from "./principal-stub.ts";

let whoamiMode: "ok" | "down" | "fail-once" | "malformed" = "ok";
let whoamiRequests = 0;

const upstream = createServer((req: IncomingMessage, res) => {
  if (answerPrincipalLookup(req, res)) return;
  if (req.url === "/api/whoami") {
    whoamiRequests++;
    if (whoamiMode === "down" || (whoamiMode === "fail-once" && whoamiRequests === 1)) {
      res.writeHead(502, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "core_unreachable" }));
    }
    if (whoamiMode === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end("{}");
    }
    const m = (req.headers.cookie ?? "").match(/admin=([^;]+)/);
    const sub = m ? decodeURIComponent(m[1] ?? "") : "";
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: sub.startsWith("U-admin") }));
  }
  if ((req.url ?? "").startsWith("/api/echo-cookie")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
  }
  if ((req.url ?? "").startsWith("/api/reset-mid-stream")) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" });
    res.write("partial");
    setTimeout(() => res.destroy(), 10);
    return;
  }
  if ((req.url ?? "").startsWith("/api/upstream-reset")) return req.socket.destroy();
  if ((req.url ?? "").startsWith("/api/upstream-unavailable")) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unavailable" }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const PUBLIC = "http://portal.test";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "proxy-errors-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "proxy-errors-test-core-secret";
process.env.PORTAL_IDENTITY_SECRET = "proxy-errors-test-identity-secret";
process.env.PORTAL_DEPLOYMENTS_ENABLED = "1";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server, consumeState, consumedStates } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;
const base = `http://localhost:${port}`;

const sessionKey = deriveKey("proxy-errors-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string, name?: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat: now, exp: now + 3600, ...(name ? { name } : {}) }, sessionKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
});

test("the portal forwards the signed-in user's Slack display name to the web surface", async () => {
  const r = await fetch(`${base}/web-ui/api/echo-cookie`, {
    headers: { cookie: sessionCookie("ada@acme.com", "Ada Lovelace") },
  });
  const body = (await r.json()) as { cookie: string | null };
  assert.match(body.cookie ?? "", /webuiuser=ada%40acme\.com/);
  assert.match(body.cookie ?? "", /webuiuser_name=Ada%20Lovelace/);
});

test("no display name on the session means no name cookie is forwarded", async () => {
  const r = await fetch(`${base}/web-ui/api/echo-cookie`, { headers: { cookie: sessionCookie("ada@acme.com") } });
  const body = (await r.json()) as { cookie: string | null };
  assert.doesNotMatch(body.cookie ?? "", /webuiuser_name=/);
});

test("deployment proxy binds source auth and portal identity to the signed-in principal", async () => {
  const r = await fetch(`${base}/d/app/hello?x=1`, { headers: { cookie: sessionCookie("U1") } });
  const body = (await r.json()) as { url: string; headers: Record<string, string> };
  assert.equal(body.url, "/d/app/hello?x=1");
  assert.equal(body.headers["x-as-principal"], "U1");
  assert.match(body.headers["x-signature"] ?? "", /^v0=/);
  assert.equal(
    verifyPortalIdentity(body.headers["x-portal-identity"] ?? "", "proxy-errors-test-identity-secret", Date.now())?.p,
    "U1",
  );
});

test("an upstream reset mid-response does not crash the portal", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await assert.rejects(async () => {
    const r = await fetch(`${base}/web-ui/api/reset-mid-stream`, { headers: { cookie: sessionCookie("U1") } });
    await r.text();
  }, "the truncated body should surface as a fetch error to the client");
  const alive = await fetch(`${base}/healthz`);
  assert.equal(alive.status, 200);
  assert.equal(errors.mock.callCount(), 0);
});

test("a client abort mid-request-body does not crash the portal", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await new Promise<void>((resolve) => {
    const s = connect(port, "localhost", () => {
      s.write(
        `POST /web-ui/api/x HTTP/1.1\r\n` +
          `host: localhost\r\n` +
          `origin: ${PUBLIC}\r\n` +
          `cookie: ${sessionCookie("U1")}\r\n` +
          `content-type: application/json\r\n` +
          `content-length: 100000\r\n\r\n` +
          `{"partial":`,
      );
      setTimeout(() => {
        s.destroy();
        setTimeout(resolve, 50);
      }, 50);
    });
    s.on("error", () => {});
  });
  const alive = await fetch(`${base}/healthz`);
  assert.equal(alive.status, 200);
  assert.equal(errors.mock.callCount(), 0);
});

test("completed portal failures log status, method and duration once without request data", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  for (const [path, status, method] of [
    ["/web-ui/api/upstream-unavailable", 503, "GET"],
    ["/web-ui/api/upstream-reset", 502, "GET"],
    ["/auth/admin-login", 503, "GET"],
    ["/auth/admin-login", 503, "POST"],
  ] as const) {
    const before = errors.mock.callCount();
    const response = await fetch(`${base}${path}?token=private-query`, {
      method,
      headers: { cookie: sessionCookie("private@example.com"), "x-private": "private-header" },
      body: method === "POST" ? "private-body" : undefined,
    });
    await response.text();
    assert.equal(response.status, status);
    assert.equal(errors.mock.callCount(), before + 1);
    assert.match(
      format(...errors.mock.calls.at(-1)!.arguments),
      new RegExp(`^\\[portal\\] ${status} ${method} response \\(\\d+ ms\\)$`),
    );
  }
  for (const path of ["/healthz", "/api/unauthenticated"]) {
    const before = errors.mock.callCount();
    const response = await fetch(`${base}${path}`);
    await response.text();
    assert.ok(response.status < 500);
    assert.equal(errors.mock.callCount(), before);
  }
  const before = errors.mock.callCount();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(base, { path: "http://[" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 500);
  assert.equal(errors.mock.callCount(), before + 1);
});

test("a prototype-chain segment like /constructor/ never matches a keyed surface (no 500, falls to the web UI)", async () => {
  for (const p of ["/constructor/x", "/hasOwnProperty/x", "/toString/x", "/__proto__/x"]) {
    const r = await fetch(`${base}${p}`, { headers: { cookie: sessionCookie("U1") } });
    assert.equal(r.status, 200, `expected the web-ui proxy for ${p}, got ${r.status}`);
    assert.equal(((await r.json()) as { url: string }).url, p);
  }
});

test("a transient admin-probe failure is retried before denying access", async () => {
  whoamiRequests = 0;
  whoamiMode = "fail-once";
  const ok = await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U-admin-transient") } });
  assert.equal(ok.status, 200);
  assert.equal(whoamiRequests, 2);
  whoamiMode = "ok";
});

test("an admin-probe outage is reported as unavailable and is NOT negative-cached", async () => {
  whoamiMode = "down";
  const denied = await fetch(`${base}/admin/`, {
    headers: { cookie: sessionCookie("U-admin-outage"), accept: "text/html" },
  });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /temporarily unavailable/i, "an outage must not read as 'you are not an admin'");

  whoamiMode = "ok";
  const ok = await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie("U-admin-outage") } });
  assert.equal(ok.status, 200);
});

test("a malformed admin verdict fails readiness instead of being cached as non-admin", async () => {
  whoamiMode = "malformed";
  const denied = await fetch(`${base}/admin/`, {
    headers: { cookie: sessionCookie("U-admin-malformed"), accept: "text/html" },
  });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /temporarily unavailable/i);
  whoamiMode = "ok";
});

test("consumeState: single-use, TTL-bounded, never wholesale-wiped", () => {
  assert.equal(consumeState("state-a"), true);
  assert.equal(consumeState("state-a"), false, "a consumed state cannot be replayed");
  const exp = consumedStates.get("state-a");
  assert.ok(
    exp !== undefined && exp <= Date.now() + 600_000,
    `replay is gated on the cookie's own wall clock (exp=${exp})`,
  );
  const remaining = consumedStates.getRemainingTTL("state-a");
  assert.ok(
    remaining > 0 && remaining <= 1_200_000,
    `consumed state must lapse after its tmp cookie is dead (ttl=${remaining})`,
  );
  assert.equal(consumeState("state-b"), true);
  for (let i = 0; i < 5000; i++) consumeState(`flood-${i}`);
  assert.equal(consumeState("state-b"), false, "a live state survives a flood of other states");
});
