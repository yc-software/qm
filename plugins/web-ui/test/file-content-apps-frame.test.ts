import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/files/") && (req.url ?? "").includes("/content")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return void res.end("<p>hi</p>");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "apps-frame-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.DEPLOY_APPS_DOMAIN = "apps.test";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("with a deploy apps domain, file frames also name it: the app shell's chat panel is an ancestor", async () => {
  const r = await fetch(`${base}/api/files/some-file/content`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' \*\.apps\.test/);
  assert.equal(r.headers.get("x-frame-options"), null);
});

test("the app-edit page states frame-ancestors of its own, which is what sheds the portal's blanket DENY", async () => {
  const r = await fetch(`${base}/app-edit?slug=demo`, { headers: { cookie: "webuiuser=alice" } });
  assert.match(
    r.headers.get("content-security-policy") ?? "",
    /frame-ancestors /,
    "without this the portal keeps DENY and the app shell's chat panel cannot load",
  );
  assert.equal(r.headers.get("x-frame-options"), null);
});
