import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const seen: Array<{ path: string; method?: string; body: string }> = [];
const core = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ path: req.url!, method: req.method, body });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ messages: [], peers: [], candidates: [], recipientIds: [] }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "board-test";
process.env.CORE_SIGNING_SECRET = "board-test-signing-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
test.after(() => {
  surface.close();
  core.close();
});

test("board proxy binds reads and previews to the authenticated viewer", async () => {
  const headers = {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "board-test-signing-secret"),
  };
  for (const path of [
    "/api/peer-messages?principalId=mallory&after=17&text=review",
    "/api/peer-messages/message-id",
    "/api/peers",
    "/api/peers/agent-id/subtree?principalId=mallory",
  ]) {
    const result = await fetch(base + path, { headers });
    assert.equal(result.status, 200);
    const forwarded = new URL(seen.at(-1)!.path, "http://core");
    assert.equal(forwarded.searchParams.get("principalId"), "alice");
    assert.ok(forwarded.pathname.startsWith("/v1/peer"));
    if (path.includes("after=")) assert.equal(forwarded.searchParams.get("after"), "17");
  }
  const preview = await fetch(base + "/api/peer-messages/preview", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ audience: ".[]" }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { audience: ".[]" });
  assert.equal(new URL(seen.at(-1)!.path, "http://core").searchParams.get("principalId"), "alice");
  const control = await fetch(base + "/api/peers/agent-id/lifecycle?principalId=mallory", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "stop", subtree: true }),
  });
  assert.equal(control.status, 200);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { action: "stop", subtree: true });
  assert.equal(new URL(seen.at(-1)!.path, "http://core").searchParams.get("principalId"), "alice");
});
