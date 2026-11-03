import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";

function appWith(endpoint: Record<string, unknown>): App {
  return { reachDeployment: async () => ({ status: "ok", endpoint }) } as unknown as App;
}

test("/d/ proxy serves the warming page to a browser navigation when the deployment hangs", async () => {
  const held: import("node:net").Socket[] = [];
  const upstream = createHttpServer((req) => {
    held.push(req.socket);
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }), {
    deployDialTimeoutMs: 200,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`, {
      headers: { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document" },
    });
    assert.equal(res.status, 503);
    assert.match(String(res.headers.get("content-type")), /text\/html/);
    assert.equal(res.headers.get("retry-after"), "2");
    const body = await res.text();
    assert.match(body, /starting up/i);
    assert.match(body, /location\.reload/);
  } finally {
    for (const s of held) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy serves the warming page to a browser navigation when the deployment refuses connections", async () => {
  const upstream = createHttpServer(() => {});
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  await new Promise<void>((r) => upstream.close(() => r()));

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`, { headers: { accept: "text/html" } });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /starting up/i);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("/d/ proxy keeps JSON gateway errors for non-document requests", async () => {
  const held: import("node:net").Socket[] = [];
  const upstream = createHttpServer((req) => {
    held.push(req.socket);
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }), {
    deployDialTimeoutMs: 200,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const apiRes = await fetch(`${base}/d/some-id/api/data`, { headers: { accept: "application/json" } });
    assert.equal(apiRes.status, 504);
    assert.equal(((await apiRes.json()) as { error?: string }).error, "gateway_timeout");

    const postRes = await fetch(`${base}/d/some-id/`, {
      method: "POST",
      headers: { accept: "text/html", "content-type": "text/plain", "content-length": "2" },
      body: "hi",
    });
    assert.equal(postRes.status, 504);
    assert.equal(((await postRes.json()) as { error?: string }).error, "gateway_timeout");
  } finally {
    for (const s of held) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("a recently-healthy upstream keeps the full dial timeout for slow pages", async () => {
  let slow = false;
  const upstream = createHttpServer((req, res) => {
    if (slow) setTimeout(() => res.end("slow-ok"), 300);
    else res.end("fast-ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }), {
    deployDialTimeoutMs: 1000,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const first = await fetch(`${base}/d/some-id/`, { headers: { accept: "text/html" } });
    assert.equal(await first.text(), "fast-ok");
    slow = true;
    const second = await fetch(`${base}/d/some-id/`, { headers: { accept: "text/html" } });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "slow-ok");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
