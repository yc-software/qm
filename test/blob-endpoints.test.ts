import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
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

function startWithDeadline(deadlineMs: number): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "blobapi-")) }));
  const server = createInsecureTestServer(built.app, {
    blobTransfer: built.blobTransfer,
    requestBodyDeadlineMs: deadlineMs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function slowBody(chunks: Buffer[], gapMs: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
      if (i >= chunks.length) return controller.close();
      controller.enqueue(chunks[i++]!);
    },
  });
}

test("POST /v1/blobs from a signed surface (web attachment proxy) outlives the default body deadline", async () => {
  const s = startWithDeadline(100);
  try {
    const chunks = Array.from({ length: 6 }, (_, n) => Buffer.alloc(64 * 1024, n));
    const whole = Buffer.concat(chunks);
    const up = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-content-sha256": sha(whole) },
      body: slowBody(chunks, 60),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(
      up.status,
      200,
      "a slow but progressing attachment upload must not be cut off at the default deadline",
    );
    const { sizeBytes } = (await up.json()) as { sizeBytes: number };
    assert.equal(sizeBytes, whole.length);
  } finally {
    await s.close();
  }
});

test("other routes still enforce the default body deadline", async () => {
  const s = startWithDeadline(100);
  try {
    const chunks = Array.from({ length: 6 }, () => Buffer.from('{"x":1}'.padEnd(64, " ")));
    const res = await fetch(`${s.base}/v1/sessions/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: slowBody(chunks, 60),
      duplex: "half",
    } as RequestInit & { duplex: "half" }).catch((e: unknown) => e);
    assert.ok(
      res instanceof Error || (res as Response).status >= 400,
      "a body still trickling in past the default deadline is refused",
    );
  } finally {
    await s.close();
  }
});
