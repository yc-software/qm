import "./support/auto-fake-sprites.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import type { DirectFileUploads } from "../src/files/direct-file-upload.ts";
import type { FileUpload } from "../src/files/file-upload-store.ts";
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
  stop() {},
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
  server = createServer(built.app, { signingSecret: secret, fileUploads: fake, filesDirectUploadsEnabled: true });
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

test("disabled initiation preserves existing session recovery", async () => {
  const built = buildApp(testConfig({ signingSecret: secret }));
  built.app.belongsToScope = async () => true;
  built.app.authorizesCapabilityScope = async () => true;
  const recovery = createServer(built.app, {
    signingSecret: secret,
    fileUploads: {
      ...fake,
      async complete() {
        return { id: upload.id, path: upload.name } as never;
      },
    },
  });
  await new Promise<void>((resolve) => recovery.listen(0, resolve));
  const origin = `http://localhost:${(recovery.address() as AddressInfo).port}`;
  const cap = await token("U1");
  try {
    for (const [method, path, expected] of [
      ["GET", "/v1/files/upload-client", 200],
      ["POST", "/v1/files/uploads", 503],
      ["GET", `/v1/files/uploads/${upload.id}`, 200],
      ["POST", `/v1/files/uploads/${upload.id}/parts/1`, 200],
      ["POST", `/v1/files/uploads/${upload.id}/complete`, 200],
      ["DELETE", `/v1/files/uploads/${upload.id}`, 200],
    ] as const) {
      const response = await fetch(origin + path, { method, headers: { "x-agent-capability": cap } });
      assert.equal(response.status, expected, `${method} ${path}`);
    }
  } finally {
    await new Promise<void>((resolve) => recovery.close(() => resolve()));
  }
});
