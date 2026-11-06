import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToSurface } from "../src/proxy.ts";

const seen: IncomingMessage["headers"][] = [];
const upstream = createServer((req, res) => {
  req.resume();
  seen.push(req.headers);
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamBase = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const portal = createServer((req, res) => {
  proxyToSurface(req, res, {
    upstreamBase,
    forwardPath: new URL(req.url ?? "/", "http://portal").pathname,
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

function post(headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/turn`, { method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("the web surface receives the client surface the app declared", async () => {
  await post({ "content-type": "application/json", "x-qm-client": "ios" });
  const forwarded = seen.at(-1)!;
  assert.equal(forwarded["x-qm-client"], "ios");
});

test("the web surface receives the platform request id", async () => {
  await post({ "content-type": "application/json", "fly-request-id": "edge-7" });
  assert.equal(seen.at(-1)!["fly-request-id"], "edge-7");
});
