import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "https://qm.example.com";
process.env.PORTAL_SESSION_SECRET = "apps-domain-defaults-portal-secret";
process.env.CORE_SIGNING_SECRET = "apps-domain-defaults-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
delete process.env.PORTAL_APPS_DOMAIN;
delete process.env.PORTAL_COOKIE_DOMAIN;
process.env.DEPLOY_APPS_DOMAIN = "apps.qm.example.com";

const { commonParentDomain, bootChecks } = await import("../src/index.ts");

test.after(() => {
  upstream.close();
});

test("commonParentDomain finds the deepest shared dot-suffix, never a bare TLD", () => {
  assert.equal(commonParentDomain("qm.example.com", "apps.qm.example.com"), "qm.example.com");
  assert.equal(commonParentDomain("portal.example.com", "apps.example.com"), "example.com");
  assert.equal(commonParentDomain("example.com", "apps.example.com"), "example.com");
  assert.equal(commonParentDomain("a.example.com", "b.other.net"), undefined);
  assert.equal(commonParentDomain("a.example.com", "b.acme.com"), undefined, "a bare TLD is not a cookie domain");
  assert.equal(commonParentDomain("", "apps.example.com"), undefined);
});

test("DEPLOY_APPS_DOMAIN alone yields a working portal apps setup — cookie domain derived, boot clean", () => {
  assert.doesNotThrow(() => bootChecks());
});

test("an apps domain that shares no parent with the portal host refuses to boot with a cookie-domain explanation", () => {
  const command = "import('./src/index.ts').then(m => m.bootChecks())";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", command], {
    cwd: process.cwd(),
    env: { ...process.env, DEPLOY_APPS_DOMAIN: "apps.unrelated.net" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /shares no parent domain/);
});
