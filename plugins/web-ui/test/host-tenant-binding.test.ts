import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const SECRET = "host-tenant-binding-test";
const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b2";
const HOSTS: Record<string, string> = { "a.example": TENANT_A, "b.example": TENANT_B };

function answer(req: IncomingMessage): unknown {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const tenant = req.headers["x-qm-tenant"];
  if (path.startsWith("/v1/operator/hosts/")) {
    const host = decodeURIComponent(path.split("/").at(-1) ?? "");
    return { tenant: HOSTS[host] ?? null, multi: true };
  }
  if (path === "/v1/sessions") return { sessions: [{ title: `recent of ${String(tenant)}` }] };
  if (path === "/v1/directory/meta") return { workspaceUrl: `https://${String(tenant)}.slack.example` };
  return {};
}

const core = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(answer(req)));
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

function call(host: string, path: string, tenant?: string): Promise<{ status: number; body: string }> {
  const identity = mintPortalIdentity(
    { p: "alice", exp: Date.now() + 60_000, ...(tenant ? { t: tenant } : {}) },
    SECRET,
  );
  return new Promise((resolve, reject) => {
    const req = request({ port, path, headers: { host, [PORTAL_IDENTITY_HEADER]: identity } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("each tenant's host sees only its own recents", async () => {
  const a = await call("a.example", "/api/sessions");
  const b = await call("b.example", "/api/sessions");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.match(a.body, new RegExp(`recent of ${TENANT_A}`));
  assert.match(b.body, new RegExp(`recent of ${TENANT_B}`));
  assert.doesNotMatch(b.body, new RegExp(TENANT_A));
});

test("the account answer is cached per tenant, never shared across hosts", async () => {
  const a = await call("a.example", "/me");
  const b = await call("b.example", "/me");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(JSON.parse(a.body).slackWorkspaceUrl, `https://${TENANT_A}.slack.example`);
  assert.equal(JSON.parse(b.body).slackWorkspaceUrl, `https://${TENANT_B}.slack.example`);
});

test("a sign-in minted for one tenant is refused on another tenant's host", async () => {
  const crossed = await call("b.example", "/api/sessions", TENANT_A);
  assert.equal(crossed.status, 421);
  assert.doesNotMatch(crossed.body, new RegExp(TENANT_A));
  const own = await call("b.example", "/api/sessions", TENANT_B);
  assert.match(own.body, new RegExp(`recent of ${TENANT_B}`));
});

test("a host with no live tenant is refused", async () => {
  const gone = await call("gone.example", "/api/sessions");
  assert.equal(gone.status, 421);
  assert.equal(JSON.parse(gone.body).error, "unknown_host");
});

test("hashed static assets are served for a host with no tenant, other paths are still refused", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web", "assets");
  const name = `host-tenant-asset-${process.pid}.js`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "export const ok = 1;\n");
  try {
    const asset = await call("web-ui.internal", `/assets/${name}`);
    assert.equal(asset.status, 200);
    assert.match(asset.body, /export const ok = 1;/);
    for (const missing of ["/assets/foo", "/assets/missing.js"]) {
      const absent = await call("web-ui.internal", missing);
      assert.equal(absent.status, 404);
      assert.doesNotMatch(absent.body, /<html/i);
    }
    const page = await call("web-ui.internal", "/api/sessions");
    assert.equal(page.status, 421);
    assert.equal(JSON.parse(page.body).error, "unknown_host");
  } finally {
    rmSync(join(dir, name), { force: true });
  }
});
