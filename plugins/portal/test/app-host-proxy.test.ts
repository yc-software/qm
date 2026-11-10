import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToAppHost, relayUpgradeToAppHost } from "../src/proxy.ts";
import { responseOnSocket } from "../../chassis/src/websocket-relay.ts";

const upgrades: Array<Record<string, string | string[] | undefined>> = [];
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
  res.write(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url }));
  res.end();
});
upstream.on("upgrade", (req, socket) => {
  upgrades.push(req.headers);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n",
  );
  socket.on("data", (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  socket.on("end", () => socket.end());
});
await new Promise<void>((resolve) => upstream.listen(0, resolve));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
const portal = createServer((req, res) => proxyToAppHost(req, res, upstreamUrl, "198.51.100.1"));
portal.on("upgrade", (req, socket, head) => {
  const res = responseOnSocket(req, socket);
  if (res) relayUpgradeToAppHost(req, res, { socket, head }, upstreamUrl, "198.51.100.1");
});
await new Promise<void>((resolve) => portal.listen(0, resolve));
test.after(() => {
  upstream.close();
  portal.close();
});

test("app proxy preserves uploads and app headers while stripping identity and hop headers", async () => {
  const result = await new Promise<{ status: number; cookies: string[]; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "localhost",
        port: (portal.address() as AddressInfo).port,
        method: "POST",
        path: "/api/write?x=1",
        headers: {
          host: "counter.apps.company.example.com",
          "content-length": "7",
          "content-type": "text/plain",
          authorization: "Bearer app-token",
          "if-match": '"version-2"',
          "x-app-key": "app-key",
          "x-signature": "forged",
          "x-as-principal": "admin",
          "x-agent-capability": "forged",
          "x-qm-client-ip": "203.0.113.66",
          connection: "x-remove-me",
          "x-remove-me": "secret",
          cookie: "portal_session=test",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, cookies: res.headers["set-cookie"]!, body }));
      },
    );
    req.on("error", reject);
    req.end("payload");
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.cookies, ["a=1", "b=2"]);
  const body = JSON.parse(result.body);
  assert.equal(body.body, "payload");
  assert.equal(body.url, "/api/write?x=1");
  assert.equal(body.headers["content-length"], "7");
  assert.equal(body.headers.authorization, "Bearer app-token");
  assert.equal(body.headers["if-match"], '"version-2"');
  assert.equal(body.headers["x-app-key"], "app-key");
  assert.equal(body.headers.cookie, "portal_session=test");
  assert.equal(body.headers["x-qm-app-host"], "1");
  assert.equal(body.headers["x-qm-client-ip"], "198.51.100.1", "the gateway, not the visitor, supplies the client IP");
  for (const header of ["x-signature", "x-as-principal", "x-agent-capability", "x-remove-me"])
    assert.equal(body.headers[header], undefined);
});

test("app proxy relays WebSocket upgrades to the app host with identity headers stripped", async () => {
  const echoed = await new Promise<{ status: number; accept: unknown; data: string }>((resolve, reject) => {
    const req = request({
      hostname: "localhost",
      port: (portal.address() as AddressInfo).port,
      path: "/hmr?token=1",
      headers: {
        host: "counter.apps.company.example.com",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "x-agent-capability": "forged",
        "x-qm-client-ip": "203.0.113.66",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.once("data", (chunk: Buffer) => {
        resolve({ status: res.statusCode!, accept: res.headers["sec-websocket-accept"], data: chunk.toString() });
        socket.destroy();
      });
      socket.write("ping");
    });
    req.on("response", (res) => reject(new Error(`unexpected ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
  assert.deepEqual(echoed, { status: 101, accept: "abc", data: "echo:ping" });
  const headers = upgrades[0]!;
  assert.equal(headers.upgrade, "websocket");
  assert.equal(headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
  assert.equal(headers["x-qm-app-host"], "1");
  assert.equal(headers["x-qm-client-ip"], "198.51.100.1");
  assert.equal(headers["x-agent-capability"], undefined);
});
