import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let lastCoreUrl = "";

const core = createServer((req: IncomingMessage, res) => {
  lastCoreUrl = req.url ?? "";
  if ((req.url ?? "").startsWith("/m/")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-pointer-lock allow-modals allow-popups; default-src 'none'; connect-src 'none'",
    });
    return void res.end("<canvas></canvas><script>void 0</script>");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.CORE_API_URL = coreUrl;
process.env.CORE_SIGNING_SECRET = "miniapp-proxy-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("miniapp HTML is public, sandboxed, and iframeable", async () => {
  const r = await fetch(`${base}/m/aa/bb`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<canvas/);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox\b/);
  assert.ok(!/allow-same-origin/.test(csp));
  assert.equal(r.headers.get("x-frame-options"), null);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  await fetch(`${base}/m/aa/bb?theme=light`);
  assert.match(lastCoreUrl, /theme=light/);
});
