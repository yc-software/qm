import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

interface RecordedBlob {
  sha: string;
  bytes: number;
}
const blobUploads: RecordedBlob[] = [];

const core = createServer((req: IncomingMessage, res) => {
  const u = req.url ?? "";
  if (req.method === "POST" && u.startsWith("/v1/blobs")) {
    const sha = String(req.headers["x-content-sha256"] ?? "");
    let size = 0;
    req.on("data", (c: Buffer) => (size += c.length));
    return void req.on("end", () => {
      blobUploads.push({ sha, bytes: size });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blobId: `blob-${sha.slice(0, 8)}`, sizeBytes: size }));
    });
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

const SECRET = "blob-route-test-secret";
process.env.CORE_API_URL = coreUrl;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");

const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const IDENTITY = {
  cookie: "webuiuser=alice",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET),
};

test("POST /api/blobs streams the body to core with the declared sha and relays { blobId, sizeBytes }", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const before = blobUploads.length;
  const r = await fetch(`${base}/api/blobs?sha=${sha}`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/octet-stream" },
    body: bytes,
  });
  assert.equal(r.status, 200, "a >1 MB upload streams through without 413");
  const json = (await r.json()) as { blobId: string; sizeBytes: number };
  assert.equal(json.blobId, `blob-${sha.slice(0, 8)}`, "core's blobId is relayed verbatim");
  assert.equal(json.sizeBytes, bytes.length);
  const recorded = blobUploads.slice(before);
  assert.equal(recorded.length, 1, "exactly one blob reached core");
  assert.equal(recorded[0]!.sha, sha, "the declared sha is forwarded to core (source-auth signs over it)");
  assert.equal(recorded[0]!.bytes, bytes.length, "all bytes streamed through, not capped");
});

test("POST /api/blobs rejects a missing/invalid sha with 400 (never reaches core)", async () => {
  const before = blobUploads.length;
  const r = await fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/octet-stream" },
    body: Buffer.from("hi"),
  });
  assert.equal(r.status, 400);
  assert.equal(blobUploads.length, before, "no blob reached core when the sha is absent");
});

test("POST /api/blobs requires a signed-in user (401 before any core call)", async () => {
  const before = blobUploads.length;
  const sha = createHash("sha256").update("x").digest("hex");
  const r = await fetch(`${base}/api/blobs?sha=${sha}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from("x"),
  });
  assert.equal(r.status, 401, "unauthenticated upload is denied");
  assert.equal(blobUploads.length, before, "no upload forwarded for an unauthenticated request");
});

test("the sha rides as a query param (portal-safe): a custom header is NOT how the surface reads it", async () => {
  const before = blobUploads.length;
  const sha = createHash("sha256").update("y").digest("hex");
  const r = await fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { ...IDENTITY, "content-type": "application/octet-stream", "x-content-sha256": sha },
    body: Buffer.from("y"),
  });
  assert.equal(r.status, 400, "a header-only sha is ignored — the route reads the query param");
  assert.equal(blobUploads.length, before, "no blob reached core for a header-only sha");
});
