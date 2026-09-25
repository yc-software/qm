import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: string[] = [];
const core = createServer((req: IncomingMessage, res) => {
  calls.push(req.url ?? "");
  if ((req.url ?? "").startsWith("/v1/files?")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({
        owned: [
          {
            id: "artifact-1",
            name: "interview-list.csv",
            createdAt: 10,
            openable: true,
          },
        ],
        shared: [],
      }),
    );
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.CORE_API_URL = coreUrl;
process.env.CORE_SIGNING_SECRET = "sandbox-link-download-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("sandbox markdown download resolves an authorized file-library item", async () => {
  const response = await fetch(`${base}/api/files/by-name/content?name=interview-list.csv`, {
    headers: { cookie: "webuiuser=alice" },
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/api/files/artifact-1/content");
  assert.ok(calls.some((url) => url.startsWith("/v1/files?") && url.includes("viewer=alice")));
});

test("sandbox markdown download stays unavailable when no visible file matches", async () => {
  const response = await fetch(`${base}/api/files/by-name/content?name=missing.csv`, {
    headers: { cookie: "webuiuser=alice" },
    redirect: "manual",
  });
  assert.equal(response.status, 404);
});
