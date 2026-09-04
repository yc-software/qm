import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; actor: string | null; signed: boolean }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  calls.push({
    method: req.method ?? "",
    url: req.url ?? "",
    actor: (req.headers["x-admin-actor"] as string) ?? null,
    signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
  });
  if (req.method === "GET" && (req.url ?? "").includes("reset-mid-stream")) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" });
    res.write("partial");
    setTimeout(() => res.destroy(), 10);
    return;
  }
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/files/download")) {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": "11",
      "content-disposition": 'attachment; filename="todo.txt"',
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    return void res.end("download me");
  }
  if (req.method === "POST" && (req.url ?? "").startsWith("/v1/blobs")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ blobId: "feedfacefeedfacefeedfacefeedface", sizeBytes: 9 }));
  }
  if (req.method === "POST" && (req.url ?? "").startsWith("/v1/admin/files/upload")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ file: { id: "file-1", name: "note.txt" } }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-files-download-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/files/download streams the core attachment with actor + signature", async () => {
  const r = await fetch(`${base}/api/files/download?id=art-abc123`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "download me");
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="todo.txt"');
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    r.headers.get("content-security-policy"),
    "sandbox",
    "the proxy forwards the core's CSP, or inline PDFs render unsandboxed",
  );
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/files/download?id=art-abc123");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/files/download requires a signed-in cookie before proxying", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/files/download?id=art-abc123`);
  assert.equal(r.status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});

test("POST /api/files/upload stages the body, then registers it with the admin actor", async () => {
  const body = Buffer.from("upload me");
  const sha = createHash("sha256").update(body).digest("hex");
  const r = await fetch(`${base}/api/files/upload?scope=personal%3AU1`, {
    method: "POST",
    headers: {
      cookie: ADMIN,
      "content-type": "text/plain",
      "x-file-name": encodeURIComponent("note.txt"),
      "x-content-sha256": sha,
    },
    body,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { file: { id: "file-1", name: "note.txt" } });
  const blob = calls.at(-2)!;
  assert.equal(blob.method, "POST");
  assert.match(blob.url, /^\/v1\/blobs\?_sourceAuthNonce=/);
  assert.equal(blob.actor, null);
  assert.equal(blob.signed, true);
  const reg = calls.at(-1)!;
  assert.equal(reg.method, "POST");
  assert.equal(reg.url, "/v1/admin/files/upload?scope=personal%3AU1");
  assert.equal(reg.actor, "U-admin@acme");
  assert.equal(reg.signed, true);
});

test("a core reset mid-download does not crash the plugin", async () => {
  await assert.rejects(async () => {
    const r = await fetch(`${base}/api/files/download?id=reset-mid-stream`, { headers: { cookie: ADMIN } });
    await r.text();
  }, "the truncated body should surface as a fetch error to the client");
  const alive = await fetch(`${base}/healthz`);
  assert.equal(alive.status, 200);
});
