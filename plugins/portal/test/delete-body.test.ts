import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startWithFakeCore, type CoreHit } from "./fake-core.ts";

const coreApi = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((r) => coreApi.listen(0, r));

const origin = "http://localhost:18198";
process.env.PUBLIC_WEB_URL = origin;
process.env.PORTAL_SESSION_SECRET = randomUUID();
process.env.CORE_SIGNING_SECRET = randomUUID();
process.env.CORE_API_URL = `http://localhost:${(coreApi.address() as AddressInfo).port}`;
process.env.PORTAL_LOCAL_AUTH_BYPASS = "1";
process.env.PORTAL_DEV_PRINCIPAL = "local-user";

const { port, close } = await startWithFakeCore();
test.after(() => {
  close();
  coreApi.close();
});

const forget = JSON.stringify({ ids: ["78"] });

test("forgetting a memory fact reaches core with its body", async () => {
  const res = await fetch(`http://localhost:${port}/api/memory`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin },
    body: forget,
  });
  assert.equal(res.status, 200);
  const hit = (await res.json()) as CoreHit;
  assert.deepEqual([hit.method, hit.url, hit.body], ["DELETE", "/api/memory", forget]);
});

test("a chunked DELETE body reaches core whole", async () => {
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
  const hit = JSON.parse(relayed.body) as CoreHit;
  assert.deepEqual([hit.method, hit.url, hit.body], ["DELETE", "/api/memory", forget]);
});
