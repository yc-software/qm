import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { releaseFiles } from "./release-fixture.ts";
import { gunzipSync, gzipSync } from "node:zlib";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { sendBuffered } from "../../chassis/src/http.ts";

const SECRET = "web-ui-compression-test";

const relayedPayload = JSON.stringify({
  sessions: Array.from({ length: 200 }, (_, i) => ({
    id: `sess-${i}`,
    title: "a repetitive session title that gzip should collapse",
    surface: "web",
    updatedAt: 1_700_000_000_000 + i,
  })),
});

const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  sendBuffered(
    res,
    200,
    { "content-type": "application/json" },
    (req.url ?? "").startsWith("/v1/composio/slack") ? relayedPayload : "{}",
  );
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const assetName = "compression-fixture-Aa1Bb2Cc.js";
const assetBody = `export const filler = ${JSON.stringify("x".repeat(50)).repeat(200)};\n`;

const { handler, serveReleasesFrom } = await import("../server/index.ts");
serveReleasesFrom(
  releaseFiles({
    [`assets/${assetName}`]: assetBody,
    [`assets/${assetName}.gz`]: gzipSync(Buffer.from(assetBody), { level: 9 }),
  }),
);
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
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

test("a relayed core read is gzipped for a gzip-capable client and decodes to the identical bytes", async () => {
  const packed = await get("/api/composio/slack", { ...identityHeaders(), "accept-encoding": "gzip" });
  assert.equal(packed.status, 200);
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.equal(packed.headers["vary"], "accept-encoding");
  assert.ok(packed.body.length < relayedPayload.length / 4, `expected real compression, got ${packed.body.length}`);
  assert.equal(gunzipSync(packed.body).toString("utf8"), relayedPayload);
});

test("a relayed core read is byte-identical and uncompressed without accept-encoding", async () => {
  const plain = await get("/api/composio/slack", identityHeaders());
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), relayedPayload);
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
