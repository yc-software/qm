import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToSurface } from "../src/proxy.ts";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ headers: req.headers }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamBase = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const portal = createServer((req, res) => {
  proxyToSurface(req, res, {
    upstreamBase,
    forwardPath: req.url ?? "/",
    search: "",
    cookieName: "webuiuser",
    principal: "alice",
  });
});
await new Promise<void>((r) => portal.listen(0, r));
const base = `http://localhost:${(portal.address() as AddressInfo).port}`;

test.after(() => {
  portal.close();
  upstream.close();
});

test("the portal forwards the admin upload checksum and filename headers to the surface", async () => {
  const sha = "b".repeat(64);
  const relayed = await fetch(`${base}/api/files/upload?scope=org%3Aacme`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-content-sha256": sha,
      "x-file-name": encodeURIComponent("issue-670-repro.txt"),
    },
    body: "file bytes",
  });
  assert.equal(relayed.status, 200);
  const relayedBody = (await relayed.json()) as { headers: Record<string, string> };
  assert.equal(relayedBody.headers["x-content-sha256"], sha);
  assert.equal(relayedBody.headers["x-file-name"], encodeURIComponent("issue-670-repro.txt"));
});
