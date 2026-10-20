import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipAccepted, sendBuffered, sendJson } from "../src/api/http.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function get(base: string, path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("error", reject);
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function listen(server: Server): { base: string; close: () => Promise<void> } {
  server.listen(0);
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const bigBody = { rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, label: "a repetitive label" })) };
const bigJson = JSON.stringify(bigBody);

function jsonEcho(): { base: string; close: () => Promise<void> } {
  return listen(createHttpServer((req, res) => sendJson(res, 200, req.url === "/small" ? { ok: true } : bigBody)));
}

test("a client that accepts gzip gets a gzipped body that decodes to the identical bytes", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.equal(r.headers["vary"], "accept-encoding");
    assert.ok(r.body.length < bigJson.length / 2, `expected real compression, got ${r.body.length}`);
    assert.equal(gunzipSync(r.body).toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a compressed response declares the length of the bytes on the wire, not of the plaintext", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-length"], String(r.body.length));
    assert.equal(r.headers["transfer-encoding"], undefined);
  } finally {
    await s.close();
  }
});

test("a caller's own content-length never survives onto a compressed body", { timeout: 5_000 }, async () => {
  const s = listen(
    createHttpServer((_req, res) =>
      sendBuffered(res, 200, { "content-type": "application/json", "content-length": String(bigJson.length) }, bigJson),
    ),
  );
  try {
    const r = await get(s.base, "/", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-length"], String(r.body.length));
    assert.equal(gunzipSync(r.body).toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a client that sends no accept-encoding gets the identical uncompressed body", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", {});
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.body.toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a client that refuses gzip with q=0 gets the identical uncompressed body", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/big", { "accept-encoding": "gzip;q=0, deflate" });
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.body.toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test("a payload below the minimum size is not worth compressing", async () => {
  const s = jsonEcho();
  try {
    const r = await get(s.base, "/small", { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.headers["vary"], "accept-encoding");
    assert.equal(r.body.toString("utf8"), '{"ok":true}');
  } finally {
    await s.close();
  }
});

test("a handler that fails after a large send still answers coherently instead of shipping an empty gzip", async () => {
  const s = listen(
    createHttpServer((_req, res) => {
      sendJson(res, 200, bigBody);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }),
  );
  try {
    const r = await get(s.base, "/", { "accept-encoding": "gzip" });
    assert.equal(r.status, 500);
    assert.equal(r.headers["content-encoding"], undefined);
    assert.equal(r.body.toString("utf8"), '{"error":"internal_error"}');
  } finally {
    await s.close();
  }
});

test("a client that vanishes mid-compression leaves the server serving the next request", async () => {
  let abandoned: ServerResponse | undefined;
  const s = listen(
    createHttpServer((_req, res) => {
      sendJson(res, 200, bigBody);
      if (abandoned) return;
      abandoned = res;
      res.destroy();
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(s.base, { headers: { "accept-encoding": "gzip" }, agent: false }, () => resolve());
      req.on("error", (err: NodeJS.ErrnoException) => (err.code === "ECONNRESET" ? resolve() : reject(err)));
      req.end();
    });
    assert.equal(abandoned?.destroyed, true, "the response is gone before its compression finishes");
    const after = await get(s.base, "/", { "accept-encoding": "gzip" });
    assert.equal(gunzipSync(after.body).toString("utf8"), bigJson);
  } finally {
    await s.close();
  }
});

test(
  "a competing response that has claimed the head is never overwritten by a late compression",
  { timeout: 5_000 },
  async () => {
    const s = listen(
      createHttpServer((_req, res) => {
        sendJson(res, 200, bigBody);
        res.writeHead(500, { "content-type": "text/plain" });
        res.write("interloper");
        setTimeout(() => res.end(), 100);
      }),
    );
    try {
      const r = await get(s.base, "/", { "accept-encoding": "gzip" });
      assert.equal(r.status, 500);
      assert.equal(r.headers["content-encoding"], undefined);
      assert.equal(r.body.toString("utf8"), "interloper");
    } finally {
      await s.close();
    }
  },
);

test("the core API server compresses a response written through Fastify's hijacked reply", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "compression-")) }));
  const s = listen(createInsecureTestServer(built.app));
  try {
    const path = `/v1/${"x".repeat(1200)}`;
    const packed = await get(s.base, path, { "accept-encoding": "gzip" });
    assert.equal(packed.headers["content-encoding"], "gzip");
    const plain = await get(s.base, path, {});
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(gunzipSync(packed.body).toString("utf8"), plain.body.toString("utf8"));
    assert.ok(packed.body.length < plain.body.length / 2);
  } finally {
    await s.close();
  }
});

test("gzipAccepted reads the accept-encoding grammar rather than substring-matching it", () => {
  const asks = (value?: string | string[]): boolean =>
    gzipAccepted(
      value === undefined
        ? ({ headers: {} } as IncomingMessage)
        : ({ headers: { "accept-encoding": value } } as unknown as IncomingMessage),
    );
  assert.equal(gzipAccepted(undefined), false);
  assert.equal(asks(), false);
  assert.equal(asks(""), false);
  assert.equal(asks("gzip"), true);
  assert.equal(asks("GZIP, br"), true);
  assert.equal(asks(" gzip ; q=0.5 , br"), true);
  assert.equal(asks("gzip;q=0"), false);
  assert.equal(asks("gzip;q=0.0"), false);
  assert.equal(asks("gzip;q=abc"), false);
  assert.equal(asks("br, deflate"), false);
  assert.equal(asks("*"), true);
  assert.equal(asks("*;q=0"), false);
  assert.equal(asks("*, gzip;q=0"), false);
  assert.equal(asks("gzip, *;q=0"), true);
  assert.equal(asks("identity"), false);
  assert.equal(asks(["gzip", "br"]), true);
});
