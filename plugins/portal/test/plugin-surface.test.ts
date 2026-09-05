import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";

const claimed = new Set<string>();
const upstream = createServer((req: IncomingMessage, res) => {
  if (req.method === "POST" && req.url?.startsWith("/v1/auth/broker/claim")) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    return void req.on("end", () => {
      const { ids } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ids: string[] };
      const winner = ids.find((id) => !claimed.has(id)) ?? null;
      if (winner) claimed.add(winner);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ claimed: winner }));
    });
  }
  if (req.url === "/api/whoami") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: false }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, headers: req.headers }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const surface = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, headers: req.headers }));
});
await new Promise<void>((r) => surface.listen(0, r));
const surfaceUrl = `http://localhost:${(surface.address() as AddressInfo).port}`;

const PUBLIC = "http://portal.test";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = "plugin-surface-portal-secret";
process.env.CORE_SIGNING_SECRET = "plugin-surface-core-secret";
process.env.PORTAL_IDENTITY_SECRET = "plugin-surface-identity-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_PLUGIN_UPSTREAMS = `reports=${surfaceUrl}`;
process.env.PORTAL_PLAYGROUND = "1";
delete process.env.PORTAL_LOCAL_AUTH_BYPASS;

const { server, readPluginUpstreams, isInternalUpstreamUrl } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const sessionKey = deriveKey("plugin-surface-portal-secret", "portal.session.v1");
function sessionCookie(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat: now, exp: now + 28800 }, sessionKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
  surface.close();
});

interface Echo {
  url: string;
  cookie: string | null;
  headers: Record<string, string>;
}

test("a signed-in visitor reaches the plugin surface with the prefix stripped", async () => {
  const r = await fetch(`${base}/reports/monthly?q=1`, { headers: { cookie: sessionCookie("U-alice") } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as Echo;
  assert.equal(body.url, "/monthly?q=1");
  // The legacy principal cookie is named after the surface, as it is for admin.
  assert.match(body.cookie ?? "", /(^|; )reports=U-alice(;|$)/);
  // And the surface gets the signed identity, which is what it should read.
  assert.ok(body.headers["x-portal-identity"], "expected a signed portal identity header");
});

test("the surface root is reachable, not only a subpath", async () => {
  const r = await fetch(`${base}/reports`, { headers: { cookie: sessionCookie("U-alice") } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as Echo).url, "/");
});

test("an unknown first segment still falls through to web-ui, not to a plugin", async () => {
  const r = await fetch(`${base}/reportsx/y`, { headers: { cookie: sessionCookie("U-alice") } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as Echo).url, "/reportsx/y");
});

test("an anonymous playground session is refused the plugin surface", async () => {
  const html = await fetch(`${base}/reports/monthly`, { headers: { accept: "text/html" }, redirect: "manual" });
  // The visit mints an anon session first, then the surface refuses it.
  assert.equal(html.status, 403);
  const json = await fetch(`${base}/reports/monthly`, {
    headers: { cookie: html.headers.getSetCookie().find((c) => c.startsWith("portal_session=")) ?? "" },
  });
  assert.equal(json.status, 403);
  assert.match(((await json.json()) as { message: string }).message, /sign in/);
});

test("no session at all is 401 on a plugin surface, not a pass-through", async () => {
  const r = await fetch(`${base}/reports/monthly`);
  assert.equal(r.status, 401);
});

test("readPluginUpstreams: accepts container aliases and private hosts", () => {
  const { upstreams, problems } = readPluginUpstreams(
    "reports=http://reports:8080/, docs=http://qm-acme-docs.internal:8080",
    "/idp",
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(upstreams, { reports: "http://reports:8080", docs: "http://qm-acme-docs.internal:8080" });
});

test("readPluginUpstreams: an entry the portal cannot honour is a startup problem, never a silent skip", () => {
  const cases: [string, RegExp][] = [
    ["admin=http://x:8080", /route the portal answers itself/],
    ["auth=http://x:8080", /route the portal answers itself/],
    ["web-ui=http://x:8080", /route the portal answers itself/],
    ["v1=http://x:8080", /route the portal answers itself/],
    ["deployments=http://x:8080", /route the portal answers itself/],
    // The broker prefix is reserved from its own variable, not from a constant.
    ["idp=http://x:8080", /route the portal answers itself/],
    ["reports=https://reports.example.com", /deployment's own network/],
    ["reports=http://169.254.169.254/", /deployment's own network/],
    ["reports=file:///etc/passwd", /deployment's own network/],
    ["Reports=http://x:8080", /single lowercase DNS label/],
    ["a/b=http://x:8080", /single lowercase DNS label/],
    ["reports", /must be <path>=<url>/],
    ["=http://x:8080", /must be <path>=<url>/],
  ];
  for (const [raw, expected] of cases) {
    const { upstreams, problems } = readPluginUpstreams(raw, "/idp");
    assert.deepEqual(upstreams, {}, `${raw} must register nothing`);
    assert.equal(problems.length, 1, `${raw} must report exactly one problem, got ${problems.join("; ")}`);
    assert.match(problems[0]!, expected);
  }
});

test("readPluginUpstreams: the same path twice is refused rather than last-wins", () => {
  const { upstreams, problems } = readPluginUpstreams("reports=http://a:8080,reports=http://b:8080", "/idp");
  assert.deepEqual(upstreams, { reports: "http://a:8080" });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /more than once/);
});

test("isInternalUpstreamUrl: a public host is refused however it is spelled", () => {
  for (const url of [
    "https://evil.example.com",
    "http://evil.example.com:8080",
    "http://1.2.3.4:8080",
    "http://[2606:4700::1]",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(isInternalUpstreamUrl(url), false, `${url} must not be an internal upstream`);
  }
  for (const url of ["http://reports:8080", "http://localhost:9000", "http://10.0.0.5", "http://x.flycast"]) {
    assert.equal(isInternalUpstreamUrl(url), true, `${url} must be an internal upstream`);
  }
});

test("boot refuses a plugin upstream the portal cannot honour", () => {
  const run = (value: string) =>
    spawnSync(process.execPath, ["-e", "await import('./src/index.ts').then((m) => m.startServer())"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      env: {
        ...process.env,
        PORTAL_PUBLIC_URL: PUBLIC,
        PORTAL_PLUGIN_UPSTREAMS: value,
        PORTAL_PLAYGROUND: "",
      },
    });
  const bad = run("admin=http://x:8080");
  assert.notEqual(bad.status, 0, "a reserved path must stop the portal from starting");
  assert.match(bad.stderr, /route the portal answers itself/);
  const leaky = run("reports=https://reports.example.com");
  assert.notEqual(leaky.status, 0, "a public upstream must stop the portal from starting");
  assert.match(leaky.stderr, /deployment's own network/);
});
