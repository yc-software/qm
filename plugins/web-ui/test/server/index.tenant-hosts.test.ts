import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../chassis/src/portal-identity.ts";
import { setEdgeTenants } from "../../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret } from "../../../chassis/src/tenant-settings.ts";

const coreHosts = new Set<string>();
const stateFeeds = new Map<string, ServerResponse>();
const core = createServer((req, res) => {
  const host = String(req.headers["x-forwarded-host"]);
  if (req.url?.startsWith("/v1/session-state/events") || req.url?.startsWith("/v1/cron-items/events")) {
    res.writeHead(200, { "content-type": "text/event-stream" }).write(": open\n\n");
    if (req.url.startsWith("/v1/session-state/events")) stateFeeds.set(host, res);
    return;
  }
  coreHosts.add(host);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url?.startsWith("/v1/surface-config") ? JSON.stringify({ branding: { selfLabel: `QM ${host}` } }) : "{}");
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const secret = "tenant-host-route-test-secret";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "home-org";
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret;
const { startServer } = await import("../../server/index.ts");
setEdgeTenants([
  {
    slug: "home",
    orgId: "home-org",
    hosts: ["home.example.test"],
    status: "active",
    faviconSvg: `<svg xmlns="http://www.w3.org/2000/svg"><title>home</title></svg>`,
    oidcAdmin: false,
    secrets: {},
  },
  ...(["a", "b"] as const).map((name) => ({
    id: `tenant-${name}`,
    slug: name,
    orgId: `org-${name}`,
    hosts: [`${name}.example.test`],
    status: "active" as const,
    faviconSvg: `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`,
    oidcAdmin: false,
    secrets: {},
  })),
]);
const server = await startServer(0, "127.0.0.1");
while (!coreHosts.has("undefined")) await new Promise((resolve) => setTimeout(resolve, 10));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  setEdgeTenants([]);
  server.closeAllConnections();
  server.close();
  core.closeAllConnections();
  core.close();
});

const identityFor = (host: string): string =>
  mintPortalIdentity(
    { p: "alice@example.com", exp: Date.now() + 60_000 },
    host.startsWith("home.") ? secret : deriveTenantSecret(secret, `tenant-${host[0]}`),
  );

function get(
  host: string,
  path: string,
  signedIn = false,
  identity = identityFor(host),
): Promise<{ status: number; text: string }> {
  const headers = {
    host: "127.0.0.1",
    "x-forwarded-host": host,
    ...(signedIn ? { [PORTAL_IDENTITY_HEADER]: identity } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the web surface answers each tenant's host with that tenant's org, branding and favicon, and the home host with the deployment's own", async () => {
  for (const name of ["a", "b"]) {
    const host = `${name}.example.test`;
    coreHosts.clear();
    const me = await get(host, "/me", true);
    assert.equal(me.status, 200);
    assert.equal((JSON.parse(me.text) as { org: string }).org, `org-${name}`);
    assert.deepEqual([...coreHosts], [host]);
    assert.equal((JSON.parse((await get(host, "/manifest.webmanifest")).text) as { name: string }).name, `QM ${host}`);
    assert.match((await get(host, "/favicon.svg")).text, new RegExp(`<title>${name}</title>`));
  }
  assert.equal((JSON.parse((await get("home.example.test", "/me", true)).text) as { org: string }).org, "home-org");
  assert.match((await get("home.example.test", "/favicon.svg")).text, /\u{1F3F4}/u);
});

test("an identity minted for one tenant is refused on another tenant's host", async () => {
  assert.equal((await get("b.example.test", "/me", true, identityFor("a.example.test"))).status, 401);
  assert.equal((await get("a.example.test", "/me", true, identityFor("home.example.test"))).status, 401);
});

test("the web surface refuses a host outside the tenant directory", async () => {
  const stranger = await get("stranger.example.test", "/me", true);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.text, "unknown host\n");
});

function listen(host: string): { received: string[]; close(): void } {
  const received: string[] = [];
  const identity = identityFor(host);
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/api/session-events",
    headers: { host: "127.0.0.1", "x-forwarded-host": host, [PORTAL_IDENTITY_HEADER]: identity },
  });
  req.on("response", (res) => res.on("data", (chunk: Buffer) => received.push(chunk.toString())));
  req.on("error", () => {});
  req.end();
  return { received, close: () => req.destroy() };
}

test("a tenant's live session updates reach only that tenant's browsers", async () => {
  while (!stateFeeds.has("a.example.test") || !stateFeeds.has("b.example.test"))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const onA = listen("a.example.test");
  const onB = listen("b.example.test");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const frame = { threadRef: "web:alice@example.com:main", state: "running", participants: ["alice@example.com"] };
  stateFeeds.get("a.example.test")!.write(`event: session_state\ndata: ${JSON.stringify(frame)}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  onA.close();
  onB.close();
  assert.match(onA.received.join(""), /event: session_state\ndata: .*"state":"running"/);
  assert.doesNotMatch(onB.received.join(""), /session_state/);
});
