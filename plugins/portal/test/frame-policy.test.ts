import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToApp } from "../src/proxy.ts";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
  });
  res.end("<p>hi</p>");
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const fronts: ReturnType<typeof createServer>[] = [];

function front(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer((req, res) => {
    res.setHeader("x-frame-options", "DENY");
    handle(req, res);
  });
  fronts.push(s);
  return new Promise((r) => s.listen(0, () => r(`http://localhost:${(s.address() as AddressInfo).port}`)));
}

const appBase = await front((req, res) =>
  proxyToApp(req, res, {
    coreBase: upstreamUrl,
    id: "app1",
    subPath: req.url ?? "/",
    search: "",
    principal: "alice",
    signingSecret: "frame-policy-test-secret",
  }),
);

test.after(() => {
  upstream.close();
  for (const s of fronts) s.close();
});

test("deployed app content never dictates the portal's frame policy, however it answers", async () => {
  const r = await fetch(`${appBase}/index.html`);
  assert.equal(r.headers.get("x-frame-options"), "DENY", "agent-authored content cannot make the portal framable");
});
