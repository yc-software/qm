import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

const upstream = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const origin = "http://localhost:18198";
process.env.PUBLIC_WEB_URL = origin;
process.env.PORTAL_SESSION_SECRET = randomUUID();
process.env.CORE_SIGNING_SECRET = randomUUID();
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-user";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  upstream.close();
});

const forget = JSON.stringify({ ids: ["78"] });

test("forgetting a memory fact reaches the web UI with its body", async () => {
  const res = await fetch(`http://localhost:${port}/api/memory`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin },
    body: forget,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { method: "DELETE", url: "/api/memory", body: forget });
});

test("a chunked DELETE body reaches the web UI whole", async () => {
  const relayed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        port,
        method: "DELETE",
        path: "/api/memory",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
          origin,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(forget.slice(0, 5));
    req.end(forget.slice(5));
  });
  assert.equal(relayed.status, 200);
  assert.deepEqual(JSON.parse(relayed.body), { method: "DELETE", url: "/api/memory", body: forget });
});
