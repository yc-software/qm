import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

test("the web board relays the viewer identity and existing session-bound operations, never an alternate peer API", async (t) => {
  const seen: Array<{ path: string; token: string | string[] | undefined; body: string }> = [];
  const core = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ path: req.url!, token: req.headers[PORTAL_IDENTITY_HEADER], body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => core.listen(0, "127.0.0.1", r));
  const secret = "swarm-board-web-route-test-signing-secret";
  process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  process.env.CORE_SIGNING_SECRET = secret;
  process.env.WEB_UI_PRINCIPALS = "alice";
  const { handler } = await import("../server/index.ts");
  const web = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  t.after(() => {
    core.closeAllConnections();
    core.close();
    web.closeAllConnections();
    web.close();
  });
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}/api/sessions/private-session/swarm`;
  assert.equal((await fetch(base + "?board=1")).status, 401);
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60000 }, secret);
  const headers = { [PORTAL_IDENTITY_HEADER]: token, "content-type": "application/json" };
  assert.equal((await fetch(base + "?board=1&visibility=org&sender=public-id", { headers })).status, 200);
  assert.equal(
    (
      await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "control", memberId: "private-member", command: "pause" }),
      })
    ).status,
    200,
  );
  const requests = seen.filter((r) => r.path.startsWith("/v1/sessions/"));
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.token === token));
  assert.ok(requests.every((r) => r.path.startsWith("/v1/sessions/private-session/swarm")));
  assert.equal(new URL(requests[0]!.path, "http://core").searchParams.get("sender"), "public-id");
  assert.equal(JSON.parse(requests[1]!.body).command, "pause");
});
