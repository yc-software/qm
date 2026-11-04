import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { verifiedForwardedHost } from "../../chassis/src/forwarded-host.ts";

const SECRET = "external-share-forward-core-secret";
const a = randomUUID();
const hosts: Record<string, { tenant: string; multi: boolean; sole: boolean }> = {
  "a.example.test": { tenant: a, multi: true, sole: false },
};
const seen: { url: string; verifiedHost: string | undefined; req: IncomingMessage }[] = [];
const upstream = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://core.test").pathname;
  res.setHeader("content-type", "application/json");
  const host = path.startsWith("/v1/operator/hosts/") ? decodeURIComponent(path.slice(19)) : undefined;
  if (host !== undefined)
    return void res.end(JSON.stringify(hosts[host] ?? { tenant: null, multi: true, sole: false }));
  if (path === "/v1/surface-config") return void res.end("{}");
  seen.push({ url: req.url ?? "", verifiedHost: verifiedForwardedHost(req, SECRET), req });
  req.resume();
  res.end("{}");
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: "http://portal.test",
  PORTAL_SESSION_SECRET: "external-share-forward-secret",
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: SECRET,
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
test.after(() => {
  server.close();
  upstream.close();
});

function get(host: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

test("an external share on a tenant host reaches the web UI with that host signed", async () => {
  const path = `/share/external/${randomUUID()}?inline=1`;
  assert.equal(await get("a.example.test:443", path, { "x-forwarded-host": "b.example.test" }), 200);
  const hit = seen.findLast((entry) => entry.url === path);
  assert.ok(hit, "the web UI never received the share");
  assert.equal(hit.verifiedHost, "a.example.test");
});

test("an external share on an unknown host is still refused", async () => {
  assert.equal(await get("stranger.example.test", `/share/external/${randomUUID()}`), 421);
});
