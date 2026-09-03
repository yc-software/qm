import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";

const auditLog = { record() {}, events: async () => [], tail: async () => [] };

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fixture(
  deps: Parameters<typeof createInsecureTestServer>[1],
  upstreamContentType = "text/html; charset=utf-8",
  upstreamHeaders: Record<string, string> = {},
) {
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": upstreamContentType, ...upstreamHeaders });
    res.end("UPSTREAM OK");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "path-serving-")),
  });
  const app = createApp({
    deploy,
    acl: createAclStore(),
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  await app.deploy({
    ownerScopeId: scopeId("personal", "alice@example.com"),
    createdBy: "alice@example.com",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const server = createInsecureTestServer(app, deps);
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    await new Promise<void>((r) => (server as unknown as Server).close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  };
  return { port, close };
}

test("/d/ path serving sandboxes proxied HTML so an app cannot act on the portal's origin", async () => {
  const f = await fixture({});
  try {
    const page = await httpGet(f.port, "/d/mysite/", { "x-as-principal": "alice@example.com" });
    assert.equal(page.status, 200);
    const csp = page.headers["content-security-policy"];
    assert.match(String(csp), /^sandbox /, "proxied HTML carries a sandbox CSP");
    assert.doesNotMatch(String(csp), /allow-same-origin/, "the sandbox must deny the portal origin to app code");
  } finally {
    await f.close();
  }
});

test("/d/ path serving sandboxes every response — content-type spoofing cannot dodge it", async () => {
  const f = await fixture({}, "Text/HTML; charset=utf-8");
  try {
    const data = await httpGet(f.port, "/d/mysite/api", { "x-as-principal": "alice@example.com" });
    assert.equal(data.status, 200);
    assert.match(String(data.headers["content-security-policy"]), /^sandbox /);
  } finally {
    await f.close();
  }
});

test("/d/ path serving strips clear-site-data so an app cannot log its viewers out of the portal", async () => {
  const f = await fixture({}, "text/html", { "clear-site-data": '"cookies", "storage"' });
  try {
    const page = await httpGet(f.port, "/d/mysite/", { "x-as-principal": "alice@example.com" });
    assert.equal(page.status, 200);
    assert.equal(page.headers["clear-site-data"], undefined);
  } finally {
    await f.close();
  }
});

test("subdomain serving stays unsandboxed — each app already has its own origin", async () => {
  const f = await fixture({
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: "portal-session-secret",
    deployAppsLoginUrl: "https://portal.example.com",
  });
  try {
    const page = await httpGet(f.port, "/", { Host: "mysite.apps.example.com", Accept: "text/html" });
    assert.equal(page.status, 302, "signed-out visitors bounce to sign-in, with no sandbox header");
    assert.equal(page.headers["content-security-policy"], undefined);
  } finally {
    await f.close();
  }
});

test("a /d/ document navigation upgrades to the app's subdomain once one is configured", async () => {
  const f = await fixture({
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: "portal-session-secret",
    deployAppsLoginUrl: "https://portal.example.com",
  });
  try {
    const nav = await httpGet(f.port, "/d/mysite/page?a=1", {
      "x-as-principal": "alice@example.com",
      "sec-fetch-dest": "document",
      Accept: "text/html",
    });
    assert.equal(nav.status, 302);
    assert.equal(nav.headers.location, "https://mysite.apps.example.com/page?a=1");

    const sub = await httpGet(f.port, "/d/mysite/app.js", { "x-as-principal": "alice@example.com" });
    assert.equal(sub.status, 200, "subresource fetches keep proxying so open tabs never break");
  } finally {
    await f.close();
  }
});

test("without a subdomain configuration /d/ document navigations proxy in place", async () => {
  const f = await fixture({});
  try {
    const nav = await httpGet(f.port, "/d/mysite/", {
      "x-as-principal": "alice@example.com",
      "sec-fetch-dest": "document",
      Accept: "text/html",
    });
    assert.equal(nav.status, 200);
    assert.equal(nav.body, "UPSTREAM OK");
  } finally {
    await f.close();
  }
});

test("owner-url without a subdomain configuration explains the /d/ path and the enabling env var", async () => {
  const f = await fixture({});
  try {
    const r = await httpGet(f.port, "/v1/deployments/mysite/owner-url?principalId=alice@example.com", {});
    assert.equal(r.status, 503);
    const { message } = JSON.parse(r.body) as { message: string };
    assert.match(message, /\/d\/mysite\//);
    assert.match(message, /DEPLOY_APPS_DOMAIN/);
  } finally {
    await f.close();
  }
});
