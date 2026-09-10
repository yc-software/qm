import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/d/")) {
    res.writeHead(Number(new URL(req.url!, "http://core").searchParams.get("status") ?? "200"), {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src *",
    });
    return void res.end("<script>fetch('/api/keychain')</script>");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.CORE_API_URL = coreUrl;
process.env.CORE_SIGNING_SECRET = "deployment-preview-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("in-surface deployment preview is sandboxed to an opaque origin (no same-origin XSS)", async () => {
  const identity = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "deployment-preview-test-secret");
  const r = await fetch(`${base}/deployments/some-app/`, { headers: { [PORTAL_IDENTITY_HEADER]: identity } });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox\b/, "the response is served under a CSP sandbox");
  assert.ok(!/allow-same-origin/.test(csp), "the sandbox never grants same-origin (opaque origin only)");
  assert.match(csp, /allow-scripts/, "scripts still run inside the opaque origin");
  assert.match(csp, /default-src \*/, "upstream policy is retained alongside the independently enforced sandbox");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("the deployment preview still requires a signed-in user", async () => {
  const r = await fetch(`${base}/deployments/some-app/`);
  assert.equal(r.status, 401);
});

for (const status of [300, 302, 303, 305, 307, 308])
  test(`unfollowed ${status} app response bodies remain sandboxed on QM origin`, async () => {
    const identity = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "deployment-preview-test-secret");
    const response = await fetch(`${base}/d/app/?status=${status}`, {
      redirect: "manual",
      headers: { [PORTAL_IDENTITY_HEADER]: identity },
    });
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox\b/);
    assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /allow-same-origin/);
  });
