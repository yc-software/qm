import "./support/auto-fake-sprites.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import type { DirectFileUploads } from "../src/files/direct-file-upload.ts";
import { FileUploadError, type FileUpload } from "../src/files/file-upload-store.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const secret = "file-upload-test-secret".repeat(3);
const personal = scopeId("personal", "U1");
const channel = scopeId("channel", "C1");
const upload: FileUpload = {
  id: "a".repeat(32),
  actorId: "U1",
  scopeId: personal,
  name: "private.txt",
  mimetype: "text/plain",
  sizeBytes: 1,
  partSize: 64 * 1024 * 1024,
  checksums: [],
  uploadId: "private-upload",
  state: "pending",
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
};
let server: Server;
let base: string;
let calls = 0;
const fake: DirectFileUploads = {
  async begin() {
    calls++;
    return upload;
  },
  async get(id) {
    return id === upload.id ? upload : null;
  },
  async list(actorId) {
    return [upload, { ...upload, id: "b".repeat(32), scopeId: channel }].filter((u) => u.actorId === actorId);
  },
  async sign() {
    calls++;
    return { url: "https://example.invalid/upload", headers: {}, expiresAt: Date.now() };
  },
  async complete() {
    calls++;
    throw new Error("not reached");
  },
  async abort() {
    calls++;
  },
  async sweep() {},
  start() {},
  async stop() {},
};
const token = (actorId: string, scope = personal) =>
  mintCapabilityToken({ actorId, scopeId: scope, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 }, secret);
const call = async (path: string, cap?: string, method = "GET", body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { ...(cap ? { "x-agent-capability": cap } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
before(async () => {
  const built = buildApp(testConfig({ signingSecret: secret }));
  built.app.belongsToScope = async () => true;
  built.app.authorizesCapabilityScope = async () => true;
  server = createServer(built.app, { signingSecret: secret, fileUploads: fake });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("direct upload routes require authenticated actor", async () => {
  assert.equal((await call("/v1/files/uploads", undefined, "POST", {})).status, 401);
});
test("an agent can initiate only inside the token scope even when actor belongs elsewhere", async () => {
  const result = await call("/v1/files/uploads", await token("U1", channel), "POST", {
    name: "file",
    scopeId: personal,
  });
  assert.equal(result.status, 403);
  assert.equal(calls, 0);
});
test("shared-scope tokens cannot read, sign, finish or abort the actor's personal uploads", async () => {
  const cap = await token("U1", channel);
  for (const [method, suffix] of [
    ["GET", ""],
    ["POST", "/parts/1"],
    ["POST", "/complete"],
    ["DELETE", ""],
  ]) {
    const result = await call(
      `/v1/files/uploads/${upload.id}${suffix}`,
      cap,
      method,
      method === "GET" ? undefined : {},
    );
    assert.equal(result.status, 404);
  }
  assert.equal(calls, 0);
});
test("another actor cannot discover an upload or obtain its signed URLs", async () => {
  const result = await call(`/v1/files/uploads/${upload.id}`, await token("U2", scopeId("personal", "U2")));
  assert.equal(result.status, 404);
});
test("owner can retrieve status and executable publisher with no credentials embedded", async () => {
  const cap = await token("U1");
  assert.equal((await call(`/v1/files/uploads/${upload.id}`, cap)).status, 200);
  const client = await call("/v1/files/upload-client", cap);
  assert.equal(client.status, 200);
  const text = await client.text();
  assert.ok(text.includes("def main():"));
  assert.ok(text.includes('os.environ["AGENT_API_TOKEN"]'));
  assert.ok(!text.includes(cap));
});

test("listing shows only the caller's unfinished uploads in the token scope and counts the rest", async () => {
  type Listing = { uploads: FileUpload[]; elsewhere: number };
  const body = async (cap: string) => (await (await call("/v1/files/uploads", cap)).json()) as Listing;
  assert.deepEqual(await body(await token("U1")), {
    uploads: [
      {
        id: upload.id,
        name: upload.name,
        sizeBytes: 1,
        state: "pending",
        createdAt: upload.createdAt,
        lastActivityAt: upload.lastActivityAt,
        expiresAt: upload.expiresAt,
      },
    ],
    elsewhere: 1,
  });
  assert.deepEqual(
    (await body(await token("U1", channel))).uploads.map((u) => u.id),
    ["b".repeat(32)],
  );
  assert.deepEqual(await body(await token("U2", scopeId("personal", "U2"))), { uploads: [], elsewhere: 0 });
});

test("a quota refusal tells the caller which of its uploads hold the quota", async () => {
  const built = buildApp(testConfig({ signingSecret: secret }));
  built.app.belongsToScope = async () => true;
  built.app.authorizesCapabilityScope = async () => true;
  const full = createServer(built.app, {
    signingSecret: secret,
    fileUploads: {
      ...fake,
      async begin() {
        throw new FileUploadError("quota", 429, "upload_quota");
      },
    },
  });
  await new Promise<void>((resolve) => full.listen(0, resolve));
  try {
    const response = await fetch(`http://localhost:${(full.address() as AddressInfo).port}/v1/files/uploads`, {
      method: "POST",
      headers: { "x-agent-capability": await token("U1"), "content-type": "application/json" },
      body: JSON.stringify({ name: "next.txt" }),
    });
    assert.equal(response.status, 429);
    const result = (await response.json()) as { error: string; uploads: FileUpload[]; elsewhere: number };
    assert.equal(result.error, "upload_quota");
    assert.deepEqual(
      result.uploads.map((u) => u.name),
      ["private.txt"],
    );
    assert.equal(result.elsewhere, 1);
  } finally {
    await new Promise<void>((resolve) => full.close(() => resolve()));
  }
});
