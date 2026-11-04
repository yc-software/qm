import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { signedForwardedHost } from "../../chassis/src/forwarded-host.ts";

const SECRET = "external-share-host-test";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const HOSTS: Record<string, string> = { "a.example": TENANT_A, "b.example": TENANT_B };
const SHARE = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const SHARE_PATH = `/share/external/${SHARE}/files/${FILE}`;

// Core serves a share row only to its own tenant once a tenant is claimed, as withRowTenant does.
const core = createServer((req, res) => {
  req.resume();
  const path = (req.url ?? "").split("?")[0] ?? "";
  const tenant = req.headers["x-qm-tenant"];
  if (path.startsWith("/v1/operator/hosts/")) {
    const host = decodeURIComponent(path.split("/").at(-1) ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ tenant: HOSTS[host] ?? null, multi: true }));
  }
  if (path === `/v1/public-shares/${SHARE}/files/${FILE}`) {
    if (tenant !== undefined && tenant !== TENANT_A) {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "not_found" }));
    }
    res.writeHead(200, { "content-type": "text/plain" });
    return void res.end(`file of ${String(tenant)}`);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.PORTAL_IDENTITY_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const port = (surface.address() as AddressInfo).port;

test.after(() => {
  surface.close();
  core.close();
});

function call(headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, path: SHARE_PATH, headers: { host: "web-ui.internal", ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const signedFor = (host: string, secret = SECRET) => signedForwardedHost(secret, host, "GET", SHARE_PATH);

test("an external share link works on its own tenant's host", async () => {
  const own = await call(signedFor("a.example"));
  assert.equal(own.status, 200);
  assert.equal(own.body, `file of ${TENANT_A}`);
});

test("an external share link is not served on another tenant's host", async () => {
  const other = await call(signedFor("b.example"));
  assert.equal(other.status, 404);
  assert.doesNotMatch(other.body, /file of/);
});

test("an unsigned or forged forwarded host is never trusted for an external share", async () => {
  const unsigned = await call({ "x-forwarded-host": "a.example" });
  assert.equal(unsigned.status, 421);
  const forged = await call(signedFor("a.example", "not-the-secret"));
  assert.equal(forged.status, 421);
  const unknown = await call(signedFor("stranger.example"));
  assert.equal(unknown.status, 421);
});
