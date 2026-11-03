import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";

const secret = "session-read-test";
let bodyStarted: (() => void) | undefined;
let bodyClosed: (() => void) | undefined;
let cancelAttempts = 0;
const requests: { url: string; headers: IncomingHttpHeaders }[] = [];
const core = createServer((req, res) => {
  if (req.url?.startsWith("/v1/sessions/cancel?")) {
    cancelAttempts++;
    res.writeHead(200, { "content-length": "100" });
    res.write("partial");
    res.once("close", () => bodyClosed?.());
    bodyStarted?.();
    return;
  }
  if (!req.url?.startsWith("/v1/sessions/test?")) return void res.end("{}");
  requests.push({ url: req.url, headers: req.headers });
  if (requests.length === 1) {
    res.writeHead(200, { "content-length": "100" });
    res.write("partial");
    setTimeout(() => res.destroy(), 10);
  } else res.end(JSON.stringify({ session: { id: "test" }, entries: [] }));
}).listen(0, "127.0.0.1");
await once(core, "listening");
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = secret;
process.env.WEB_UI_PRINCIPALS = "alice";
const { handler } = await import("../server/index.ts");
const web = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
await once(web, "listening");
test.after(() => {
  web.closeAllConnections();
  web.close();
  core.closeAllConnections();
  core.close();
});

test("session route retries interrupted body with the same viewer and fresh valid signatures", async () => {
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret);
  const response = await fetch(
    `http://127.0.0.1:${(web.address() as AddressInfo).port}/api/sessions/test?sinceSeq=825`,
    { headers: { [PORTAL_IDENTITY_HEADER]: token } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { session: { id: "test" }, entries: [] });
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]!.url, requests[1]!.url);
  for (const request of requests) {
    const url = new URL(request.url, "http://core");
    assert.equal(url.searchParams.get("viewer"), "alice");
    assert.equal(url.searchParams.get("sinceSeq"), "825");
    assert.equal(request.headers[PORTAL_IDENTITY_HEADER], token);
    assert.equal(
      request.headers["x-signature"],
      signRequest(secret, Number(request.headers["x-timestamp"]), canonicalPayload("GET", request.url, "")),
    );
  }
});

test("closing the browser request cancels core body collection without retry", async () => {
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    bodyClosed = resolve;
  });
  const controller = new AbortController();
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret);
  const pending = fetch(`http://127.0.0.1:${(web.address() as AddressInfo).port}/api/sessions/cancel`, {
    headers: { [PORTAL_IDENTITY_HEADER]: token },
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, /abort/i);
  await started;
  controller.abort();
  await rejected;
  await closed;
  assert.equal(cancelAttempts, 1);
});
