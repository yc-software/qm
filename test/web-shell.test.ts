import "./support/auto-fake-sprites.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { orgScope } from "../src/config.ts";
import type { ScopeId } from "../src/types.ts";
import { resolveBranding } from "../src/resolution/branding.ts";
import { withTenant } from "../src/tenants/context.ts";
import { noteTenantAppHandle } from "../src/tenants/settings.ts";
import { createWebShell, type WebReleases } from "../src/web/shell.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

function releaseFiles(files: Record<string, string | Buffer>): WebReleases {
  const read = (name: string) => (files[name] === undefined ? undefined : Buffer.from(files[name]));
  return {
    live: async () => "release-a1",
    async document(name) {
      const body = read(name);
      if (!body) throw new Error(`fixture release has no ${name}`);
      return body.toString("utf8");
    },
    async file(path, gzip) {
      const packed = gzip ? read(`${path}.gz`) : undefined;
      if (packed) return { body: Readable.from(packed), gzip: true };
      const plain = read(path);
      return plain ? { body: Readable.from(plain), gzip: false } : null;
    },
  };
}

const asset = `export const filler = ${JSON.stringify("x".repeat(50)).repeat(200)};\n`;
const release = releaseFiles({
  "index.html":
    '<!doctype html><html><head><meta name="brand-self-label" content="Agent" /></head><body></body></html>',
  "shared.html": '<html><body><script id="shared-transcript" type="application/json">\n null\n</script></body></html>',
  "assets/app-Aa1.js": asset,
  "assets/app-Aa1.js.gz": gzipSync(Buffer.from(asset)),
});
const env = {
  WEB_UI_ANALYTICS: JSON.stringify({ module: "https://cdn.example.com/a.js", connect: ["https://events.example.com"] }),
  SENTRY_BROWSER_DSN: "https://public@errors.example.com/1",
};
const config = testConfig({
  signingSecret: "web-shell-signing-secret-0123456789abcdef",
  publicWebUrl: "https://qm.test",
});
const built = stopAtEnd(buildApp(config));
const shell = createWebShell(
  { ...config, publicPort: 0, deployAppsDomain: "apps.example.com" },
  env,
  () => resolveBranding(built.config, orgScope() as ScopeId),
  release,
);
const core = createServer(built.app, {
  ...serverDeps(config, built),
  ...browserSessionDeps,
  web: { events: {} as never, me: { suggestedActivities: [] }, shell },
});
const front = createHttpServer((req, res) => void shell.serve(req, res));
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
after(() => Promise.all([core, front].map((s) => new Promise<void>((resolve) => s.close(() => resolve())))));
const coreBase = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
const frontBase = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

function raw(path: string, headers: Record<string, string> = {}, base = frontBase) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (resolve, reject) => {
      request(`${base}${path}`, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      })
        .on("error", reject)
        .end();
    },
  );
}

test("the app document carries the org's branding, the security headers and a CSP admitting configured origins", async () => {
  await built.config.setBranding(orgScope() as ScopeId, { accent: "#f0652f", mark: "Y", selfLabel: "QM" });
  for (const path of ["/", "/settings/keychain", "/index.html"]) {
    const page = await raw(path);
    assert.equal(page.status, 200, path);
    const html = page.body.toString();
    assert.match(html, /--brand-accent:#f0652f/);
    assert.match(html, /<meta name="brand-self-label" content="QM"\s*\/?>/);
    assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(page.headers["cache-control"], "no-cache");
    const csp = String(page.headers["content-security-policy"]);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' https:\/\/cdn\.example\.com/);
    assert.match(csp, /connect-src 'self' https:\/\/events\.example\.com https:\/\/errors\.example\.com/);
    assert.match(csp, /frame-ancestors 'self';/);
  }
  const manifest = JSON.parse((await raw("/manifest.webmanifest")).body.toString()) as { name: string };
  assert.equal(manifest.name, "QM");
});

test("the app document and signed-in API responses name the live web UI release", async () => {
  assert.match((await raw("/")).body.toString(), /<meta name="qm-release" content="release-a1" \/>/);
  const anonymous = await fetch(`${coreBase}/me`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("x-qm-release"), null);
  const signedIn = await fetch(`${coreBase}/api/contexts`, { headers: { cookie: browserSessionCookie("alice") } });
  assert.equal(signedIn.headers.get("x-qm-release"), "release-a1");
});

test("the app-edit page may be framed by its own app's subdomain only", async () => {
  const framed = await raw("/app-edit?slug=notes");
  assert.equal(framed.status, 200);
  assert.equal(framed.headers["x-frame-options"], undefined);
  assert.match(String(framed.headers["content-security-policy"]), /frame-ancestors 'self' notes\.apps\.example\.com;/);
  const bogus = await raw("/app-edit?slug=evil.example.com%20x");
  assert.equal(bogus.headers["x-frame-options"], "SAMEORIGIN");
  assert.match(String(bogus.headers["content-security-policy"]), /frame-ancestors 'self';/);
});

test("a company with an app handle admits the handle-prefixed host its app links use", async () => {
  const tenanted = createHttpServer(
    (req, res) =>
      void withTenant(randomUUID(), async () => {
        noteTenantAppHandle("acme");
        await shell.serve(req, res);
      }),
  );
  await new Promise<void>((resolve) => tenanted.listen(0, "127.0.0.1", resolve));
  after(() => new Promise<void>((resolve) => tenanted.close(() => resolve())));
  const base = `http://127.0.0.1:${(tenanted.address() as AddressInfo).port}`;
  const framed = await raw("/app-edit?slug=notes", {}, base);
  assert.equal(framed.headers["x-frame-options"], undefined);
  assert.match(
    String(framed.headers["content-security-policy"]),
    /frame-ancestors 'self' acme-notes\.apps\.example\.com;/,
  );
});

test("assets stream from their precompressed sibling or the raw file, and paths stay inside the release", async () => {
  const packed = await raw("/assets/app-Aa1.js", { "accept-encoding": "gzip" });
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.equal(packed.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(gunzipSync(packed.body).toString(), asset);
  const plain = await raw("/assets/app-Aa1.js");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString(), asset);
  assert.equal((await raw("/assets/missing.js")).status, 404);
  assert.equal((await raw("/assets/..%5c..%5cpackage.json")).status, 403);
  assert.equal((await raw("/x%ZZ.js")).status, 400);
  assert.equal((await raw("/x%00.js")).status, 404);
  assert.equal((await raw("/api/anything")).status, 404);
});

async function seedShare(token: string, audience: "internal" | "external"): Promise<void> {
  const session = await built.sessions.getOrCreateByThread(`web:alice:${token}`, "dm", "personal:alice");
  await built.sessions.addParticipant(session.id, "alice", "Share me");
  await built.sessionShares.putIfAbsent(token, {
    token,
    sessionId: session.id,
    audience,
    createdBy: "alice",
    createdAt: 1,
    messages: [
      { role: "assistant", text: '<script>alert("secret")</script></script><script src="/evil.js"></script>& $&' },
    ],
    files: [],
  });
}

test("share pages render the frozen snapshot from core for their audience only", async () => {
  await seedShare("11111111-1111-4111-8111-111111111111", "internal");
  await seedShare("22222222-2222-4222-8222-222222222222", "external");
  const internal = await fetch(`${coreBase}/share/internal/11111111-1111-4111-8111-111111111111`, {
    headers: { cookie: browserSessionCookie("bob") },
  });
  assert.equal(internal.status, 200, await internal.clone().text());
  const html = await internal.text();
  assert.ok(html.includes("\\u003cscript>"));
  assert.equal(html.includes('<script>alert("secret")</script>'), false);
  assert.equal(html.includes('<script src="/evil.js">'), false);
  const snapshot = html.match(/<script id="shared-transcript" type="application\/json">([\s\S]*?)<\/script>/);
  assert.deepEqual(JSON.parse(snapshot![1]!).messages, [
    { role: "assistant", text: '<script>alert("secret")</script></script><script src="/evil.js"></script>& $&' },
  ]);
  assert.equal(internal.headers.get("cache-control"), "no-store");
  assert.equal(internal.headers.get("referrer-policy"), "no-referrer");
  assert.equal(internal.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(internal.headers.get("content-security-policy")!, /default-src 'none'.*connect-src 'none'/);
  assert.equal((await fetch(`${coreBase}/share/internal/11111111-1111-4111-8111-111111111111`)).status, 401);
  const external = await fetch(`${coreBase}/share/external/22222222-2222-4222-8222-222222222222`);
  assert.equal(external.status, 200);
  assert.match(await external.text(), /shared-transcript/);
  const wrongAudience = await fetch(`${coreBase}/share/external/11111111-1111-4111-8111-111111111111`);
  assert.equal(wrongAudience.status, 404);
  assert.match(await wrongAudience.text(), /<script id="shared-transcript" type="application\/json">null<\/script>/);
  assert.equal(
    (await fetch(`${coreBase}/share/external/22222222-2222-4222-8222-222222222222/files/missing`)).status,
    404,
  );
});
