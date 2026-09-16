import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { createHmac } from "node:crypto";
import { scopeId } from "../src/types.ts";

const auditLog = { record() {}, events: async () => [], tail: async () => [] };
const GATE_SECRET = "gate-secret";
const PORTAL = "https://portal.example.com";

function appServingUpstream(upstreamPort: number) {
  const deployStore = createDeployStore();
  const acl = createAclStore();
  const directory = createDirectoryStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    canReadScope: createCanReadScope({ directory }),
    canWriteScope: createCanWriteScope({ directory }),
    deployDir: mkdtempSync(join(tmpdir(), "app-shell-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory,
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
    orgId: "acme",
  } as unknown as Parameters<typeof createApp>[0]);
  return { app, directory };
}

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

async function widgetFixture(upstreamHandler?: Parameters<typeof createHttpServer>[1]) {
  const upstream = createHttpServer(
    upstreamHandler ??
      ((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>APP</body></html>");
      }),
  );
  upstream.listen(0);
  await new Promise((r) => upstream.once("listening", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const { app, directory } = appServingUpstream(upstreamPort);
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "mysite",
    createdInScope: scopeId("channel", "CBUILT"),
  });
  await app.shareDeployment(d.id, scopeId("personal", "U-viewer"), "read", { createdBy: "U1" });
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: GATE_SECRET,
    deployAppsLoginUrl: PORTAL,
    deployAppsSessionSecret: "portal-session-secret",
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  return { app, directory, port, close };
}

const HOST = "mysite.apps.example.com";
function mintPortalSession(sub: string, expiresInSeconds = 3600): string {
  const key = createHmac("sha256", "portal-session-secret").update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + expiresInSeconds }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
const viewerCookie = () => `portal_session=${mintPortalSession("U-viewer")}`;
test("app shell: a normal signed-in manager gets the shell without an edit link", async () => {
  const f = await widgetFixture();
  try {
    const page = await httpGet(f.port, "/", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      "Sec-Fetch-Dest": "document",
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /__qmAppShell/, "the owner's top-level document load gets the shell");
    assert.match(page.body, /<iframe id="app" src="\/"/, "the app renders inside a same-origin frame");
    const portalLine = page.body.match(/const portal = (".*?");/)?.[1];
    assert.equal(portalLine && JSON.parse(portalLine), PORTAL, "the chat column knows the portal origin");
    assert.doesNotMatch(page.body, /APP<\/body>/, "the shell is served without touching the upstream");
  } finally {
    await f.close();
  }
});

test("app shell: the frame's own load (sec-fetch-dest: iframe) proxies the app untouched", async () => {
  const f = await widgetFixture();
  try {
    const page = await httpGet(f.port, "/", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      "Sec-Fetch-Dest": "iframe",
    });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<html><body>APP</body></html>", "the app's own HTML is byte-identical");
  } finally {
    await f.close();
  }
});

test("app shell: the frame src preserves the requested path and query", async () => {
  const f = await widgetFixture();
  try {
    const page = await httpGet(f.port, "/reports/q3?tab=2", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      "Sec-Fetch-Dest": "document",
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /<iframe id="app" src="\/reports\/q3\?tab=2"/, "deep links land inside the frame");
  } finally {
    await f.close();
  }
});

test("app shell: a client without fetch metadata gets the raw app, never a nested shell", async () => {
  const f = await widgetFixture();
  try {
    const page = await httpGet(f.port, "/", { Host: HOST, Cookie: `portal_session=${mintPortalSession("U1")}` });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<html><body>APP</body></html>", "no sec-fetch-dest means a straight proxy");
  } finally {
    await f.close();
  }
});

test("app shell: a plain visitor (granted, signed in) gets untouched HTML and no shell endpoints", async () => {
  const f = await widgetFixture();
  try {
    const page = await httpGet(f.port, "/", { Host: HOST, Cookie: viewerCookie(), "Sec-Fetch-Dest": "document" });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<html><body>APP</body></html>", "no shell for a non-owner");
  } finally {
    await f.close();
  }
});

test("app shell: the owner version endpoint reports the applied version", async () => {
  const f = await widgetFixture();
  try {
    const version = await httpGet(f.port, "/__claw__/version", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
    });
    assert.equal(version.status, 200);
    assert.equal(JSON.parse(version.body).version, 1, "the applied version is reported");
  } finally {
    await f.close();
  }
});

test("app shell: an owner's XHR/fetch HTML fragment is not shelled (sec-fetch-dest gate)", async () => {
  const f = await widgetFixture();
  try {
    const frag = await httpGet(f.port, "/fragment", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      "Sec-Fetch-Dest": "empty",
    });
    assert.equal(frag.status, 200);
    assert.doesNotMatch(frag.body, /__qmAppShell/, "a non-document HTML load is left untouched");
  } finally {
    await f.close();
  }
});

test("app shell: a 206 partial HTML response streams byte-exact through the frame", async () => {
  const f = await widgetFixture((_req, res) => {
    res.writeHead(206, { "content-type": "text/html", "content-range": "bytes 0-9/32" });
    res.end("<html></h");
  });
  try {
    const r = await httpGet(f.port, "/", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      "Sec-Fetch-Dest": "iframe",
    });
    assert.equal(r.status, 206);
    assert.equal(r.body, "<html></h", "a range slice stays byte-exact");
  } finally {
    await f.close();
  }
});

test("app shell: a non-owner request to /__claw__/ falls through to the app, not a gateway 404", async () => {
  const f = await widgetFixture((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`APP SAW ${req.url}`);
  });
  try {
    const r = await httpGet(f.port, "/__claw__/version", { Host: HOST, Cookie: viewerCookie() });
    assert.equal(r.status, 200, "the app's own path space is not shadowed for non-owners");
    assert.match(r.body, /APP SAW \/__claw__\/version/);
  } finally {
    await f.close();
  }
});

test("app shell: forged and expired sessions cannot activate the shell", async () => {
  const f = await widgetFixture();
  try {
    for (const token of [mintPortalSession("U1") + "forged", mintPortalSession("U1", -1)]) {
      const page = await httpGet(f.port, "/", {
        Host: HOST,
        Cookie: `portal_session=${token}`,
        "Sec-Fetch-Dest": "document",
      });
      assert.equal(page.status, 401);
      assert.doesNotMatch(page.body, /__qmAppShell/);
    }
  } finally {
    await f.close();
  }
});

test("app shell: an old owner cookie cannot override the signed-in viewer", async () => {
  const f = await widgetFixture();
  try {
    const page = await httpGet(f.port, "/", {
      Host: HOST,
      Cookie: `dpl_owner=old-token; ${viewerCookie()}`,
      "Sec-Fetch-Dest": "document",
    });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /__qmAppShell/);
  } finally {
    await f.close();
  }
});

test("app shell: non-HTML responses stream through untouched even for the owner", async () => {
  const f = await widgetFixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "13" });
    res.end('{"data":true}');
  });
  try {
    const r = await httpGet(f.port, "/api/data", { Host: HOST, Cookie: `portal_session=${mintPortalSession("U1")}` });
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"data":true}', "JSON is byte-identical");
    assert.equal(r.headers["content-length"], "13", "content-length survives the proxy");
  } finally {
    await f.close();
  }
});

test("app shell: an app cannot plant the owner cookie on its visitors", async () => {
  const f = await widgetFixture((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": ["dpl_owner=forged; Path=/", "app_pref=ok; Path=/"],
    });
    res.end("<html></html>");
  });
  try {
    const r = await httpGet(f.port, "/", { Host: HOST, Cookie: viewerCookie() });
    const cookies = ([] as string[]).concat((r.headers["set-cookie"] as string[] | string) ?? []).join("\n");
    assert.doesNotMatch(cookies, /dpl_owner/, "the gateway strips an app-minted dpl_owner");
    assert.match(cookies, /app_pref=ok/, "the app's own cookies still flow");
  } finally {
    await f.close();
  }
});

test("app shell: manage grants are checked on every navigation and version request", async () => {
  const f = await widgetFixture();
  try {
    await f.app.shareDeployment("mysite", scopeId("personal", "U-viewer"), "write", { createdBy: "U1" });
    const page = await httpGet(f.port, "/", { Host: HOST, Cookie: viewerCookie(), "Sec-Fetch-Dest": "document" });
    assert.match(page.body, /__qmAppShell/);
    await f.app.shareDeployment("mysite", scopeId("personal", "U-viewer"), "read", { createdBy: "U1" });
    const revoked = await httpGet(f.port, "/", { Host: HOST, Cookie: viewerCookie(), "Sec-Fetch-Dest": "document" });
    assert.doesNotMatch(revoked.body, /__qmAppShell/);
    const version = await httpGet(f.port, "/__claw__/version", { Host: HOST, Cookie: viewerCookie() });
    assert.equal(version.body, "<html><body>APP</body></html>");
  } finally {
    await f.close();
  }
});

test("app shell: a manager from the creation scope can load the app and its assets without a read grant", async () => {
  const f = await widgetFixture();
  try {
    await f.directory.replaceChannels(
      [{ channelId: "CBUILT", name: "builders", isPrivate: true }],
      [{ channelId: "CBUILT", principalId: "U2" }],
    );
    assert.equal(await f.app.canManageDeployment("mysite", "U2"), true);
    assert.equal((await f.app.reachDeployment("mysite", "U2")).status, "denied");
    const headers = { Host: HOST, Cookie: `portal_session=${mintPortalSession("U2")}` };
    const page = await httpGet(f.port, "/", { ...headers, "Sec-Fetch-Dest": "document" });
    assert.match(page.body, /__qmAppShell/);
    for (const dest of ["iframe", "script", "empty"]) {
      const resource = await httpGet(f.port, "/asset", { ...headers, "Sec-Fetch-Dest": dest });
      assert.equal(resource.status, 200);
      assert.equal(resource.body, "<html><body>APP</body></html>");
    }
    await f.directory.replaceChannels([{ channelId: "CBUILT", name: "builders", isPrivate: true }], []);
    const denied = await httpGet(f.port, "/", headers);
    assert.equal(denied.status, 403);
  } finally {
    await f.close();
  }
});

test("app shell: normal sign-in keeps editing available beyond the old five-minute window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = await widgetFixture();
  try {
    const headers = { Host: HOST, Cookie: `portal_session=${mintPortalSession("U1")}`, "Sec-Fetch-Dest": "document" };
    const first = await httpGet(f.port, "/", headers);
    assert.match(first.body, /__qmAppShell/);
    t.mock.timers.tick(6 * 60 * 1000);
    const later = await httpGet(f.port, "/reports?view=week", headers);
    assert.equal(later.status, 200);
    assert.match(later.body, /__qmAppShell/);
    const version = await httpGet(f.port, "/__claw__/version", headers);
    assert.equal(JSON.parse(version.body).version, 1);
    t.mock.timers.tick(60 * 60 * 1000);
    assert.equal((await httpGet(f.port, "/", headers)).status, 401);
  } finally {
    await f.close();
  }
});

test("app shell: bare escape renders frame-denying apps at top level without forwarding the shell parameter", async () => {
  let appRequestPath: string | undefined;
  const f = await widgetFixture((req, res) => {
    appRequestPath = req.url;
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    });
    res.end("APP");
  });
  try {
    const page = await httpGet(f.port, "/?__qm_no_shell=1&filter=recent", {
      Host: HOST,
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      "sec-fetch-dest": "document",
    });
    assert.equal(page.status, 200);
    assert.equal(page.body, "APP");
    assert.equal(appRequestPath, "/?filter=recent");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["content-security-policy"], "frame-ancestors 'none'");
  } finally {
    await f.close();
  }
});
