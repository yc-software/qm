import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { mintCapabilityToken, BLOB_TRANSFER_AUD } from "../src/auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "blob-auth-secret".repeat(3);

function start(): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "blobauth-")), signingSecret: SECRET }));
  const server = createServer(built.app, { signingSecret: SECRET, blobTransfer: built.blobTransfer });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const tok = (blob: { dir: "read" | "write"; id?: string }) =>
  mintCapabilityToken(
    {
      actorId: "fly-sandbox",
      scopeId: scopeId("personal", "fly-sandbox"),
      aud: BLOB_TRANSFER_AUD,
      blob,
      exp: Date.now() + 60_000,
    },
    SECRET,
  );

async function stageBlob(base: string): Promise<string> {
  const body = Buffer.from("blob channel payload".repeat(64));
  const res = await fetch(`${base}/v1/blobs`, {
    method: "POST",
    headers: { [CAPABILITY_HEADER]: await tok({ dir: "write" }), "content-type": "application/octet-stream" },
    body,
  });
  assert.equal(res.status, 200, "a write-transfer token stages a blob");
  return ((await res.json()) as { blobId: string }).blobId;
}

test("a read token pinned to a blob id can fetch exactly that blob", async () => {
  const s = start();
  try {
    const id = await stageBlob(s.base);
    const res = await fetch(`${s.base}/v1/blobs/${id}`, {
      headers: { [CAPABILITY_HEADER]: await tok({ dir: "read", id }) },
    });
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).length > 0);
  } finally {
    await s.close();
  }
});

test("a read token for a DIFFERENT blob id cannot fetch this one (403)", async () => {
  const s = start();
  try {
    const id = await stageBlob(s.base);
    const res = await fetch(`${s.base}/v1/blobs/${id}`, {
      headers: { [CAPABILITY_HEADER]: await tok({ dir: "read", id: "some-other-blob" }) },
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("a read token cannot be used to WRITE (wrong direction, 403)", async () => {
  const s = start();
  try {
    const res = await fetch(`${s.base}/v1/blobs`, {
      method: "POST",
      headers: { [CAPABILITY_HEADER]: await tok({ dir: "read", id: "x" }), "content-type": "application/octet-stream" },
      body: Buffer.from("nope"),
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("no auth at all (with a signing secret set) is rejected", async () => {
  const s = start();
  try {
    const id = await stageBlob(s.base);
    const res = await fetch(`${s.base}/v1/blobs/${id}`);
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  } finally {
    await s.close();
  }
});
