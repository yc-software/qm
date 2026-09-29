import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { signRequest } from "../../chassis/src/source-auth-sign.ts";

const sourceSecret = "me-startup-source-secret-0123456789";
const identitySecret = "me-startup-identity-secret-0123456789";
const calls: Array<{ path: string; principal?: string; signed: boolean; capability: boolean }> = [];
const capabilities = new Map<string, string>();
let hold = false;
let inboxStatus = 200;
let authStatus = 200;
let permissionsStatus = 200;
let inboxStarted = Promise.withResolvers<void>();
let pendingStarted = Promise.withResolvers<void>();
const held: Array<() => void> = [];
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const core = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const path = new URL(req.url!, "http://core").pathname;
    const raw = req.headers[PORTAL_IDENTITY_HEADER];
    const principal =
      typeof raw === "string"
        ? verifyPortalIdentity(raw, identitySecret, Date.now())?.p
        : capabilities.get(String(req.headers["x-agent-capability"]));
    const expected = signRequest(sourceSecret, Number(req.headers["x-timestamp"]), `${req.method}\n${req.url}\n`);
    calls.push({
      path,
      principal,
      signed: req.headers["x-signature"] === expected,
      capability: !!req.headers["x-agent-capability"],
    });
    if (path === "/v1/session-cap") {
      const token = `test-cap-${capabilities.size}`;
      if (principal) capabilities.set(token, principal);
      return send(res, 200, { token });
    }
    if (path === "/v1/inbox/access") {
      inboxStarted.resolve();
      return send(res, inboxStatus, { enabled: true });
    }
    const reply = () => {
      if (path === "/v1/admin/whoami")
        return send(res, permissionsStatus, { permissions: principal === "admin" ? ["admin"] : [] });
      if (path === "/v1/user-model-auth/status") return send(res, authStatus, { individualModelAuth: false });
      send(res, 200, {});
    };
    if (hold && ["/v1/admin/whoami", "/v1/user-model-auth/status"].includes(path)) {
      held.push(reply);
      if (held.length === 2) pendingStarted.resolve();
    } else reply();
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = sourceSecret;
process.env.PORTAL_IDENTITY_SECRET = identitySecret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
process.env.WEB_UI_PRINCIPALS = "admin,member";
process.env.INBOX_USERS = "admin,member";
process.env.LOOPS_USERS = "admin,member";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = (principal: string, impersonator?: string) => ({
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: principal, ...(impersonator ? { imp: impersonator } : {}), exp: Date.now() + 60000 },
    identitySecret,
  ),
});
after(async () => {
  held.splice(0).forEach((reply) => reply());
  surface.closeAllConnections();
  core.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => surface.close(() => resolve())),
    new Promise<void>((resolve) => core.close(() => resolve())),
  ]);
});

test("/me reads permissions once with the signed request-local portal identity", async () => {
  const before = calls.length;
  const responses = await Promise.all(
    ["admin", "member"].map((principal) =>
      fetch(`${base}/me`, { headers: headers(principal, principal === "member" ? "admin" : undefined) }).then(
        (response) => response.json(),
      ),
    ),
  );
  assert.deepEqual(responses[0].permissions, ["admin", "loops", "inbox"]);
  assert.deepEqual(responses[1].permissions, ["loops", "inbox"]);
  assert.equal(responses[1].impersonatedBy, "admin");
  const own = calls.slice(before);
  assert.equal(own.filter((call) => call.path === "/v1/session-cap").length, 0);
  const permissions = own.filter((call) => call.path === "/v1/admin/whoami");
  assert.equal(permissions.length, 2);
  assert.deepEqual(permissions.map((call) => call.principal).sort(), ["admin", "member"]);
  assert.ok(permissions.every((call) => call.signed && !call.capability));
});

test("/me starts inbox access before pending permission/model-auth responses finish", async () => {
  hold = true;
  inboxStarted = Promise.withResolvers<void>();
  pendingStarted = Promise.withResolvers<void>();
  const response = fetch(`${base}/me`, { headers: headers("admin"), signal: AbortSignal.timeout(10000) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([inboxStarted.promise, pendingStarted.promise]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Inbox access was blocked behind unfinished /me requests")), 5000);
      }),
    ]);
    assert.equal(held.length, 2, "The barrier still owns unfinished startup responses");
  } finally {
    clearTimeout(timer);
    hold = false;
    held.splice(0).forEach((reply) => reply());
    await response.then((res) => res.text());
  }
});

test("/me preserves unavailable auth and fail-closed permission/preview behavior", async () => {
  try {
    inboxStatus = 503;
    permissionsStatus = 403;
    const denied = await fetch(`${base}/me`, { headers: headers("admin") });
    assert.equal(denied.status, 200);
    assert.deepEqual((await denied.json()).permissions, []);
    authStatus = 503;
    const unavailable = await fetch(`${base}/me`, { headers: headers("admin") });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, "unavailable");
  } finally {
    inboxStatus = authStatus = permissionsStatus = 200;
  }
});
