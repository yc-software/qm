import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/api/app.ts";
import { createServer } from "../../src/api/server.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createDirectoryStore } from "../../src/directory/directory-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../../src/sessions/memory-session-store.ts";
import { mintPortalIdentity } from "../../src/auth/portal-identity.ts";
import { signRequest } from "../../src/auth/source-auth.ts";
import { mintAppSession } from "../../src/deploy/app-session.ts";
import { createMemoryReplayDedupe, type ReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { scopeId } from "../../src/types.ts";

export const secret = "core-origin-test-secret-".repeat(3);
const portalSecret = "portal-identity-origin-secret";
export const gateSecret = "app-gateway-origin-secret";
export const portal = "https://portal.example.test";
const auditLog = { record() {}, events: async () => [], tail: async () => [] };
type Response = { status: number; headers: IncomingHttpHeaders; body: string };

export async function fixture(
  t: TestContext,
  mode: "configured" | "local" | "missing" = "configured",
  replay?: ReplayDedupe,
  omitProduction = false,
) {
  const seen: { path: string; headers: IncomingHttpHeaders; method: string; body: string }[] = [];
  const upstream = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ path: req.url!, headers: req.headers, method: req.method!, body: Buffer.concat(chunks).toString() });
    res.writeHead(req.url?.startsWith("/redirect") ? 302 : 200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=31536000",
      "access-control-allow-origin": String(req.headers.origin ?? "https://sibling.apps.example.test"),
      "access-control-allow-credentials": "true",
      "cdn-cache-control": "public, max-age=31536000",
      "surrogate-control": "public, max-age=31536000",
      ...(req.url?.startsWith("/redirect") ? { location: "/next?q=a%20b" } : {}),
      "set-cookie": [
        "app_pref=ok; Domain=.example.test; Path=/; SameSite=Lax",
        "app_other=yes; Domain=apps.localhost; HttpOnly; Path=/deep",
        "__Host-qm_app_session=evil; Secure; Path=/",
        "qm_app_session=evil; Path=/",
        "__Host-qm_app_challenge=evil; Path=/; Secure",
        "__Host-portal_session=evil; Path=/; Secure",
        "dpl_owner=evil; Path=/",
        "qm_idp_session=evil; Path=/",
        "__Host-qm_idp_session=evil; Secure; Path=/",
        "portal_session=evil; Domain=example.test; Path=/",
      ],
    });
    res.end(JSON.stringify(seen.at(-1)));
  });
  upstream.listen(0);
  await new Promise<void>((r) => upstream.once("listening", r));
  const dir = mkdtempSync(join(tmpdir(), "core-origin-"));
  const identity = createIdentityService();
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    acl,
    auditLog,
    deployDir: dir,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port }),
      destroy: async () => {},
    },
  });
  const app = createApp({
    deploy,
    acl,
    identity,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    name: "alpha",
    createdBy: "owner",
    ownerScopeId: scopeId("personal", "owner"),
    entrypoint: "x",
    files: [],
  });
  await app.deploy({
    name: "beta",
    createdBy: "owner",
    ownerScopeId: scopeId("personal", "owner"),
    entrypoint: "x",
    files: [],
  });
  await app.shareDeployment(d.id, scopeId("personal", "viewer"), "read", { createdBy: "owner" });
  const retiredConfig = { deployAppsSessionSecret: "legacy-secret" };
  const server = createServer(app, {
    ...retiredConfig,
    signingSecret: secret,
    portalIdentitySecret: portalSecret,
    capabilitySecret: "separate-capability-secret",
    requireSignedPortalIdentity: true,
    production: omitProduction ? undefined : mode !== "local",
    identity,
    deployAppsOrgId: "acme",
    replayDedupe: replay ?? { ...createMemoryReplayDedupe(), durable: mode !== "local" },
    ...(mode === "configured" ? { deployAppsDomain: "apps.example.test", deployGateSecret: gateSecret } : {}),
    deployAppsLoginUrl: portal,
  });
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  const launchActors = new WeakMap<Response, string>();
  let nonce = 0;
  const launch = async (
    principal = "viewer",
    path = "/d/alpha/deep?q=a%20b&x=%2f&x=+",
    method = "GET",
    headers: Record<string, string> = {},
  ) => {
    const wirePath = path + (path.includes("?") ? "&" : "?") + `_sourceAuthNonce=${++nonce}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await send(
      wirePath,
      {
        "x-as-principal": principal,
        "x-qm-launch-origin": portal,
        "x-portal-identity": await mintPortalIdentity({ p: principal, exp: Date.now() + 60_000 }, portalSecret),
        "x-timestamp": String(timestamp),
        "x-signature": signRequest(secret, timestamp, `${method}\n${wirePath}\n${principal}`),
        ...headers,
      },
      method,
    );
    launchActors.set(response, principal);
    return response;
  };
  const atApp = async (r: Response, cookie = "") => {
    assert.equal(r.status, 302, r.body);
    const u = new URL(String(r.headers.location));
    return send(u.pathname + u.search, { host: u.host, ...(cookie ? { cookie } : {}) });
  };
  const cookieOf = (r: Response, name: string) =>
    r.headers["set-cookie"]?.find((c) => c.startsWith(name + "="))?.split(";", 1)[0] ?? "";
  const begin = async (principal = "viewer", path = "/d/alpha/deep?q=a%20b&x=%2f&x=+", sourceOrigin = portal) => {
    const initial = await launch(principal, path, "GET", { "x-qm-launch-origin": sourceOrigin });
    assert.equal(initial.status, 302, initial.body);
    assert.equal(new URL(String(initial.headers.location)).pathname, "/__qm/start");
    const start = await atApp(initial);
    assert.equal(start.status, 302, start.body);
    const source = new URL(String(start.headers.location));
    assert.equal(source.origin, sourceOrigin);
    assert.equal(source.pathname, `/d/${d.id}/`);
    assert.ok(source.searchParams.get("_qm_challenge"));
    return { initial, start, source, challenge: cookieOf(start, "__Host-qm_app_challenge") };
  };
  const complete = async (principal = "viewer", path?: string, sourceOrigin = portal) => {
    const b = await begin(principal, path, sourceOrigin);
    const ticket = await launch(principal, b.source.pathname + b.source.search, "GET", {
      "x-qm-launch-origin": sourceOrigin,
    });
    const done = await atApp(ticket, b.challenge);
    return { ...b, ticket, done, cookie: cookieOf(done, "__Host-qm_app_session") };
  };
  const redeem = async (r: Response, overrideHost?: string) => {
    const initial = new URL(String(r.headers.location));
    const base = { origin: initial.origin, host: initial.host };
    const start = await send(initial.pathname + initial.search, { host: overrideHost ?? initial.host });
    if (start.status !== 302) return { ...start, ...base, cookie: "" };
    const source = new URL(String(start.headers.location));
    const callback = await launch(launchActors.get(r) ?? "viewer", source.pathname + source.search, "GET", {
      "x-qm-launch-origin": source.origin,
    });
    if (callback.status !== 302) return { ...callback, ...base, cookie: "" };
    const done = await atApp(callback, cookieOf(start, "__Host-qm_app_challenge"));
    return { ...done, ...base, cookie: cookieOf(done, "__Host-qm_app_session") };
  };
  const origin = mode === "local" ? `http://${d.id}.apps.localhost:${port}` : `https://${d.id}.apps.example.test`;
  const session = async (sub = "viewer", overrides: Record<string, unknown> = {}) => {
    const now = Date.now();
    return (
      "__Host-qm_app_session=" +
      (await mintAppSession(gateSecret, {
        type: "session",
        sub,
        orgId: "acme",
        deploymentId: d.id,
        origin,
        iat: now,
        exp: now + 60_000,
        ...overrides,
      }))
    );
  };
  return {
    app,
    d,
    identity,
    port,
    seen,
    send,
    launch,
    redeem,
    atApp,
    begin,
    complete,
    cookieOf,
    session,
    origin,
    host: new URL(origin).host,
  };
}
