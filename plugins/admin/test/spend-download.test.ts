import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const CSV_HEADER =
  "principal_id,scope_id,kind,display_name,live_usd,cron_usd,background_usd,total_usd,calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_hit_ratio";
const CSV_BODY =
  CSV_HEADER +
  "\r\n" +
  Array.from(
    { length: 40 },
    (_, i) => `person-${i},personal:person-${i},person,Person ${i},1,2,3,6,4,5,6,7,8,0.5`,
  ).join("\r\n") +
  "\r\n";

const calls: { url: string; actor: string | null }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  calls.push({ url: req.url ?? "", actor: (req.headers["x-admin-actor"] as string) ?? null });
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/spend") && (req.url ?? "").includes("format=csv")) {
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-length": String(Buffer.byteLength(CSV_BODY)),
      "content-disposition": 'attachment; filename="qm-spend-2026-08-26-2026-09-25.csv"',
      "x-content-type-options": "nosniff",
    });
    return void res.end(CSV_BODY);
  }
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/spend")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ org: { costUsd: 0 }, people: [], scopes: [], series: [] }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-spend-download-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/spend?format=csv keeps the core's CSV headers and full body", async () => {
  assert.ok(Buffer.byteLength(CSV_BODY) > 1024, "the fixture must exceed the gzip threshold to be a real proof");
  const r = await fetch(`${base}/api/spend?from=2026-08-26&to=2026-09-25&format=csv`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="qm-spend-2026-08-26-2026-09-25.csv"');
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const body = await r.text();
  assert.equal(body, CSV_BODY);
  assert.equal(Number(r.headers.get("content-length")), Buffer.byteLength(body));
  assert.equal(calls.at(-1)!.url, "/v1/admin/spend?from=2026-08-26&to=2026-09-25&format=csv");
  assert.equal(calls.at(-1)!.actor, "U-admin@acme");
});

test("GET /api/spend without format still takes the JSON read path", async () => {
  const r = await fetch(`${base}/api/spend?from=2026-08-26&to=2026-09-25`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.deepEqual(await r.json(), { org: { costUsd: 0 }, people: [], scopes: [], series: [] });
  assert.equal(calls.at(-1)!.url, "/v1/admin/spend?from=2026-08-26&to=2026-09-25");
});

test("GET /api/spend?format=csv requires a signed-in cookie before proxying", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/spend?format=csv`);
  assert.equal(r.status, 401);
  assert.equal(calls.length, before, "a signed-out CSV request never reaches core");
});
