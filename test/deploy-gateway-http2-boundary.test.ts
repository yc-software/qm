import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { fixture } from "./helpers/deploy-hardening-fixture.ts";

test("HTTP/2 isolated gateway applies the same auth, CORS/cache and cookie boundary before streaming", async (t) => {
  const f = await fixture(t);
  const sessions = new Set<ServerHttp2Session>();
  const hits: Record<string, unknown>[] = [];
  const upstream = createServer((req, res) => {
    hits.push(req.headers);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "public, max-age=31536000",
      "cdn-cache-control": "public, max-age=31536000",
      "access-control-allow-origin": String(req.headers.origin ?? "null"),
      "access-control-allow-credentials": "true",
      "clear-site-data": '"cookies"',
      "set-cookie": ["app=ok; Domain=.example.test; Path=/", "__Host-qm_app_session=evil; Secure; Path=/"],
    });
    res.write("data: first\n\n");
    res.end("data: last\n\n");
  });
  upstream.on("session", (session) => sessions.add(session));
  upstream.listen(0);
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const reach = f.app.reachDeployment.bind(f.app);
  f.app.reachDeployment = async (...args) => {
    const result = await reach(...args);
    if (result.status !== "ok") return result;
    return {
      ...result,
      endpoint: { ...result.endpoint, port: (upstream.address() as AddressInfo).port, httpVersion: "2" },
    };
  };
  const { cookie } = await f.complete();
  assert.equal(
    (await f.send("/events", { host: f.host, cookie, origin: "https://sibling.apps.example.test" })).status,
    403,
  );
  assert.equal(hits.length, 0);
  const response = await f.send("/events", {
    host: f.host,
    cookie: `${cookie}; portal_session=secret; qm_idp_session=secret; __Host-qm_idp_session=secret; app=mine`,
    origin: f.origin,
    "x-agent-capability": "secret",
    forwarded: "evil",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, "data: first\n\ndata: last\n\n");
  assert.equal(hits[0]!.cookie, "app=mine");
  assert.equal(hits[0]!.forwarded, undefined);
  assert.equal(hits[0]!["x-agent-capability"], undefined);
  assert.equal(hits[0]!["x-forwarded-host"], f.host);
  assert.equal(response.headers["cache-control"], "private, no-store");
  for (const name of [
    "cdn-cache-control",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "clear-site-data",
  ])
    assert.equal(response.headers[name], undefined);
  assert.deepEqual(response.headers["set-cookie"], ["app=ok; Path=/"]);
});
