import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, verifyPortalIdentity } from "../../../chassis/src/portal-identity.ts";

const identitySecret = "admin-api-identity-secret-0123456789";
const signingSecret = "admin-api-core-secret-0123456789";

interface CoreCall {
  path: string;
  query: URLSearchParams;
  actor: string | undefined;
  principal: string | undefined;
  body: string;
}

const calls: CoreCall[] = [];

const core = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://core");
  const chunks: Buffer[] = [];
  for await (const chunk of req as IncomingMessage) chunks.push(chunk as Buffer);
  const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
  calls.push({
    path: url.pathname,
    query: url.searchParams,
    actor: header("x-admin-actor"),
    principal: verifyPortalIdentity(header("x-portal-identity") ?? "", identitySecret, Date.now())?.p,
    body: Buffer.concat(chunks).toString("utf8"),
  });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(url.pathname === "/v1/blobs" ? { blobId: "blob-1" } : { ok: true }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = signingSecret;
process.env.PORTAL_IDENTITY_SECRET = identitySecret;
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
const { handler } = await import("../../server/index.ts");
const server = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  core.close();
});

const identity = (claims: { p: string; imp?: string } = { p: "admin@example.com" }) => ({
  "x-portal-identity": mintPortalIdentity({ ...claims, exp: Date.now() + 60_000 }, identitySecret),
});
const bytes = Buffer.from("hello, file");
const sha = createHash("sha256").update(bytes).digest("hex");
const hops = (since: number) => calls.slice(since).filter((c) => c.path !== "/v1/surface-config");

test("an admin upload stages the bytes as a blob, then registers the file as the admin", async () => {
  const before = calls.length;
  const query = new URLSearchParams({ scope: "personal:U1", sha, name: "notes é.txt" });
  const response = await fetch(`${base}/api/admin/files/upload?${query}`, {
    method: "POST",
    headers: { ...identity(), "content-type": "text/plain" },
    body: bytes,
  });
  assert.equal(response.status, 200);
  const [stage, register] = hops(before);
  assert.equal(stage!.path, "/v1/blobs");
  assert.equal(stage!.body, "hello, file");
  assert.equal(register!.path, "/v1/admin/files/upload");
  assert.equal(register!.query.get("scope"), "personal:U1");
  assert.equal(register!.actor, "admin@example.com@acme");
  assert.equal(register!.principal, "admin@example.com");
  assert.deepEqual(JSON.parse(register!.body), { name: "notes é.txt", mimetype: "text/plain", blobId: "blob-1" });
  const missing = await fetch(`${base}/api/admin/files/upload?sha=${sha}`, {
    method: "POST",
    headers: identity(),
    body: bytes,
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).message, "scope required");
});

test("an admin upload is refused before any core hop while impersonating or signed out", async () => {
  const before = calls.length;
  const query = new URLSearchParams({ scope: "org:acme", sha });
  const impersonating = await fetch(`${base}/api/admin/files/upload?${query}`, {
    method: "POST",
    headers: identity({ p: "target@example.com", imp: "admin@example.com" }),
    body: bytes,
  });
  assert.deepEqual(
    [impersonating.status, await impersonating.json()],
    [403, { message: "Admin pages are unavailable while impersonating." }],
  );
  const signedOut = await fetch(`${base}/api/admin/files/upload?${query}`, { method: "POST", body: bytes });
  assert.equal(signedOut.status, 401);
  assert.deepEqual(hops(before), []);
});
