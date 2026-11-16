import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";

const upstream = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PUBLIC_WEB_URL = "http://localhost:18197";
process.env.PORTAL_SESSION_SECRET = "malformed-target-portal-secret";
process.env.CORE_SIGNING_SECRET = "malformed-target-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  upstream.close();
});

function rawGet(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("a request target that is not a parseable URL gets 400 instead of a server error", async () => {
  const response = await rawGet("//%5c/etc\\passwd");
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /"error":"bad_request"/);
});

test("an ordinary path is still routed after the target check", async () => {
  const response = await rawGet("/healthz");
  assert.match(response, /^HTTP\/1\.1 200 /);
});
