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

const { derivedCookieDomain, bootChecks } = await import("../src/index.ts");

test.after(() => {
  upstream.close();
});

test("the cookie domain derives only when the apps domain sits under the portal host", () => {
  assert.equal(derivedCookieDomain("qm.example.com", "apps.qm.example.com"), "qm.example.com");
  assert.equal(derivedCookieDomain("Example.com", "APPS.example.COM"), "example.com");
  assert.equal(
    derivedCookieDomain("portal.example.com", "apps.example.com"),
    undefined,
    "sibling layouts need an explicit PORTAL_COOKIE_DOMAIN — guessing a shared parent risks landing on a public suffix",
  );
  assert.equal(
    derivedCookieDomain("portal.foo.co.uk", "apps.bar.co.uk"),
    undefined,
    "no public-suffix list needed: only the portal host itself, a domain the operator demonstrably controls, is derived",
  );
  assert.equal(
    derivedCookieDomain("localhost", "apps.localhost"),
    undefined,
    "a single-label host is never a cookie domain",
  );
  assert.equal(derivedCookieDomain("", "apps.example.com"), undefined);
  assert.equal(derivedCookieDomain("example.com", "appsXexample.com"), undefined, "dot-boundary required");
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
  assert.match(r.stderr, /not a subdomain of the portal host/);
});
