import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start(): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "blobapi-")) }));
  const server = createInsecureTestServer(built.app, { blobTransfer: built.blobTransfer });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

test("POST /v1/blobs stages bytes and GET /v1/blobs/:id streams them back", async () => {
  const s = start();
  try {
    const body = Buffer.from("the quick brown fox".repeat(1000));
    const up = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-content-sha256": sha(body) },
      body,
    });
    assert.equal(up.status, 200);
    const { blobId, sizeBytes } = (await up.json()) as { blobId: string; sizeBytes: number };
    assert.equal(sizeBytes, body.length);
    assert.ok(blobId);

    const down = await fetch(`${s.base}/v1/blobs/${blobId}`);
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("content-length"), String(body.length));
    const got = Buffer.from(await down.arrayBuffer());
    assert.ok(got.equals(body));
  } finally {
    await s.close();
  }
});

test("POST /v1/blobs rejects a body that doesn't match x-content-sha256 (400)", async () => {
  const s = start();
  try {
    const body = Buffer.from("payload");
    const res = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-content-sha256": "0".repeat(64) },
      body,
    });
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});

test("GET /v1/blobs/:id is 404 for an unknown id", async () => {
  const s = start();
  try {
    assert.equal((await fetch(`${s.base}/v1/blobs/ffffffffffffffffffffffffffffffff`)).status, 404);
  } finally {
    await s.close();
  }
});
