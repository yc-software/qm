import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const HTML = "<!doctype html><button>Go</button><script>void 0</script>";
const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/files/html/content")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(HTML)),
    });
    return void res.end(HTML);
  }
  if ((req.url ?? "").startsWith("/v1/files/image/content")) {
    res.writeHead(200, { "content-type": "image/png" });
    return void res.end("png");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "playground-content-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = { cookie: "webuiuser=alice" };

test.after(() => {
  surface.close();
  core.close();
});

test("playground content is same-origin frameable but isolated from network and parent origin", async () => {
  const response = await fetch(`${base}/api/playgrounds/html`, { headers });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), HTML);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("source is plain text and non-HTML artifacts are refused", async () => {
  const source = await fetch(`${base}/api/playgrounds/html?source=1`, { headers });
  assert.match(source.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await source.text(), HTML);
  assert.equal((await fetch(`${base}/api/playgrounds/image`, { headers })).status, 415);
});
