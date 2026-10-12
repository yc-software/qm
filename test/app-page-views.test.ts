import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";
import type { FeatureFlagStore } from "../src/feature-flags.ts";
import type { AppPageView, AppPageViewLog } from "../src/deploy/page-views.ts";

const SESSION_SECRET = "portal-session-secret";
const LOGIN_URL = "https://portal.example.com";
const HOST = "mysite.apps.example.com";
const auditLog = { record() {}, events: async () => [], tail: async () => [] };

function session(sub: string, appOnly?: true): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600, ...(appOnly ? { appOnly } : {}) }),
  ).toString("base64url");
  return `portal_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "localhost", port, path, method: "GET", headers: { Host: HOST, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function harness(log: AppPageViewLog) {
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("UPSTREAM OK");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const acl = createAclStore();
  const deploy = createDeployService({
    externalSharingAllowed: async () => true,
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "page-views-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  const deployed = await app.deploy({
    ownerScopeId: scopeId("personal", "alice@example.com"),
    createdBy: "alice@example.com",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const server = createInsecureTestServer(app, {
    featureFlags: { enabled: async () => true } as unknown as FeatureFlagStore,
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: LOGIN_URL,
    appPageViews: log,
  });
  server.listen(0);
  return {
    app,
    deploymentId: (deployed as { id: string }).id,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("page loads of a published app are recorded with viewer, auth mode and request basics", async () => {
  const views: AppPageView[] = [];
  const h = await harness({ record: async (view) => void views.push(view) });
  try {
    const owner = await get(h.port, "/reports?token=secret", {
      Accept: "text/html",
      Cookie: session("alice@example.com"),
      "User-Agent": "test-agent/1",
      "x-qm-app-host": "1",
      "x-qm-client-ip": "203.0.113.7",
    });
    assert.equal(owner.status, 200);
    await settle();
    assert.equal(views.length, 1);
    const [view] = views;
    assert.equal(view!.deploymentId, h.deploymentId);
    assert.equal(view!.viewer, "alice@example.com");
    assert.equal(view!.authMode, "signed_in");
    assert.equal(view!.path, "/reports", "the query string is never stored");
    assert.equal(view!.ip, "203.0.113.7");
    assert.equal(view!.userAgent, "test-agent/1");
    assert.equal(typeof view!.version, "number");
    assert.ok(Math.abs(view!.at - Date.now()) < 10_000);

    const assetHeaders: Record<string, string>[] = [
      { Accept: "*/*", "Sec-Fetch-Dest": "script" },
      { Accept: "application/json" },
      { Accept: "text/html", "Sec-Fetch-Dest": "image" },
    ];
    for (const headers of assetHeaders) {
      const asset = await get(h.port, "/app.js", { ...headers, Cookie: session("alice@example.com") });
      assert.equal(asset.status, 200);
    }
    await settle();
    assert.equal(views.length, 1, "static assets and API calls are not page views");

    await get(h.port, "/", { Accept: "text/html", Cookie: session("mallory@example.com") });
    await get(h.port, "/", { Accept: "text/html" });
    await settle();
    assert.equal(views.length, 1, "denied and signed-out requests that never reach the app are not recorded");

    await h.app.setDeploymentPublic("mysite", true, { createdBy: "alice@example.com" });
    await get(h.port, "/", { Accept: "text/html", "x-qm-client-ip": "198.51.100.9" });
    await get(h.port, "/", { Accept: "text/html", Cookie: session("mallory@example.com") });
    await get(h.port, "/", { Accept: "text/html", Cookie: session("guest@example.org", true) });
    await settle();
    assert.deepEqual(
      views.slice(1).map((v) => [v.viewer, v.authMode]),
      [
        [null, "public"],
        ["mallory@example.com", "public"],
        ["guest@example.org", "app_only"],
      ],
    );
    assert.notEqual(views[1]!.ip, "198.51.100.9", "a client IP header is only trusted from the app gateway");
  } finally {
    await h.close();
  }
});

test("the owner's framed shell counts once, not again for the inner app frame", async () => {
  const views: AppPageView[] = [];
  const h = await harness({ record: async (view) => void views.push(view) });
  try {
    const shell = await get(h.port, "/", {
      Accept: "text/html",
      "Sec-Fetch-Dest": "document",
      Cookie: session("alice@example.com"),
    });
    assert.equal(shell.status, 200);
    const inner = await get(h.port, "/", {
      Accept: "text/html",
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Site": "same-origin",
      Cookie: session("alice@example.com"),
    });
    assert.equal(inner.status, 200);
    await settle();
    assert.equal(views.length, 1);
    assert.equal(views[0]!.authMode, "signed_in");
  } finally {
    await h.close();
  }
});

test("a failing page-view log never blocks the page and is reported", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  const h = await harness({ record: async () => Promise.reject(new Error("db down")) });
  try {
    const page = await get(h.port, "/", { Accept: "text/html", Cookie: session("alice@example.com") });
    assert.equal(page.status, 200);
    assert.equal(page.body, "UPSTREAM OK");
    await settle();
    assert.ok(errors.some((line) => line.includes("app page view log") && line.includes("db down")));
  } finally {
    console.error = original;
    await h.close();
  }
});
