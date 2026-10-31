import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { answerFeatures } from "./core-features.ts";
import { canonicalPayload, signRequest, TENANT_HEADER } from "../../chassis/src/source-auth-sign.ts";
const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

let lastMemory: { url: string; portalHeader: string | undefined; tenant?: string; signedForTenant?: boolean } | null =
  null;
const core = createServer((req: IncomingMessage, res) => {
  if (answerFeatures(req, res, { alice: ["web_ui"] })) return;
  const u = req.url ?? "";
  if (u.startsWith("/v1/memory")) {
    const tenant = req.headers[TENANT_HEADER] as string | undefined;
    const signature = signRequest(
      SECRET,
      Number(req.headers["x-timestamp"]),
      canonicalPayload(req.method ?? "", u, "", tenant),
    );
    lastMemory = {
      url: u,
      portalHeader: req.headers[PORTAL_IDENTITY_HEADER] as string | undefined,
      tenant,
      signedForTenant: req.headers["x-signature"] === signature,
    };
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ content: "" }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => core.listen(0, r));

const SECRET = "signed-identity-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("verifies the portal identity for the local principal and forwards the token to core", async () => {
  const token = mintPortalIdentity({ t: TEST_TENANT, p: "alice", exp: Date.now() + 60_000 }, SECRET);
  const r = await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
  assert.equal(r.status, 200);
  assert.match(lastMemory?.url ?? "", /principalId=alice/);
  assert.equal(lastMemory?.portalHeader, token);
});

test("each request carries its identity's tenant to core under the source signature", async () => {
  for (const tenant of [TEST_TENANT, OTHER_TENANT, TEST_TENANT]) {
    const token = mintPortalIdentity({ t: tenant, p: "alice", exp: Date.now() + 60_000 }, SECRET);
    const r = await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
    assert.equal(r.status, 200);
    assert.equal(lastMemory?.tenant, tenant);
    assert.equal(lastMemory?.signedForTenant, true);
  }
});

test("rejects a correctly signed identity that names no tenant or a malformed one", async () => {
  for (const t of [undefined, "acme", "00000000-0000-4000-8000-00000000000A"]) {
    const claims = { ...(t === undefined ? {} : { t }), p: "alice", exp: Date.now() + 60_000 };
    const token = mintPortalIdentity(claims as Parameters<typeof mintPortalIdentity>[0], SECRET);
    const r = await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
    assert.equal(r.status, 401, `tenant ${String(t)} must not authenticate`);
  }
});

test("rejects an identity signed with the wrong key", async () => {
  const forged = mintPortalIdentity({ t: TEST_TENANT, p: "alice", exp: Date.now() + 60_000 }, "attacker-key");
  const r = await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: forged } });
  assert.equal(r.status, 401);
});

test("rejects an unsigned identity and a payload swapped under a valid signature", async () => {
  const claims = Buffer.from(JSON.stringify({ p: "alice", exp: Date.now() + 60_000 }), "utf8").toString("base64url");
  assert.equal(
    (await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: `${claims}.x` } })).status,
    401,
  );

  const signature = mintPortalIdentity({ t: TEST_TENANT, p: "bob", exp: Date.now() + 60_000 }, SECRET).split(".")[1];
  const spliced = `${claims}.${signature}`;
  assert.equal((await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: spliced } })).status, 401);
});

test("rejects an expired identity signed with the right key", async () => {
  const stale = mintPortalIdentity({ t: TEST_TENANT, p: "alice", exp: Date.now() - 1_000 }, SECRET);
  const r = await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: stale } });
  assert.equal(r.status, 401);
});

test("rejects a bare webuiuser cookie when source auth is configured", async () => {
  const r = await fetch(`${base}/api/memory`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 401);
});

test("rejects when neither a portal identity nor a cookie is present", async () => {
  assert.equal((await fetch(`${base}/api/memory`)).status, 401);
});
