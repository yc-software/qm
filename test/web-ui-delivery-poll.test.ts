import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";

let deliveriesStatus = 503;
const acked: string[] = [];
const core = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://core");
  if (req.method === "GET" && url.pathname === "/v1/deliveries" && url.searchParams.get("type") === "web") {
    res.writeHead(deliveriesStatus, { "content-type": "application/json" });
    res.end(
      deliveriesStatus === 200
        ? JSON.stringify({ deliveries: [{ id: "d1", createdAt: 0, destination: { target: "web:nobody:t1" } }] })
        : JSON.stringify({ error: "unavailable" }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/v1/deliveries/")) {
    acked.push(url.pathname);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
core.listen(0);
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
const SECRET = "core-signing-secret".repeat(3);
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { drainWebDeliveries, handler } = await import("../plugins/web-ui/server/index.ts");
const web = createServer(handler);
web.listen(0);
const browser = new AbortController();

after(async () => {
  browser.abort();
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

async function connectBrowser(user: string): Promise<void> {
  const r = await fetch(`http://localhost:${(web.address() as AddressInfo).port}/api/deliveries/events`, {
    headers: {
      cookie: `webuiuser=${encodeURIComponent(user)}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
    },
    signal: browser.signal,
  });
  assert.equal(r.status, 200);
}

test("no delivery poll runs before a browser connects", async () => {
  deliveriesStatus = 200;
  await drainWebDeliveries();
  assert.deepEqual(acked, []);
  deliveriesStatus = 503;
});

test("web delivery poll warns once per outage and logs recovery", async (t) => {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(String(args[0]));
  t.mock.method(console, "warn", record);
  t.mock.method(console, "log", record);
  const pollLines = () => lines.filter((line) => line.includes("web delivery poll"));
  await connectBrowser("someone@x.test");

  for (let i = 0; i < 3; i++) await drainWebDeliveries();
  assert.equal(pollLines().length, 1);
  assert.match(pollLines()[0]!, /^\[swallowed\] web-ui: web delivery poll.*http 503/);

  deliveriesStatus = 200;
  await drainWebDeliveries();
  await drainWebDeliveries();
  assert.deepEqual(pollLines().slice(1), ["[web-ui] web delivery poll recovered"]);
  assert.deepEqual(acked, ["/v1/deliveries/d1/ack", "/v1/deliveries/d1/ack"]);

  deliveriesStatus = 500;
  await drainWebDeliveries();
  assert.equal(pollLines().length, 3);
  assert.match(pollLines()[2]!, /http 500/);
});
