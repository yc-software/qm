import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToAppHost } from "../src/proxy.ts";

const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
  res.write(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url }));
  res.end();
});
await new Promise<void>((resolve) => upstream.listen(0, resolve));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
const portal = createServer((req, res) => proxyToAppHost(req, res, upstreamUrl));
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
  for (const header of ["x-signature", "x-as-principal", "x-agent-capability", "x-remove-me"])
    assert.equal(body.headers[header], undefined);
});
