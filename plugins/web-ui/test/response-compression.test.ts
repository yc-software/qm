import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const SECRET = "web-ui-compression-test";

const sessionsPayload = JSON.stringify({
  sessions: Array.from({ length: 200 }, (_, i) => ({
    id: `sess-${i}`,
    title: "a repetitive session title that gzip should collapse",
    surface: "web",
    updatedAt: 1_700_000_000_000 + i,
  })),
});

const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end((req.url ?? "").startsWith("/v1/sessions") ? sessionsPayload : "{}");
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web", "assets");
const assetName = "compression-fixture-Aa1Bb2Cc.js";
const assetPath = join(assetsDir, assetName);
const assetBody = `export const filler = ${JSON.stringify("x".repeat(50)).repeat(200)};\n`;
mkdirSync(assetsDir, { recursive: true });
writeFileSync(assetPath, assetBody);
writeFileSync(`${assetPath}.gz`, gzipSync(Buffer.from(assetBody), { level: 9 }));

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
  rmSync(assetPath, { force: true });
  rmSync(`${assetPath}.gz`, { force: true });
});

function identityHeaders(): Record<string, string> {
  return { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET) };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function get(path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the session list is gzipped for a gzip-capable client and decodes to the identical bytes", async () => {
  const packed = await get("/api/sessions", { ...identityHeaders(), "accept-encoding": "gzip" });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.equal(packed.headers["vary"], "accept-encoding");
  assert.ok(packed.body.length < sessionsPayload.length / 4, `expected real compression, got ${packed.body.length}`);
  assert.equal(gunzipSync(packed.body).toString("utf8"), sessionsPayload);
});

test("the session list is byte-identical and uncompressed without accept-encoding", async () => {
  const plain = await get("/api/sessions", identityHeaders());
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), sessionsPayload);
});

test("a static asset is served from its precompressed sibling, byte-identical once decoded", async () => {
  const packed = await get(`/assets/${assetName}`, { "accept-encoding": "gzip, deflate, br" });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.equal(packed.headers["vary"], "accept-encoding");
  assert.equal(packed.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(packed.headers["content-type"], "text/javascript; charset=utf-8");
  assert.ok(packed.body.length < assetBody.length / 4);
  assert.equal(gunzipSync(packed.body).toString("utf8"), assetBody);
});

test("a static asset falls back to the raw file when the client cannot accept gzip", async () => {
  const plain = await get(`/assets/${assetName}`, { "accept-encoding": "identity" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), assetBody);
});

test("the delivery event stream still streams incrementally instead of buffering behind a compressor", async () => {
  const first = await new Promise<{ headers: IncomingMessage["headers"]; chunk: string }>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/deliveries/events`,
      { headers: { ...identityHeaders(), "accept-encoding": "gzip" } },
      (res) => {
        res.setEncoding("utf8");
        res.once("data", (chunk: string) => {
          resolve({ headers: res.headers, chunk });
          req.destroy();
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
    req.end();
    setTimeout(() => reject(new Error("no stream data arrived within 5s")), 5_000).unref();
  });
  assert.equal(first.headers["content-encoding"], undefined);
  assert.equal(first.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(first.headers["cache-control"], "no-cache, no-transform");
  assert.equal(first.chunk, ": open\n\n");
});
