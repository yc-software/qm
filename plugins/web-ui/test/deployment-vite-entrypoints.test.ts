import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";

const calls: Array<{ path: string; cookie?: string; host?: string }> = [];
const upstream = createServer((req, res) => {
  calls.push({ path: req.url!, cookie: req.headers.cookie, host: req.headers.host });
  res.writeHead(302, { location: "https://app.apps.example.test/" });
  res.end();
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
process.env.WEB_UI_SERVER_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createVite({
  root,
  configFile: process.env.VITE_TEST_CONFIG ?? `${root}/vite.config.ts`,
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, preTransformRequests: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
await vite.listen();
const base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
test.after(async () => {
  await vite.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
for (const prefix of ["/d", "/deployments"])
  test(`Vite forwards ${prefix} launch paths to the authenticated Node surface`, async () => {
    const path = `${prefix}/demo/nested?x=1&x=2`;
    const n = calls.length;
    const response = await fetch(base + path, { headers: { cookie: "webuiuser=alice" }, redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://app.apps.example.test/");
    assert.deepEqual(calls.slice(n), [{ path, cookie: "webuiuser=alice", host: new URL(base).host }]);
  });

for (const path of ["/d?x=1", "/deployments?x=1"])
  test(`Vite delegates malformed bare launch prefix ${path} instead of SPA fallback`, async () => {
    const n = calls.length;
    await fetch(base + path, { redirect: "manual" });
    assert.equal(calls[n]?.path, path);
  });

for (const path of ["/", "/app-edit?slug=demo"])
  test(`Vite trusted UI forbids app-origin framing at ${path}`, async () => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  });
