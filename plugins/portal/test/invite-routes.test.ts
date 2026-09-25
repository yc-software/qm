import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import { INVITE_LOGIN_SCRIPT, INVITE_LOGIN_SCRIPT_HASH } from "../src/invite-login.ts";
import { deriveKey, openSession } from "../src/session.ts";

const coreSecret = "invite-route-core-secret";
const sessionSecret = "invite-route-session-secret";
const origin = "http://127.0.0.1:19997";
const requests: { path: string; body: string; signature: string | undefined; timestamp: string | undefined }[] = [];
const upstream = createServer((req, res) => {
  void (async () => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (new URL(req.url!, "http://core.test").pathname !== "/v1/auth/invitations/redeem") {
      res.end("{}");
      return;
    }
    requests.push({
      path: req.url!,
      body,
      signature: req.headers["x-signature"] as string | undefined,
      timestamp: req.headers["x-timestamp"] as string | undefined,
    });
    const { token } = JSON.parse(body);
    if (token === "disconnected") return req.socket.destroy();
    const statusByToken: Record<string, number> = { valid: 200, revoked: 403, unavailable: 503 };
    res.statusCode = statusByToken[token] ?? 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(token === "valid" ? { email: "teammate@example.test" } : { error: token }));
  })().catch((error) => {
    res.statusCode = 500;
    res.end(String(error));
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: sessionSecret,
  CORE_SIGNING_SECRET: coreSecret,
  CORE_ORG_ID: "invite-test",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  ADMIN_UPSTREAM: upstreamUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  upstream.close();
});

function redeem(token: string, requestOrigin: string | null = origin) {
  return fetch(`${base}/auth/invite`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(requestOrigin ? { origin: requestOrigin } : {}),
    },
    body: new URLSearchParams({ token }),
  });
}

test("GET shows an explicit confirmation without redeeming query-string tokens", async () => {
  const before = requests.length;
  const response = await fetch(`${base}/auth/invite?token=valid`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(response.headers.get("content-security-policy")?.includes(`script-src '${INVITE_LOGIN_SCRIPT_HASH}'`));
  const html = await response.text();
  assert.match(html, /action="\/auth\/invite"/);
  assert.match(html, /id="invite-confirm"[^>]*disabled/);
  assert.ok(html.includes(INVITE_LOGIN_SCRIPT));
  assert.equal(requests.length, before);
});

test("fragment script removes the token from browser history and waits for confirmation", () => {
  const token = `header.${Buffer.from(JSON.stringify({ email: "teammate@example.test" })).toString("base64url")}.signature`;
  const elements: Record<string, { textContent?: string; value?: string; disabled?: boolean }> = {
    "invite-status": {},
    "invite-token": {},
    "invite-confirm": { disabled: true },
  };
  const replacements: unknown[][] = [];
  runInNewContext(INVITE_LOGIN_SCRIPT, {
    location: { hash: `#token=${token}`, pathname: "/auth/invite" },
    history: { replaceState: (...args: unknown[]) => replacements.push(args) },
    document: { getElementById: (id: string) => elements[id] },
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    atob,
  });
  assert.deepEqual(replacements, [[null, "", "/auth/invite"]]);
  assert.equal(elements["invite-status"]!.textContent, "Sign in as teammate@example.test");
  assert.equal(elements["invite-token"]!.value, token);
  assert.equal(elements["invite-confirm"]!.disabled, false);
});

test("redemption signs the core request and issues a session for the verified teammate", async () => {
  const response = await redeem("valid");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const request = requests.at(-1)!;
  assert.equal(new URL(request.path, upstreamUrl).pathname, "/v1/auth/invitations/redeem");
  assert.equal(request.body, JSON.stringify({ token: "valid" }));
  assert.equal(
    request.signature,
    signRequest(coreSecret, Number(request.timestamp), canonicalPayload("POST", request.path, request.body)),
  );
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("portal_session="))!;
  const token = sessionCookie.split(";")[0]!.slice("portal_session=".length);
  const session = openSession(token, deriveKey(sessionSecret, "portal.session.v1"), Date.now(), "invite-test");
  assert.equal(session?.sub, "teammate@example.test");
  assert.ok(session?.auth);
  assert.match(sessionCookie, /HttpOnly/);
  assert.ok(cookies.some((cookie) => /^portal_impersonate=;.*Max-Age=0/.test(cookie)));
});

test("cross-origin and missing-origin redemption never reaches core", async () => {
  const before = requests.length;
  for (const requestOrigin of ["https://attacker.example", null]) {
    const response = await redeem("valid", requestOrigin);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(requests.length, before);
});

test("missing and oversized tokens never reach core", async () => {
  const before = requests.length;
  for (const token of ["", "x".repeat(4097)]) {
    const response = await redeem(token);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(requests.length, before);
});

test("invalid, revoked, and unavailable invitations fail without creating sessions", async () => {
  for (const [token, status] of [
    ["invalid", 400],
    ["revoked", 400],
    ["unavailable", 503],
    ["disconnected", 503],
  ] as const) {
    const response = await redeem(token);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("location"), null);
    assert.match(
      await response.text(),
      status === 503 ? /temporarily unavailable/ : /expired, revoked, or already used/,
    );
  }
});
