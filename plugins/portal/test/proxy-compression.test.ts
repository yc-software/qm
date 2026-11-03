import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { FORWARD_AGENT_API_HEADERS, proxyToSurface, proxyToUpstream } from "../src/proxy.ts";

const body = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, label: "repetitive" })) });
const packedBody = gzipSync(Buffer.from(body));

const upstream = createServer((req: IncomingMessage, res) => {
  req.resume();
  if (req.url === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    });
    res.write(": open\n\n");
    return;
  }
  if ((req.headers["accept-encoding"] ?? "").includes("gzip")) {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", vary: "accept-encoding" });
    return void res.end(packedBody);
  }
  res.writeHead(200, { "content-type": "application/json", vary: "accept-encoding" });
  res.end(body);
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamBase = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const portal = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://portal").pathname;
  if (path.startsWith("/v1/")) {
    proxyToUpstream(req, res, { baseUrl: upstreamBase, path, search: "" }, FORWARD_AGENT_API_HEADERS);
    return;
  }
  proxyToSurface(req, res, {
    upstreamBase,
    forwardPath: path,
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

interface RawResponse {
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function get(path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the portal relays a gzipped surface response without re-encoding or mangling it", async () => {
  const relayed = await get("/api/things", { "accept-encoding": "gzip" });
  assert.equal(relayed.headers["content-encoding"], "gzip");
  assert.equal(relayed.headers["vary"], "accept-encoding");
  assert.deepEqual(relayed.body, packedBody);
  assert.equal(gunzipSync(relayed.body).toString("utf8"), body);
});

test("the portal never hands a client an encoding it did not ask for", async () => {
  const relayed = await get("/api/things", { "accept-encoding": "identity" });
  assert.equal(relayed.headers["content-encoding"], undefined);
  assert.equal(relayed.body.toString("utf8"), body);
});

test("a relayed event stream still reaches the client before the response ends", async () => {
  const first = await new Promise<{ headers: IncomingMessage["headers"]; chunk: string }>((resolve, reject) => {
    const req = httpRequest(`${base}/stream`, { headers: { "accept-encoding": "gzip" } }, (res) => {
      res.setEncoding("utf8");
      res.once("data", (chunk: string) => {
        resolve({ headers: res.headers, chunk });
        req.destroy();
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
    req.end();
    setTimeout(() => reject(new Error("no stream data arrived within 5s")), 5_000).unref();
  });
  assert.equal(first.headers["content-encoding"], undefined);
  assert.equal(first.chunk, ": open\n\n");
});

test("the agent API path forwards accept-encoding so core can compress a large listing", async () => {
  const relayed = await get("/v1/sessions", { "accept-encoding": "gzip" });
  assert.equal(relayed.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(relayed.body).toString("utf8"), body);
});
