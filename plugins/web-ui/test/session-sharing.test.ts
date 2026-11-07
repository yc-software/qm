import { readFileSync } from "node:fs";
import { releaseFiles } from "./release-fixture.ts";
import { sharedSessionHtml } from "../server/shared-session.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const calls: Array<{ path: string; method: string; body: string; actor: string | undefined }> = [];
const core = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  calls.push({
    path: req.url!,
    method: req.method!,
    body,
    actor: req.headers[PORTAL_IDENTITY_HEADER] as string | undefined,
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      /\/v1\/(shared-sessions|public-shares)\//.test(req.url!)
        ? {
            createdAt: 1,
            messages: [
              { role: "assistant", text: '<script>alert("secret")</script> ![image](https://example.test/private)' },
            ],
          }
        : { share: { token: "token", createdAt: 1 } },
    ),
  );
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "sharing-route-test-secret";
const { handler, serveReleasesFrom } = await import("../server/index.ts");
serveReleasesFrom(releaseFiles({ "shared.html": readFileSync(new URL("../shared.html", import.meta.url), "utf8") }));
const web = createServer(handler);
await new Promise<void>((resolve) => web.listen(0, resolve));
const base = `http://localhost:${(web.address() as AddressInfo).port}`;
const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "sharing-route-test-secret");
const headers = { [PORTAL_IDENTITY_HEADER]: token, "content-type": "application/json" };
test.after(() => {
  web.close();
  core.close();
});

test("the shared page loads only the filtered endpoint", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/share/internal/11111111-1111-4111-8111-111111111111`, { headers });
  assert.equal(response.status, 200);
  const reads = calls.slice(before).filter((call) => call.path.startsWith("/v1/shared-sessions/"));
  assert.equal(reads.length, 1);
  assert.ok(reads[0]!.path.startsWith("/v1/shared-sessions/11111111-1111-4111-8111-111111111111?viewer=alice"));
  assert.equal(reads[0]!.actor, token);
  const html = await response.text();
  assert.ok(html.includes("\\u003cscript>"));
  assert.equal(html.includes('<script>alert("secret")</script>'), false);
  const snapshot = html.match(/<script id="shared-transcript" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(snapshot);
  assert.equal(JSON.parse(snapshot[1]!).messages[0].role, "assistant");
  assert.equal(html.includes("<img"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(response.headers.get("content-security-policy")!.includes("default-src 'none'"));
  assert.ok(response.headers.get("content-security-policy")!.includes("img-src 'self' data:"));
});

test("anonymous shared page requests never reach core", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/share/internal/11111111-1111-4111-8111-111111111111`);
  assert.equal(response.status, 401);
  assert.equal(calls.length, before);
});

test("snapshot JSON cannot escape its inert script element", () => {
  const template = '<script id="shared-transcript" type="application/json">\n null\n</script>';
  const data = { messages: [{ role: "assistant", text: '</script><script src="/evil.js"></script>& $&' }] };
  const output = sharedSessionHtml(template, data);
  assert.equal((output.match(/<script/g) ?? []).length, 1);
  assert.deepEqual(JSON.parse(output.slice(output.indexOf(">") + 1, output.lastIndexOf("</script>"))), data);
});

test("external share is readable without identity using only the public projection", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/share/external/11111111-1111-4111-8111-111111111111`);
  assert.equal(response.status, 200);
  assert.equal(calls.length, before + 1);
  assert.ok(calls.at(-1)!.path.startsWith("/v1/public-shares/11111111-1111-4111-8111-111111111111?"));
  assert.equal(calls.at(-1)!.actor, undefined);
  const html = await response.text();
  assert.match(html, /shared-transcript/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
