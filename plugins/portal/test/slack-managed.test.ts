import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const seen: Array<{
  path: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
  body: string;
}> = [];
const core = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body });
  res.writeHead(202, { "content-type": "application/json" });
  res.end('{"ready":false}');
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "managed-test-session-secret";
process.env.PORTAL_IDENTITY_SECRET = "managed-test-identity-secret";
process.env.CORE_SIGNING_SECRET = "managed-test-core-secret";
process.env.CORE_ORG_ID = "test";
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.WEB_UI_UPSTREAM = process.env.CORE_API_URL;
process.env.ADMIN_UPSTREAM = process.env.CORE_API_URL;
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

test("managed Slack forwards exact methods and paths with service auth but no browser identity", async () => {
  for (const [method, path] of [
    ["POST", "installation"],
    ["DELETE", "installation"],
    ["POST", "events"],
  ]) {
    const result = await fetch(`${base}/v1/slack/managed/${path}`, {
      method,
      headers: {
        authorization: "Bearer deployment-token",
        "content-type": "application/json",
        cookie: "portal_session=forged",
      },
      body: '{"installId":"one"}',
    });
    assert.equal(result.status, 202, `${method} ${path}`);
    assert.deepEqual(await result.json(), { ready: false });
    assert.deepEqual(seen.at(-1), {
      path: `/v1/slack/managed/${path}`,
      authorization: "Bearer deployment-token",
      cookie: undefined,
      body: '{"installId":"one"}',
    });
  }
  const count = seen.length;
  for (const [method, path] of [
    ["GET", "installation"],
    ["DELETE", "events"],
    ["POST", "events/extra"],
  ]) {
    assert.equal((await fetch(`${base}/v1/slack/managed/${path}`, { method })).status, 404);
  }
  assert.equal(seen.length, count);
});
