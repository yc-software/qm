import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/files/") && (req.url ?? "").includes("/content")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": "inline; filename=x.html",
    });
    return void res.end("<script>fetch('/api/keychain')</script>");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.CORE_API_URL = coreUrl;
process.env.CORE_SIGNING_SECRET = "file-content-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("inline file artifacts are sandboxed to an opaque origin (no same-origin XSS)", async () => {
  const r = await fetch(`${base}/api/files/some-file/content`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox\b/, "served under a CSP sandbox");
  assert.ok(!/allow-same-origin/.test(csp), "the sandbox never grants same-origin");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});
