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

function answer(req: IncomingMessage, body: string): unknown {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const tenant = req.headers["x-qm-tenant"];
  if (path.startsWith("/v1/operator/hosts/")) {
    const host = decodeURIComponent(path.split("/").at(-1) ?? "");
    return { tenant: HOSTS[host] ?? null, multi: true };
  }
  if (path === "/v1/sessions") return { sessions: [{ title: `recent of ${String(tenant)}` }] };
  if (path === "/v1/directory/meta") return { workspaceUrl: `https://${String(tenant)}.slack.example` };
  if (path === "/v1/surface-config") return tenant === TENANT_A ? { welcomeCohort: "S26", orgId: "org-a" } : {};
  if (path.startsWith("/v1/connectors/oauth/") || path === "/v1/composio/authorize" || path.startsWith("/v1/admin/"))
    return {
      query: Object.fromEntries(new URL(req.url ?? "/", "http://core").searchParams),
      body,
      actor: req.headers["x-admin-actor"],
    };
  return {};
}

const core = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => (body += chunk));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer(req, body)));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.PORTAL_IDENTITY_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.WEB_UI_WELCOME_COHORT = "F26";
process.env.WEB_UI_PUBLIC_URL = "https://shared.example";
process.env.CORE_ORG_ID = "shared-org";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const port = (surface.address() as AddressInfo).port;

test.after(() => {
  surface.close();
  core.close();
});

function call(host: string, path: string, tenant?: string, body?: unknown): Promise<{ status: number; body: string }> {
  const identity = mintPortalIdentity(
    { p: "alice", exp: Date.now() + 60_000, ...(tenant ? { t: tenant } : {}) },
    SECRET,
  );
  return new Promise((resolve, reject) => {
    const headers = {
      host,
      [PORTAL_IDENTITY_HEADER]: identity,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
    const req = request({ port, path, method: body === undefined ? "GET" : "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
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
    const page = await call("web-ui.internal", "/api/sessions");
    assert.equal(page.status, 421);
    assert.equal(JSON.parse(page.body).error, "unknown_host");
  } finally {
    rmSync(join(dir, name), { force: true });
  }
});

test("the welcome cohort comes from the tenant's settings, falling back to the deployment's", async () => {
  const a = await call("a.example", "/me");
  const b = await call("b.example", "/me");
  assert.equal(JSON.parse(a.body).welcomeCohort, "S26");
  assert.equal(JSON.parse(b.body).welcomeCohort, "F26");
});

test("the account's org is the tenant's own org, falling back to the deployment's", async () => {
  assert.equal(JSON.parse((await call("a.example", "/me")).body).org, "org-a");
  assert.equal(JSON.parse((await call("b.example", "/me")).body).org, "shared-org");
});

test("admin requests act as the tenant's org", async () => {
  const a = await call("a.example", "/api/admin/users");
  const b = await call("b.example", "/api/admin/users");
  assert.equal(JSON.parse(a.body).actor, "alice@org-a");
  assert.equal(JSON.parse(b.body).actor, "alice@shared-org");
});

test("connector and Composio callbacks return to the company's own host", async () => {
  const oauth = JSON.parse(
    (await call("a.example", "/api/connectors/gmail/start", undefined, { returnTo: "/settings" })).body,
  );
  assert.equal(oauth.query.redirectUri, "https://a.example/v1/connectors/oauth/gmail/callback");
  assert.equal(oauth.query.returnTo, "/settings");
  const state = "s".repeat(24);
  const composio = await call("b.example", "/api/composio/authorize", undefined, {
    toolkit: "gmail",
    returnTo: "/settings",
    state,
  });
  assert.equal(
    JSON.parse(JSON.parse(composio.body).body).callbackUrl,
    `https://b.example/settings?composioReturn=${state}`,
  );
});
