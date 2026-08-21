import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-csp-hash-test-secret";

const { server, hashAdminScript } = await import("../src/index.ts");

test("hashAdminScript: LF-only script hashes stably", () => {
  const script = "console.log('a');\nconsole.log('b');\n";
  assert.equal(hashAdminScript(script), hashAdminScript(script));
});

test("hashAdminScript: CRLF and LF variants of the same script hash identically", () => {
  const lf = "console.log('a');\nconsole.log('b');\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(hashAdminScript(crlf), hashAdminScript(lf));
});

test("hashAdminScript: bare CR (old Mac-style) line endings also hash identically to LF", () => {
  const lf = "console.log('a');\nconsole.log('b');\n";
  const cr = lf.replace(/\n/g, "\r");
  assert.equal(hashAdminScript(cr), hashAdminScript(lf));
});

test("hashAdminScript: content differences still produce different hashes", () => {
  assert.notEqual(hashAdminScript("console.log('a');\n"), hashAdminScript("console.log('b');\n"));
});

await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  if (core.listening) core.close();
});

function raw(path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET / sends a content-security-policy script-src hash that matches the real on-disk script", async () => {
  const r = await raw("/");
  assert.equal(r.status, 200);
  const csp = r.headers["content-security-policy"] as string;
  assert.ok(csp, "content-security-policy header present");
  const match = csp.match(/script-src 'sha256-([^']+)'/);
  assert.ok(match, "script-src sha256 directive present");

  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const html = fs
    .readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8")
    .replaceAll("__ADMIN_BASE__", process.env.ADMIN_BASE_PATH ?? "");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.equal(match?.[1], hashAdminScript(script));
});
